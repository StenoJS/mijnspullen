'use strict';
// Achtergrondtaken: dagelijkse back-up van de database en meldingen naar Home Assistant.
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 3);
const NOTIFY_HOUR = Number(process.env.NOTIFY_HOUR ?? 8);
const NOTIFY_DAYS = Math.max(0, Number(process.env.NOTIFY_DAYS ?? 7));
const HA_WEBHOOK_URL = process.env.HA_WEBHOOK_URL || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createJobs(db, dataDir) {
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // ---------- back-ups ----------
  function listBackups() {
    return fs.readdirSync(backupDir)
      .filter((f) => /^mijn-spullen-[\d-]+(T[\d-]+)?\.db$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(backupDir, f)); return { name: f, size: st.size, created_at: st.mtime.toISOString() }; })
      .sort((a, b) => b.name.localeCompare(a.name));
  }
  function makeBackup(label) {
    const name = `mijn-spullen-${label || localDay()}.db`;
    const file = path.join(backupDir, name);
    try { fs.unlinkSync(file); } catch { /* bestaat nog niet */ }
    // VACUUM INTO maakt een consistente kopie terwijl de app gewoon doordraait.
    db.prepare('VACUUM INTO ?').run(file);
    for (const old of listBackups().slice(BACKUP_KEEP)) { try { fs.unlinkSync(path.join(backupDir, old.name)); } catch { /* */ } }
    return name;
  }
  function backupFile(name) {
    if (!/^mijn-spullen-[\d-]+(T[\d-]+)?\.db$/.test(name)) return null;
    const file = path.join(backupDir, name);
    return fs.existsSync(file) ? file : null;
  }
  // Verse kopie voor een download (wordt na gebruik weggegooid).
  function snapshot() {
    const file = path.join(backupDir, `.snapshot-${process.pid}-${Date.now()}.db`);
    db.prepare('VACUUM INTO ?').run(file);
    return file;
  }

  // ---------- Home Assistant ----------
  const thingUrl = (t) => (APP_URL ? `${APP_URL}/#/${t.is_container ? 'c' : 't'}/${t.id}` : null);
  function locationOf(id) {
    const rows = db.prepare(`WITH RECURSIVE up(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM things WHERE id = (SELECT parent_id FROM things WHERE id = ?)
        UNION ALL SELECT t.id, t.parent_id, t.name, up.depth + 1 FROM things t JOIN up ON t.id = up.parent_id WHERE up.depth < 50)
      SELECT name FROM up ORDER BY depth DESC`).all(id);
    return rows.map((r) => r.name).join(' › ');
  }
  const describe = (t) => ({ id: t.id, name: t.name, quantity: t.quantity, min_quantity: t.min_quantity, expires_on: t.expires_on, location: locationOf(t.id), url: thingUrl(t) });

  async function sendHa(payload) {
    if (!HA_WEBHOOK_URL) return { ok: false, reason: 'HA_WEBHOOK_URL is niet ingesteld' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(HA_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'mijn-spullen', app_url: APP_URL || null, ...payload }), signal: ctl.signal });
      return { ok: r.ok, status: r.status };
    } catch (e) {
      console.error('Home Assistant-melding mislukt:', e.message);
      return { ok: false, reason: e.message };
    } finally { clearTimeout(timer); }
  }

  // Na elke wijziging van aantal/drempel: melden als iets (opnieuw) onder de drempel zakt.
  function checkLowStock(thingId) {
    const t = db.prepare('SELECT * FROM things WHERE id = ?').get(thingId);
    if (!t || t.is_container) return;
    const low = t.min_quantity != null && t.quantity <= t.min_quantity;
    if (!low) { db.prepare("DELETE FROM notified WHERE thing_id = ? AND kind = 'low'").run(thingId); return; }
    if (db.prepare("SELECT 1 FROM notified WHERE thing_id = ? AND kind = 'low'").get(thingId)) return;
    db.prepare("INSERT INTO notified(thing_id, kind, at) VALUES(?, 'low', ?)").run(thingId, new Date().toISOString());
    const d = describe(t);
    sendHa({ event: 'low_stock', title: 'Bijna op', message: `${t.name} is bijna op (nog ${t.quantity})${d.location ? ` · ${d.location}` : ''}`, items: [d] });
  }
  function expiryChanged(thingId) { db.prepare("DELETE FROM notified WHERE thing_id = ? AND kind = 'expiring'").run(thingId); }

  async function notifyExpiring(force) {
    const rows = db.prepare(`SELECT * FROM things WHERE expires_on IS NOT NULL AND expires_on <= date('now', 'localtime', ?)
      ${force ? '' : "AND id NOT IN (SELECT thing_id FROM notified WHERE kind = 'expiring')"} ORDER BY expires_on LIMIT 50`).all(`+${NOTIFY_DAYS} days`);
    if (!rows.length) return { ok: true, count: 0 };
    const items = rows.map(describe);
    const names = rows.slice(0, 5).map((t) => `${t.name} (${t.expires_on})`).join(', ');
    const r = await sendHa({ event: 'expiring', title: 'Houdbaarheid', message: `${rows.length} ${rows.length === 1 ? 'item verloopt' : 'items verlopen'} binnenkort: ${names}${rows.length > 5 ? ', …' : ''}`, items });
    if (r.ok) {
      const ins = db.prepare("INSERT OR REPLACE INTO notified(thing_id, kind, at) VALUES(?, 'expiring', ?)");
      for (const t of rows) ins.run(t.id, new Date().toISOString());
    }
    return { ...r, count: rows.length };
  }

  function summary() {
    const low = db.prepare('SELECT * FROM things WHERE is_container = 0 AND min_quantity IS NOT NULL AND quantity <= min_quantity ORDER BY name COLLATE NOCASE LIMIT 100').all();
    const expiring = db.prepare("SELECT * FROM things WHERE expires_on IS NOT NULL AND expires_on <= date('now', 'localtime', ?) ORDER BY expires_on LIMIT 100").all(`+${NOTIFY_DAYS} days`);
    const c = db.prepare('SELECT SUM(is_container = 0) items, SUM(is_container = 1) containers FROM things').get();
    return { items: c.items || 0, containers: c.containers || 0, low_count: low.length, expiring_count: expiring.length, expiring_days: NOTIFY_DAYS, low: low.map(describe), expiring: expiring.map(describe) };
  }

  // ---------- planner ----------
  const done = { backup: null, notify: null };
  function tick() {
    const nowD = new Date();
    const day = localDay(nowD);
    try {
      if (done.backup !== day && nowD.getHours() >= BACKUP_HOUR) {
        if (!listBackups().some((b) => b.name === `mijn-spullen-${day}.db`)) makeBackup();
        done.backup = day;
      }
    } catch (e) { console.error('Back-up mislukt:', e.message); }
    if (HA_WEBHOOK_URL && done.notify !== day && nowD.getHours() >= NOTIFY_HOUR) {
      done.notify = day;
      notifyExpiring(false).catch((e) => console.error('Houdbaarheidsmelding mislukt:', e.message));
    }
  }
  function start() {
    setTimeout(tick, 5000).unref();
    setInterval(tick, 10 * 60e3).unref();
  }

  return {
    listBackups, makeBackup, backupFile, snapshot, backupDir,
    sendHa, checkLowStock, expiryChanged, notifyExpiring, summary, start,
    config: { haConfigured: !!HA_WEBHOOK_URL, appUrl: APP_URL || null, notifyDays: NOTIFY_DAYS, notifyHour: NOTIFY_HOUR, backupHour: BACKUP_HOUR, backupKeep: BACKUP_KEEP },
  };
}

module.exports = { createJobs };
