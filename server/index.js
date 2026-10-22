'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx } = require('./db');
const auth = require('./auth');
const { parseCsv, rowsToRecords } = require('./csv');
const { lookupBarcode, fetchImage } = require('./lookup');
const { writeTar } = require('./tar');
const { createJobs } = require('./jobs');
const ai = require('./ai');
const { createLego } = require('./lego');
const boxes = require('./boxes');
const fms = require('./fms');

const VERSION = require('../package.json').version;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_JSON = 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES_PER_THING = 10;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const db = openDb(DATA_DIR);
const lego = createLego(DATA_DIR);
// Lego-database alvast op de achtergrond laden (en in de log laten zien of dat lukt).
if (require.main === module) setTimeout(() => lego.load().then(() => console.log(`Lego-database geladen (${lego.size()} sets)`)).catch((e) => console.warn(e.message)), 15000).unref();
ai.init((key) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; });
const IMG_DIR = path.join(DATA_DIR, 'images');
const jobs = createJobs(db, DATA_DIR);

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m) => new HttpError(400, m);
const now = () => new Date().toISOString();
const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad('Ongeldig getal');
  return n;
};
const dateOrNull = (v) => {
  if (v === '' || v == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad('Datum moet JJJJ-MM-DD zijn');
  return String(v);
};
const bool = (v) => (v ? 1 : 0);
const num = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Bestand te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = MAX_JSON) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Ongeldige JSON'); }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

// ---------- live updates (SSE) ----------
const sseClients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) c.write(data);
}
setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 25000).unref();

function logActivity(user, thingId, action, summary) {
  db.prepare('INSERT INTO activity(user_id,thing_id,action,summary,at) VALUES(?,?,?,?,?)')
    .run(user ? user.id : null, thingId ?? null, action, summary, now());
  db.exec("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 5000)");
}
function changed(user, kind, id, req) { broadcast({ type: 'changed', kind, id: id ?? null, by: user ? user.id : null, src: (req && req.headers['x-client-id']) || null }); }

// ---------- things ----------
function allNames() {
  const map = new Map();
  for (const r of db.prepare('SELECT id, parent_id, name, is_container FROM things').all()) map.set(r.id, r);
  return map;
}
function pathOf(map, id) {
  const out = [];
  let cur = map.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? map.get(cur.parent_id) : null;
  }
  return out;
}
function descendantIds(id) {
  return db.prepare(`
    WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM things t JOIN d ON t.parent_id = d.id)
    SELECT id FROM d`).all(id).map((r) => r.id);
}
function tagDescendants(id) {
  return db.prepare(`
    WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id)
    SELECT id FROM d`).all(id).map((r) => r.id);
}

function decorate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const tags = new Map(), imgs = new Map(), kids = new Map();
  for (const r of db.prepare(`SELECT thing_id, tag_id FROM thing_tags WHERE thing_id IN (${ph})`).all(...ids)) {
    (tags.get(r.thing_id) || tags.set(r.thing_id, []).get(r.thing_id)).push(r.tag_id);
  }
  for (const r of db.prepare(`SELECT id, thing_id FROM images WHERE thing_id IN (${ph}) ORDER BY position, id`).all(...ids)) {
    (imgs.get(r.thing_id) || imgs.set(r.thing_id, []).get(r.thing_id)).push(r.id);
  }
  for (const r of db.prepare(`SELECT parent_id, COUNT(*) c FROM things WHERE parent_id IN (${ph}) GROUP BY parent_id`).all(...ids)) {
    kids.set(r.parent_id, r.c);
  }
  return rows.map((r) => ({
    ...r,
    is_container: !!r.is_container,
    favourite: !!r.favourite,
    tag_ids: tags.get(r.id) || [],
    image_ids: imgs.get(r.id) || [],
    cover_image_id: (imgs.get(r.id) || [])[0] || null,
    child_count: kids.get(r.id) || 0,
  }));
}

function listThings(q) {
  const where = [], args = [];
  if (q.parent === 'root') where.push('t.parent_id IS NULL');
  else if (q.parent) { where.push('t.parent_id = ?'); args.push(Number(q.parent)); }
  if (q.scope) {
    const ids = descendantIds(Number(q.scope)).filter((i) => i !== Number(q.scope));
    if (!ids.length) return [];
    where.push(`t.id IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
  }
  if (q.q) {
    for (const w of String(q.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push(`(lower(t.name) LIKE ? OR lower(t.description) LIKE ? OR lower(t.notes) LIKE ? OR t.barcode LIKE ?
        OR EXISTS (SELECT 1 FROM thing_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.thing_id = t.id AND lower(g.name) LIKE ?))`);
      const like = `%${w.replace(/[%_]/g, '')}%`;
      args.push(like, like, like, like, like);
    }
  }
  if (q.barcode) { where.push('t.barcode = ?'); args.push(String(q.barcode)); }
  if (q.nfc) { where.push('t.nfc_id = ?'); args.push(String(q.nfc).toLowerCase()); }
  if (q.tag) {
    const ids = tagDescendants(Number(q.tag));
    where.push(`EXISTS (SELECT 1 FROM thing_tags tt WHERE tt.thing_id = t.id AND tt.tag_id IN (${ids.map(() => '?').join(',')}))`);
    args.push(...ids);
  }
  if (q.low === '1') where.push('t.is_container = 0 AND t.min_quantity IS NOT NULL AND t.quantity <= t.min_quantity');
  if (q.expiring) {
    const days = Math.max(0, Math.min(3650, Number(q.expiring) || 0));
    where.push("t.expires_on IS NOT NULL AND t.expires_on <= date('now', ?)"); args.push(`+${days} days`);
  }
  if (q.favourite === '1') where.push('t.favourite = 1');
  if (q.lent === '1') where.push('t.lent_to IS NOT NULL');
  if (q.shopping === '1') where.push('t.is_container = 0 AND (t.on_list = 1 OR (t.min_quantity IS NOT NULL AND t.quantity <= t.min_quantity))');
  const sorts = {
    name: 't.is_container DESC, t.name COLLATE NOCASE',
    updated: 't.updated_at DESC',
    created: 't.created_at DESC',
    quantity: 't.quantity ASC, t.name COLLATE NOCASE',
    expires: "t.expires_on IS NULL, t.expires_on ASC",
  };
  const order = sorts[q.sort] || sorts.name;
  const limit = Math.max(1, Math.min(500, Number(q.limit) || 200));
  const rows = db.prepare(`SELECT t.* FROM things t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`).all(...args);
  const names = allNames();
  return decorate(rows).map((r) => ({ ...r, path: pathOf(names, r.id).slice(0, -1) }));
}

function getThing(id) {
  const row = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Niet gevonden');
  const [t] = decorate([row]);
  const names = allNames();
  t.path = pathOf(names, id).slice(0, -1);
  t.images = db.prepare('SELECT id, mime, has_thumb FROM images WHERE thing_id = ? ORDER BY position, id').all(id);
  t.created_by_name = userName(row.created_by);
  t.updated_by_name = userName(row.updated_by);
  return t;
}
function userName(id) {
  if (!id) return null;
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(id);
  return u ? u.display_name : null;
}

function validateThingInput(b, partial) {
  const out = {};
  if (!partial || 'name' in b) {
    out.name = str(b.name, 200);
    if (!out.name) throw bad('Naam is verplicht');
  }
  if ('description' in b) out.description = str(b.description, 2000);
  if ('notes' in b) out.notes = str(b.notes, 10000);
  if ('quantity' in b) { out.quantity = numOrNull(b.quantity); if (out.quantity == null || out.quantity < 0) throw bad('Aantal moet 0 of hoger zijn'); }
  if ('min_quantity' in b) out.min_quantity = numOrNull(b.min_quantity);
  if ('barcode' in b) out.barcode = str(b.barcode, 100) || null;
  if ('nfc_id' in b) out.nfc_id = str(b.nfc_id, 100).toLowerCase() || null;
  if ('lent_to' in b) out.lent_to = str(b.lent_to, 100) || null;
  if ('lent_due' in b) out.lent_due = dateOrNull(b.lent_due);
  if ('on_list' in b) out.on_list = bool(b.on_list);
  if ('price' in b) out.price = numOrNull(b.price);
  if ('expires_on' in b) out.expires_on = dateOrNull(b.expires_on);
  if ('favourite' in b) out.favourite = bool(b.favourite);
  if ('is_container' in b) out.is_container = bool(b.is_container);
  if ('parent_id' in b) {
    out.parent_id = b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id);
    if (out.parent_id != null && !db.prepare('SELECT 1 FROM things WHERE id = ?').get(out.parent_id)) throw bad('Bovenliggende locatie bestaat niet');
  }
  if ('tag_ids' in b) {
    if (!Array.isArray(b.tag_ids)) throw bad('tag_ids moet een lijst zijn');
    out.tag_ids = [...new Set(b.tag_ids.map(Number).filter(Number.isInteger))];
  }
  return out;
}
function setTags(thingId, tagIds) {
  db.prepare('DELETE FROM thing_tags WHERE thing_id = ?').run(thingId);
  const ins = db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?,?)');
  for (const t of tagIds) if (db.prepare('SELECT 1 FROM tags WHERE id = ?').get(t)) ins.run(thingId, t);
}

// Een NFC-tag hoort bij precies één ding: bij opnieuw koppelen verdwijnt de oude koppeling.
function releaseNfc(nfcId, keepId) { db.prepare('UPDATE things SET nfc_id = NULL WHERE nfc_id = ? AND id != ?').run(nfcId, keepId); }

function createThing(user, b) {
  const v = validateThingInput(b, false);
  return tx(db, () => {
    const t = now();
    const r = db.prepare(`INSERT INTO things(parent_id,is_container,name,description,notes,quantity,min_quantity,barcode,nfc_id,price,expires_on,favourite,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.parent_id ?? null, v.is_container ?? 0, v.name, v.description ?? '', v.notes ?? '', v.quantity ?? 1,
      v.min_quantity ?? null, v.barcode ?? null, v.nfc_id ?? null, v.price ?? null, v.expires_on ?? null, v.favourite ?? 0,
      user.id, user.id, t, t);
    const id = Number(r.lastInsertRowid);
    if (v.nfc_id) releaseNfc(v.nfc_id, id);
    if (v.tag_ids) setTags(id, v.tag_ids);
    logActivity(user, id, 'create', `${user.display_name} voegde "${v.name}" toe`);
    return id;
  });
}

function updateThing(user, id, b) {
  const cur = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Niet gevonden');
  if (b.version != null && Number(b.version) !== cur.version) {
    throw new HttpError(409, 'Iemand anders heeft dit item net gewijzigd', { current: getThing(id) });
  }
  const v = validateThingInput(b, true);
  if ('parent_id' in v && v.parent_id != null) {
    if (descendantIds(id).includes(v.parent_id)) throw bad('Je kunt een item niet in zichzelf of een onderliggend item plaatsen');
  }
  tx(db, () => {
    // Uitlenen: datum vastleggen zodra iemand het krijgt; alles leeg bij terugbrengen.
    if ('lent_to' in v) {
      if (!v.lent_to) { v.lent_at = null; v.lent_due = null; }
      else if (v.lent_to !== cur.lent_to) v.lent_at = now();
    }
    const fields = ['parent_id', 'is_container', 'name', 'description', 'notes', 'quantity', 'min_quantity', 'barcode', 'nfc_id', 'price', 'expires_on', 'favourite', 'lent_to', 'lent_at', 'lent_due', 'on_list'];
    const sets = [], args = [];
    for (const f of fields) if (f in v) { sets.push(`${f} = ?`); args.push(v[f]); }
    sets.push('version = version + 1', 'updated_by = ?', 'updated_at = ?');
    args.push(user.id, now(), id);
    db.prepare(`UPDATE things SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (v.nfc_id) releaseNfc(v.nfc_id, id);
    if (v.tag_ids) setTags(id, v.tag_ids);
    const moved = 'parent_id' in v && v.parent_id !== cur.parent_id;
    const lent = 'lent_to' in v && v.lent_to !== cur.lent_to;
    if (lent) logActivity(user, id, 'lend', v.lent_to ? `${user.display_name} leende "${v.name || cur.name}" uit aan ${v.lent_to}` : `"${v.name || cur.name}" is terug (was uitgeleend aan ${cur.lent_to})`);
    else logActivity(user, id, moved ? 'move' : 'update', `${user.display_name} ${moved ? 'verplaatste' : 'wijzigde'} "${v.name || cur.name}"`);
  });
  if ('expires_on' in v && v.expires_on !== cur.expires_on) jobs.expiryChanged(id);
  if (('lent_to' in v && v.lent_to !== cur.lent_to) || ('lent_due' in v && v.lent_due !== cur.lent_due)) jobs.lendingChanged(id);
}

function deleteImageFiles(rows) {
  for (const r of rows) {
    for (const suffix of ['', '.thumb']) {
      try { fs.unlinkSync(path.join(IMG_DIR, `${r.id}${suffix}.${r.ext}`)); } catch { /* al weg */ }
    }
  }
}
// Verwijderen = naar de prullenbak: de hele (sub)boom als momentopname bewaren, 30 dagen herstelbaar.
const TRASH_DIR = path.join(IMG_DIR, 'trash');
fs.mkdirSync(TRASH_DIR, { recursive: true });
const TRASH_DAYS = Math.max(1, Number(process.env.TRASH_DAYS || 30));
const inList = (ids) => ids.map(() => '?').join(',');
function deleteThing(user, id) {
  const cur = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Niet gevonden');
  const ids = descendantIds(id);
  const things = db.prepare(`SELECT * FROM things WHERE id IN (${inList(ids)})`).all(...ids);
  const order = new Map(ids.map((x, i) => [x, i]));
  things.sort((a, b) => order.get(a.id) - order.get(b.id)); // ouders vóór kinderen
  const tags = db.prepare(`SELECT * FROM thing_tags WHERE thing_id IN (${inList(ids)})`).all(...ids);
  const imgs = db.prepare(`SELECT * FROM images WHERE thing_id IN (${inList(ids)})`).all(...ids);
  let trashId;
  tx(db, () => {
    trashId = Number(db.prepare('INSERT INTO trash(thing_id,name,is_container,item_count,parent_id,payload,deleted_by,deleted_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, cur.name, cur.is_container, ids.length, cur.parent_id, JSON.stringify({ things, tags, images: imgs }), user.id, now()).lastInsertRowid);
    db.prepare('DELETE FROM things WHERE id = ?').run(id); // cascade naar kinderen, tags, afbeeldingen
    logActivity(user, null, 'delete', `${user.display_name} verwijderde "${cur.name}"${ids.length > 1 ? ` en ${ids.length - 1} onderliggende items` : ''}`);
  });
  for (const im of imgs) for (const suffix of ['', '.thumb']) {
    try { fs.renameSync(path.join(IMG_DIR, `${im.id}${suffix}.${im.ext}`), path.join(TRASH_DIR, `${im.id}${suffix}.${im.ext}`)); } catch { /* */ }
  }
  return trashId;
}
function trashImageFiles(payload) {
  for (const im of payload.images || []) for (const suffix of ['', '.thumb']) { try { fs.unlinkSync(path.join(TRASH_DIR, `${im.id}${suffix}.${im.ext}`)); } catch { /* */ } }
}
function restoreTrash(user, trashId) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId);
  if (!row) throw new HttpError(404, 'Niet (meer) in de prullenbak');
  const p = JSON.parse(row.payload);
  const idMap = new Map(), imgMoves = [];
  let rootId;
  tx(db, () => {
    const free = (table, idv) => !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(idv);
    for (const t of p.things) {
      let parent = t.parent_id;
      if (idMap.has(parent)) parent = idMap.get(parent);
      else if (parent != null && free('things', parent)) parent = null; // oude plek bestaat niet meer: hoofdniveau
      const cols = Object.keys(t).filter((k) => k !== 'id' && k !== 'parent_id');
      const useId = free('things', t.id);
      const r = db.prepare(`INSERT INTO things(${useId ? 'id,' : ''}parent_id,${cols.join(',')}) VALUES(${useId ? '?,' : ''}?,${cols.map(() => '?').join(',')})`)
        .run(...(useId ? [t.id] : []), parent, ...cols.map((k) => t[k]));
      idMap.set(t.id, useId ? t.id : Number(r.lastInsertRowid));
    }
    rootId = idMap.get(row.thing_id);
    for (const tt of p.tags) if (db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tt.tag_id)) db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?, ?)').run(idMap.get(tt.thing_id), tt.tag_id);
    for (const im of p.images) {
      const useId = free('images', im.id);
      const r = db.prepare(`INSERT INTO images(${useId ? 'id,' : ''}thing_id,mime,ext,has_thumb,position,created_by,created_at) VALUES(${useId ? '?,' : ''}?,?,?,?,?,?,?)`)
        .run(...(useId ? [im.id] : []), idMap.get(im.thing_id), im.mime, im.ext, im.has_thumb, im.position, im.created_by, im.created_at);
      imgMoves.push([im, useId ? im.id : Number(r.lastInsertRowid)]);
    }
    db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
    logActivity(user, rootId, 'restore', `${user.display_name} zette "${row.name}" terug uit de prullenbak`);
  });
  for (const [im, nid] of imgMoves) for (const suffix of ['', '.thumb']) {
    try { fs.renameSync(path.join(TRASH_DIR, `${im.id}${suffix}.${im.ext}`), path.join(IMG_DIR, `${nid}${suffix}.${im.ext}`)); } catch { /* */ }
  }
  return rootId;
}
function purgeTrash(olderThanDays) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400e3).toISOString();
  const rows = db.prepare('SELECT id, payload FROM trash WHERE deleted_at < ?').all(cutoff);
  for (const r of rows) { trashImageFiles(JSON.parse(r.payload)); db.prepare('DELETE FROM trash WHERE id = ?').run(r.id); }
  return rows.length;
}
setInterval(() => { try { purgeTrash(TRASH_DAYS); } catch (e) { console.error('Prullenbak opruimen mislukt:', e.message); } }, 6 * 3600e3).unref();

// ---------- router ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, opts, handler });
}
const PUBLIC = { auth: false };
const USER = { auth: true };
const ADMIN = { auth: true, admin: true };

route('GET', '/api/health', PUBLIC, () => ({ ok: true, version: VERSION }));
route('GET', '/api/setup-status', PUBLIC, () => ({ needsSetup: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0, version: VERSION }));

route('POST', '/api/setup', PUBLIC, async ({ req, res }) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) throw new HttpError(403, 'Installatie is al afgerond');
  const b = await readJson(req);
  const user = createUser(b, 'admin');
  return startSession(res, user.id, user);
});

function createUser(b, role) {
  const username = str(b.username, 50).toLowerCase();
  if (!/^[a-z0-9._-]{2,50}$/.test(username)) throw bad('Gebruikersnaam: 2-50 tekens (letters, cijfers, . _ -)');
  const password = String(b.password || '');
  if (password.length < 8) throw bad('Wachtwoord moet minimaal 8 tekens zijn');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Gebruikersnaam bestaat al');
  const display = str(b.display_name, 80) || username;
  const r = db.prepare('INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(username, display, auth.hashPassword(password), role, now());
  return { id: Number(r.lastInsertRowid), username, display_name: display, role };
}
function startSession(res, userId, user) {
  const s = auth.createSession(db, userId);
  res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.expires, COOKIE_SECURE));
  return { user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } };
}

route('POST', '/api/login', PUBLIC, async ({ req, res }) => {
  const b = await readJson(req);
  const username = str(b.username, 50).toLowerCase();
  const key = `${clientIp(req)}|${username}`;
  if (!auth.loginAllowed(key)) throw new HttpError(429, 'Te veel pogingen. Probeer het over 15 minuten opnieuw.');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = u && !u.disabled && auth.verifyPassword(String(b.password || ''), u.password_hash);
  if (!ok) { auth.loginFailed(key); throw new HttpError(401, 'Onjuiste gebruikersnaam of wachtwoord'); }
  auth.loginOk(key);
  return startSession(res, u.id, u);
});
route('POST', '/api/logout', USER, ({ res, user }) => {
  auth.destroySession(db, user._token);
  res.setHeader('Set-Cookie', auth.clearCookie(COOKIE_SECURE));
  return { ok: true };
});
route('GET', '/api/me', USER, ({ user }) => ({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }, version: VERSION, ai: ai.configured() }));
route('POST', '/api/me/password', USER, async ({ req, user }) => {
  if (user._viaToken) throw new HttpError(403, 'Niet beschikbaar met een API-token');
  const b = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!auth.verifyPassword(String(b.current || ''), u.password_hash)) throw new HttpError(403, 'Huidig wachtwoord klopt niet');
  if (String(b.password || '').length < 8) throw bad('Wachtwoord moet minimaal 8 tekens zijn');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(b.password)), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, require('node:crypto').createHash('sha256').update(user._token).digest('hex'));
  return { ok: true };
});

// gebruikers (admin)
route('GET', '/api/users', USER, () => db.prepare('SELECT id, username, display_name, role, disabled, created_at FROM users ORDER BY id').all().map((u) => ({ ...u, disabled: !!u.disabled })));
route('POST', '/api/users', ADMIN, async ({ req }) => ({ user: createUser(await readJson(req), 'member') }));
route('PATCH', '/api/users/:id', ADMIN, async ({ req, params, user }) => {
  const id = Number(params.id);
  const b = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Gebruiker niet gevonden');
  if (id === user.id && (b.disabled || (b.role && b.role !== 'admin'))) throw bad('Je kunt jezelf niet blokkeren of degraderen');
  tx(db, () => {
    if ('display_name' in b) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(str(b.display_name, 80) || u.username, id);
    if (b.role) { if (!['admin', 'member'].includes(b.role)) throw bad('Ongeldige rol'); db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id); }
    if ('disabled' in b) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(bool(b.disabled), id);
      if (b.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (b.password) {
      if (String(b.password).length < 8) throw bad('Wachtwoord moet minimaal 8 tekens zijn');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(b.password)), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  });
  return { ok: true };
});

// spullen
route('GET', '/api/things', USER, ({ query }) => ({ things: listThings(query) }));
route('GET', '/api/tree', USER, () => ({ nodes: db.prepare('SELECT id, parent_id, name, is_container FROM things ORDER BY name COLLATE NOCASE').all().map((r) => ({ ...r, is_container: !!r.is_container })) }));
route('GET', '/api/things/:id', USER, ({ params }) => ({ thing: getThing(Number(params.id)) }));
route('POST', '/api/things', USER, async ({ req, user }) => {
  const id = createThing(user, await readJson(req));
  changed(user, 'thing', id, req);
  jobs.checkLowStock(id);
  return { thing: getThing(id) };
});
route('PATCH', '/api/things/:id', USER, async ({ req, params, user }) => {
  const id = Number(params.id);
  updateThing(user, id, await readJson(req));
  changed(user, 'thing', id, req);
  jobs.checkLowStock(id);
  return { thing: getThing(id) };
});
route('POST', '/api/things/:id/adjust', USER, async ({ req, params, user }) => {
  const id = Number(params.id);
  const delta = numOrNull((await readJson(req)).delta);
  if (!delta) throw bad('delta ontbreekt');
  const cur = db.prepare('SELECT name, quantity FROM things WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Niet gevonden');
  const nq = Math.max(0, cur.quantity + delta);
  tx(db, () => {
    db.prepare('UPDATE things SET quantity = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(nq, user.id, now(), id);
    logActivity(user, id, 'quantity', `${user.display_name} zette "${cur.name}" van ${cur.quantity} naar ${nq}`);
  });
  changed(user, 'thing', id, req);
  jobs.checkLowStock(id);
  return { thing: getThing(id) };
});
route('DELETE', '/api/things/:id', USER, ({ req, params, user }) => {
  const trash_id = deleteThing(user, Number(params.id));
  changed(user, 'thing', null, req);
  return { ok: true, trash_id };
});

// tags
route('GET', '/api/tags', USER, () => ({
  tags: db.prepare(`SELECT g.id, g.parent_id, g.name, g.color, (SELECT COUNT(*) FROM thing_tags tt WHERE tt.tag_id = g.id) AS use_count FROM tags g ORDER BY g.name COLLATE NOCASE`).all(),
}));
function tagInput(b, partial) {
  const o = {};
  if (!partial || 'name' in b) { o.name = str(b.name, 60); if (!o.name) throw bad('Naam is verplicht'); }
  if ('color' in b) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw bad('Kleur moet #RRGGBB zijn'); o.color = String(b.color).toLowerCase(); }
  if ('parent_id' in b) o.parent_id = b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id);
  return o;
}
route('POST', '/api/tags', USER, async ({ req, user }) => {
  const v = tagInput(await readJson(req), false);
  const r = db.prepare('INSERT INTO tags(parent_id,name,color) VALUES(?,?,?)').run(v.parent_id ?? null, v.name, v.color ?? '#64748b');
  changed(user, 'tag', Number(r.lastInsertRowid), req);
  return { id: Number(r.lastInsertRowid) };
});
route('PATCH', '/api/tags/:id', USER, async ({ req, params, user }) => {
  const id = Number(params.id);
  const v = tagInput(await readJson(req), true);
  if ('parent_id' in v && v.parent_id != null && tagDescendants(id).includes(v.parent_id)) throw bad('Een tag kan niet onder zichzelf of een eigen subtag vallen');
  const sets = [], args = [];
  for (const f of ['name', 'color', 'parent_id']) if (f in v) { sets.push(`${f} = ?`); args.push(v[f]); }
  if (sets.length) db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  changed(user, 'tag', id, req);
  return { ok: true };
});
route('DELETE', '/api/tags/:id', USER, ({ req, params, user }) => {
  db.prepare('DELETE FROM tags WHERE id = ?').run(Number(params.id));
  changed(user, 'tag', null, req);
  return { ok: true };
});

// afbeeldingen
route('POST', '/api/things/:id/images', USER, async ({ req, params, user }) => {
  const thingId = Number(params.id);
  if (!db.prepare('SELECT 1 FROM things WHERE id = ?').get(thingId)) throw new HttpError(404, 'Niet gevonden');
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_TYPES[mime];
  if (!ext) throw new HttpError(415, 'Alleen JPEG, PNG of WebP');
  if (db.prepare('SELECT COUNT(*) c FROM images WHERE thing_id = ?').get(thingId).c >= MAX_IMAGES_PER_THING) throw bad(`Maximaal ${MAX_IMAGES_PER_THING} foto's per item`);
  const buf = await readBody(req, MAX_IMAGE);
  if (!buf.length) throw bad('Leeg bestand');
  return { image: storeImage(user, thingId, buf, mime, req) };
});
function storeImage(user, thingId, buf, mime, req) {
  const ext = IMAGE_TYPES[mime];
  const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM images WHERE thing_id = ?').get(thingId).p;
  const r = db.prepare('INSERT INTO images(thing_id,mime,ext,position,created_by,created_at) VALUES(?,?,?,?,?,?)').run(thingId, mime, ext, pos, user.id, now());
  const id = Number(r.lastInsertRowid);
  fs.writeFileSync(path.join(IMG_DIR, `${id}.${ext}`), buf);
  db.prepare('UPDATE things SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(user.id, now(), thingId);
  changed(user, 'thing', thingId, req);
  return { id, mime, has_thumb: 0 };
}
// ---------- Lego-sets (Rebrickable-database) ----------
const LEGO_NAME = /^\s*(?:lego\s*)?#?\s*(\d{4,7}(?:-\d{1,2})?)\s*$/i; // 4+ cijfers: doosnummers (101) zijn geen sets
const legoLookup = async (code) => { try { return await lego.lookup(code); } catch (e) { throw new HttpError(502, e.message); } };
route('GET', '/api/lego/:code', USER, async ({ params }) => {
  const set = await legoLookup(params.code);
  if (!set) throw new HttpError(404, `Geen Lego-set ${params.code} gevonden`);
  return { set };
});
// Bestaande spullen met alleen een setnummer als naam (bijv. "31077" of "Lego 60050").
route('GET', '/api/lego-candidates', USER, async () => {
  const rows = db.prepare('SELECT * FROM things ORDER BY name COLLATE NOCASE').all().filter((t) => LEGO_NAME.test(t.name));
  const map = allNames();
  const out = [];
  for (const t of rows) {
    const set = await legoLookup(t.name.match(LEGO_NAME)[1]);
    out.push({ id: t.id, name: t.name, is_container: !!t.is_container, path: pathOf(map, t.id).slice(0, -1), has_image: !!db.prepare('SELECT 1 FROM images WHERE thing_id = ?').get(t.id), set });
  }
  return { candidates: out };
});
function legoTagId() {
  const t = db.prepare("SELECT id FROM tags WHERE lower(name) = 'lego'").get();
  return t ? t.id : Number(db.prepare("INSERT INTO tags(name, color) VALUES('Lego', '#e53935')").run().lastInsertRowid);
}
route('POST', '/api/lego-apply', USER, async ({ req, user }) => {
  const b = await readJson(req);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500);
  const tag = legoTagId();
  let updated = 0, photos = 0;
  for (const id of ids) {
    const t = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
    const m = t && t.name.match(LEGO_NAME);
    if (!m) continue;
    const set = await legoLookup(m[1]);
    if (!set) continue;
    db.prepare('UPDATE things SET name = ?, description = CASE WHEN description = \'\' THEN ? ELSE description END, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(`${set.number} ${set.name}`.slice(0, 200), set.description, user.id, now(), id);
    db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?, ?)').run(id, tag);
    updated++;
    if (set.image_url && !db.prepare('SELECT 1 FROM images WHERE thing_id = ?').get(id)) {
      const img = await fetchImage(set.image_url, MAX_IMAGE);
      if (img) { storeImage(user, id, img.buf, img.mime, req); photos++; }
    }
  }
  if (updated) logActivity(user, null, 'lego', `${user.display_name} vulde ${updated} Lego-sets aan uit Rebrickable`);
  changed(user, 'thing', null, req);
  return { updated, photos, tag_id: tag };
});
// Foto van een open doos/la: container + lijst met wat erin zit (nog niets opgeslagen).
route('POST', '/api/ai/contents', USER, async ({ req }) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!IMAGE_TYPES[mime]) throw new HttpError(415, 'Alleen JPEG, PNG of WebP');
  const buf = await readBody(req, MAX_IMAGE);
  if (!buf.length) throw bad('Leeg bestand');
  try { return await ai.recognizeContents(buf, mime); } catch (e) { throw new HttpError(e.busy ? 503 : 502, e.message); }
});
route('GET', '/api/integrations/ai', ADMIN, () => ai.info());
route('PUT', '/api/integrations/ai', ADMIN, async ({ req, user }) => {
  const b = await readJson(req);
  const set = (k, v) => (v ? db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(k, v) : db.prepare('DELETE FROM meta WHERE key = ?').run(k));
  if ('token' in b) set('ha_token', str(b.token, 1000).replace(/^Bearer\s+/i, ''));
  if ('entity' in b) {
    const e = str(b.entity, 200);
    if (e && !/^ai_task\.[a-z0-9_]+(\s*,\s*ai_task\.[a-z0-9_]+)*$/.test(e)) throw bad('Gebruik ai_task.… (meerdere mag, met komma\'s)');
    set('ha_ai_entity', e);
  }
  logActivity(user, null, 'settings', `${user.display_name} wijzigde de instellingen voor fotoherkenning`);
  return ai.info();
});
route('POST', '/api/integrations/ai/test', ADMIN, async () => {
  try { return { ok: true, ...(await ai.check()) }; } catch (e) { throw new HttpError(502, e.message); }
});
// Fotoherkenning (AI via Home Assistant): een nieuwe foto in de body, of ?image_id= van een opgeslagen foto.
route('POST', '/api/ai/recognize', USER, async ({ req, query }) => {
  let buf, mime;
  const imageId = Number(query.image_id);
  if (imageId) {
    const im = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId);
    if (!im) throw new HttpError(404, 'Foto niet gevonden');
    buf = fs.readFileSync(path.join(IMG_DIR, `${im.id}.${im.ext}`)); mime = im.mime;
  } else {
    mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMAGE_TYPES[mime]) throw new HttpError(415, 'Alleen JPEG, PNG of WebP');
    buf = await readBody(req, MAX_IMAGE);
    if (!buf.length) throw bad('Leeg bestand');
  }
  const tags = db.prepare('SELECT id, name FROM tags').all();
  let r;
  try { r = await ai.recognize(buf, mime, tags.map((t) => t.name)); } catch (e) { throw new HttpError(e.busy ? 503 : 502, e.message); }
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  return { suggestion: { ...r, tag_ids: r.tags.map((n) => byName.get(n.toLowerCase())).filter(Boolean), new_tags: r.tags.filter((n) => !byName.has(n.toLowerCase())) } };
});
// Productfoto overnemen uit Open Food Facts (alleen die hosts; de server haalt hem op).
route('POST', '/api/things/:id/images/import', USER, async ({ req, params, user }) => {
  const thingId = Number(params.id);
  if (!db.prepare('SELECT 1 FROM things WHERE id = ?').get(thingId)) throw new HttpError(404, 'Niet gevonden');
  if (db.prepare('SELECT COUNT(*) c FROM images WHERE thing_id = ?').get(thingId).c >= MAX_IMAGES_PER_THING) throw bad(`Maximaal ${MAX_IMAGES_PER_THING} foto's per item`);
  const img = await fetchImage(String((await readJson(req)).url || ''), MAX_IMAGE);
  if (!img) throw bad('Kon de productfoto niet ophalen');
  return { image: storeImage(user, thingId, img.buf, img.mime, req) };
});
route('GET', '/api/lookup/:code', USER, async ({ params }) => ({ product: await lookupBarcode(params.code) }));
route('PUT', '/api/images/:id/thumb', USER, async ({ req, params }) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(Number(params.id));
  if (!img) throw new HttpError(404, 'Niet gevonden');
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) throw bad('Leeg bestand');
  fs.writeFileSync(path.join(IMG_DIR, `${img.id}.thumb.${img.ext}`), buf);
  db.prepare('UPDATE images SET has_thumb = 1 WHERE id = ?').run(img.id);
  return { ok: true };
});
// Foto's zonder thumbnail (na een import): de browser maakt ze en stuurt ze terug via PUT /api/images/:id/thumb.
route('GET', '/api/images-without-thumb', USER, () => ({ ids: db.prepare('SELECT id FROM images WHERE has_thumb = 0 ORDER BY id LIMIT 2000').all().map((r) => r.id) }));
route('GET', '/api/images/:id', USER, ({ params, query, res }) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(Number(params.id));
  if (!img) throw new HttpError(404, 'Niet gevonden');
  const useThumb = query.thumb === '1' && img.has_thumb;
  const file = path.join(IMG_DIR, `${img.id}${useThumb ? '.thumb' : ''}.${img.ext}`);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Bestand ontbreekt');
  res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
  return res;
});
route('DELETE', '/api/images/:id', USER, ({ req, params, user }) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(Number(params.id));
  if (!img) throw new HttpError(404, 'Niet gevonden');
  db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
  deleteImageFiles([img]);
  db.prepare('UPDATE things SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(user.id, now(), img.thing_id);
  changed(user, 'thing', img.thing_id, req);
  return { ok: true };
});

// overzicht, activiteit, export
route('GET', '/api/stats', USER, () => {
  const s = db.prepare(`SELECT
    SUM(is_container = 0) AS items,
    SUM(is_container = 1) AS containers,
    COALESCE(SUM(CASE WHEN is_container = 0 THEN quantity END), 0) AS total_quantity,
    COALESCE(SUM(CASE WHEN is_container = 0 AND price IS NOT NULL THEN price * quantity END), 0) AS total_value,
    SUM(is_container = 0 AND min_quantity IS NOT NULL AND quantity <= min_quantity) AS low,
    SUM(expires_on IS NOT NULL AND expires_on <= date('now', '+30 days')) AS expiring,
    SUM(lent_to IS NOT NULL) AS lent,
    SUM(is_container = 0 AND (on_list = 1 OR (min_quantity IS NOT NULL AND quantity <= min_quantity))) AS shopping
    FROM things`).get();
  return { stats: { items: s.items || 0, containers: s.containers || 0, total_quantity: s.total_quantity, total_value: s.total_value, low: s.low || 0, expiring: s.expiring || 0, lent: s.lent || 0, shopping: s.shopping || 0 } };
});
route('GET', '/api/activity', USER, ({ query }) => ({
  activity: db.prepare('SELECT a.id, a.action, a.summary, a.at, a.thing_id, u.display_name AS user FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(query.limit) || 30))),
}));
route('GET', '/api/events', USER, ({ req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  return res;
});

const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // CSV-injectie voorkomen
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
route('GET', '/api/export.csv', USER, ({ res }) => {
  const names = allNames();
  const tagNames = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.id, t.name]));
  const tt = new Map();
  for (const r of db.prepare('SELECT thing_id, tag_id FROM thing_tags').all()) (tt.get(r.thing_id) || tt.set(r.thing_id, []).get(r.thing_id)).push(tagNames.get(r.tag_id));
  const head = ['id', 'type', 'naam', 'locatie', 'aantal', 'minimum', 'barcode', 'prijs', 'houdbaar_tot', 'tags', 'omschrijving', 'notities'];
  const lines = [head.join(',')];
  for (const t of db.prepare('SELECT * FROM things ORDER BY id').all()) {
    const loc = pathOf(names, t.id).slice(0, -1).map((p) => p.name).join(' > ');
    lines.push([t.id, t.is_container ? 'container' : 'item', t.name, loc, t.quantity, t.min_quantity, t.barcode, t.price, t.expires_on, (tt.get(t.id) || []).join('|'), t.description, t.notes].map(csvCell).join(','));
  }
  const body = Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mijn-spullen-${new Date().toISOString().slice(0, 10)}.csv"`, 'Content-Length': body.length });
  res.end(body);
  return res;
});

// ---------- prullenbak ----------
route('GET', '/api/trash', USER, () => ({
  days: TRASH_DAYS,
  items: db.prepare('SELECT t.id, t.thing_id, t.name, t.is_container, t.item_count, t.deleted_at, u.display_name AS deleted_by FROM trash t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.id DESC LIMIT 200').all()
    .map((r) => ({ ...r, is_container: !!r.is_container })),
}));
route('POST', '/api/trash/:id/restore', USER, ({ req, params, user }) => {
  const id = restoreTrash(user, Number(params.id));
  changed(user, 'thing', id, req);
  return { thing: getThing(id) };
});
route('DELETE', '/api/trash/:id', ADMIN, ({ params }) => {
  const r = db.prepare('SELECT payload FROM trash WHERE id = ?').get(Number(params.id));
  if (!r) throw new HttpError(404, 'Niet gevonden');
  trashImageFiles(JSON.parse(r.payload));
  db.prepare('DELETE FROM trash WHERE id = ?').run(Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/trash', ADMIN, () => ({ purged: purgeTrash(-1) }));

// ---------- meerdere tegelijk ----------
route('POST', '/api/things/bulk', USER, async ({ req, user }) => {
  const b = await readJson(req);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 1000);
  if (!ids.length) throw bad('Niets geselecteerd');
  const existing = ids.filter((id) => db.prepare('SELECT 1 FROM things WHERE id = ?').get(id));
  let done = 0;
  if (b.action === 'delete') {
    // Kinderen van iets dat zelf ook weg gaat, niet apart verwijderen.
    const all = new Set(existing);
    const roots = existing.filter((id) => !pathOf(allNames(), id).slice(0, -1).some((p) => all.has(p.id)));
    for (const id of roots) { if (db.prepare('SELECT 1 FROM things WHERE id = ?').get(id)) { deleteThing(user, id); done++; } }
  } else if (b.action === 'move') {
    const parent = b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id);
    if (parent != null && !db.prepare('SELECT 1 FROM things WHERE id = ? AND is_container = 1').get(parent)) throw bad('Doel bestaat niet of is geen container');
    for (const id of existing) {
      if (parent != null && descendantIds(id).includes(parent)) continue; // niet in zichzelf
      updateThing(user, id, { parent_id: parent }); done++;
    }
  } else if (b.action === 'tag' || b.action === 'untag') {
    const tag = Number(b.tag_id);
    if (!db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tag)) throw bad('Tag bestaat niet');
    tx(db, () => {
      for (const id of existing) {
        const r = b.action === 'tag'
          ? db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?, ?)').run(id, tag)
          : db.prepare('DELETE FROM thing_tags WHERE thing_id = ? AND tag_id = ?').run(id, tag);
        if (r.changes) { db.prepare('UPDATE things SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(user.id, now(), id); done++; }
      }
    });
  } else if (b.action === 'favourite' || b.action === 'list') {
    const col = b.action === 'favourite' ? 'favourite' : 'on_list';
    for (const id of existing) { db.prepare(`UPDATE things SET ${col} = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`).run(bool(b.value), user.id, now(), id); done++; }
  } else throw bad('Onbekende actie');
  if (b.action !== 'delete') logActivity(user, null, 'bulk', `${user.display_name} paste ${done} spullen tegelijk aan (${b.action})`);
  changed(user, 'thing', null, req);
  return { done };
});

// ---------- dubbelen vinden en samenvoegen ----------
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function findDuplicates() {
  const map = allNames();
  const pathKey = (id) => pathOf(map, id).map((p) => normName(p.name)).join('›');
  const imgCount = new Map(db.prepare('SELECT thing_id, COUNT(*) c FROM images GROUP BY thing_id').all().map((r) => [r.thing_id, r.c]));
  const groups = new Map();
  for (const t of map.values()) {
    const key = `${t.is_container ? 'c' : 'i'}|${t.parent_id ? pathKey(t.parent_id) : ''}|${normName(t.name)}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(t.id);
  }
  const dup = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  // Groepen binnen een dubbele container vallen vanzelf mee bij het samenvoegen daarvan: niet apart tonen.
  const inGroup = new Map();
  for (const [key, ids] of dup) for (const id of ids) inGroup.set(id, key);
  const nested = (ids) => {
    const parents = ids.map((id) => map.get(id).parent_id);
    return parents.every((p) => p && inGroup.has(p)) && new Set(parents).size > 1;
  };
  const subtree = (id) => {
    const ids = descendantIds(id);
    return { count: ids.length - 1, images: ids.reduce((s, x) => s + (imgCount.get(x) || 0), 0) };
  };
  const out = [];
  let hidden = 0;
  for (const [key, ids] of dup) {
    if (nested(ids)) { hidden++; continue; }
    const rows = decorate(db.prepare(`SELECT * FROM things WHERE id IN (${inList(ids)}) ORDER BY id`).all(...ids))
      .map((r) => ({ ...r, path: pathOf(map, r.id).slice(0, -1), subtree: subtree(r.id) }));
    const best = [...rows].sort((a, b) => (b.subtree.images - a.subtree.images) || (b.image_ids.length - a.image_ids.length) || (a.id - b.id))[0];
    out.push({ key, kind: 'name', name: rows[0].name, is_container: rows[0].is_container, depth: rows[0].path.length, keep_id: best.id, things: rows });
  }
  // Zelfde barcode op verschillende plekken / met andere naam: wel tonen, niet automatisch samenvoegen.
  const byCode = db.prepare(`SELECT barcode, GROUP_CONCAT(id) ids FROM things WHERE is_container = 0 AND barcode IS NOT NULL AND barcode != ''
    GROUP BY barcode HAVING COUNT(*) > 1`).all();
  for (const r of byCode) {
    const ids = r.ids.split(',').map(Number);
    if (new Set(ids.map((id) => inGroup.get(id) || `x${id}`)).size < 2) continue; // al gedekt door een naamgroep
    const rows = decorate(db.prepare(`SELECT * FROM things WHERE id IN (${inList(ids)}) ORDER BY id`).all(...ids))
      .map((t) => ({ ...t, path: pathOf(map, t.id).slice(0, -1), subtree: { count: 0, images: imgCount.get(t.id) || 0 } }));
    const best = [...rows].sort((a, b) => (b.image_ids.length - a.image_ids.length) || (a.id - b.id))[0];
    out.push({ key: `b|${r.barcode}`, kind: 'barcode', name: rows[0].name, barcode: r.barcode, is_container: false, depth: 0, keep_id: best.id, things: rows });
  }
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'name' ? -1 : 1) || (a.depth - b.depth) || a.name.localeCompare(b.name, 'nl'));
  return { groups: out, hidden };
}

// Voegt drop samen in keep (binnen een transactie). Containers: inhoud verhuist, gelijknamige kinderen worden ook samengevoegd.
function mergeInto(user, keep, drop, sumQty) {
  const k = db.prepare('SELECT * FROM things WHERE id = ?').get(keep);
  const d = db.prepare('SELECT * FROM things WHERE id = ?').get(drop);
  if (!k || !d || keep === drop) return;
  if (k.is_container) {
    for (const child of db.prepare('SELECT * FROM things WHERE parent_id = ? ORDER BY id').all(drop)) {
      const twin = db.prepare('SELECT * FROM things WHERE parent_id = ? AND is_container = ? ORDER BY id').all(keep, child.is_container)
        .find((t) => normName(t.name) === normName(child.name));
      if (twin) mergeInto(user, twin.id, child.id, sumQty);
      else db.prepare('UPDATE things SET parent_id = ? WHERE id = ?').run(keep, child.id);
    }
  }
  const set = {};
  for (const f of ['description', 'barcode', 'price', 'expires_on', 'min_quantity', 'lent_to', 'lent_at', 'lent_due']) {
    if ((k[f] == null || k[f] === '') && d[f] != null && d[f] !== '') set[f] = d[f];
  }
  if (d.notes && d.notes !== k.notes && !(k.notes || '').includes(d.notes)) set.notes = k.notes ? `${k.notes}\n${d.notes}` : d.notes;
  if (d.nfc_id && !k.nfc_id) { db.prepare('UPDATE things SET nfc_id = NULL WHERE id = ?').run(drop); set.nfc_id = d.nfc_id; }
  if (sumQty && !k.is_container) set.quantity = k.quantity + d.quantity;
  if (d.favourite && !k.favourite) set.favourite = 1;
  if (d.on_list && !k.on_list) set.on_list = 1;
  const cols = Object.keys(set);
  db.prepare(`UPDATE things SET ${cols.map((c) => `${c} = ?, `).join('')}version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => set[c]), user.id, now(), keep);
  db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) SELECT ?, tag_id FROM thing_tags WHERE thing_id = ?').run(keep, drop);
  // Foto's alleen overnemen als het item dat blijft er nog geen heeft (anders zijn het meestal dezelfde).
  if (!db.prepare('SELECT 1 FROM images WHERE thing_id = ?').get(keep)) db.prepare('UPDATE images SET thing_id = ? WHERE thing_id = ?').run(keep, drop);
}
function mergeGroup(user, keep, drops, sumQty) {
  const k = db.prepare('SELECT * FROM things WHERE id = ?').get(keep);
  if (!k) throw new HttpError(404, 'Het item dat moet blijven bestaat niet (meer)');
  const valid = drops.filter((id) => id !== keep && db.prepare('SELECT 1 FROM things WHERE id = ? AND is_container = ?').get(id, k.is_container));
  for (const id of valid) if (descendantIds(id).includes(keep)) throw bad('Kan een container niet samenvoegen met iets dat erin zit');
  tx(db, () => { for (const id of valid) mergeInto(user, keep, id, sumQty); });
  // Wat overblijft van de dubbelen (lege kopieën) gaat naar de prullenbak.
  const trashIds = valid.filter((id) => db.prepare('SELECT 1 FROM things WHERE id = ?').get(id)).map((id) => deleteThing(user, id));
  logActivity(user, keep, 'merge', `${user.display_name} voegde ${valid.length} ${valid.length === 1 ? 'dubbel' : 'dubbelen'} samen in "${k.name}"`);
  return { merged: valid.length, trash_ids: trashIds };
}
route('GET', '/api/duplicates', USER, () => findDuplicates());
route('POST', '/api/duplicates/merge', USER, async ({ req, user }) => {
  const b = await readJson(req);
  const keep = Number(b.keep_id);
  const drops = [...new Set((Array.isArray(b.drop_ids) ? b.drop_ids : []).map(Number).filter(Number.isInteger))];
  if (!drops.length) throw bad('Niets om samen te voegen');
  const r = mergeGroup(user, keep, drops, !!b.sum_quantity);
  changed(user, 'thing', null, req);
  return r;
});
route('POST', '/api/duplicates/merge-all', ADMIN, async ({ req, user }) => {
  const b = await readJson(req);
  jobs.makeBackup(new Date().toISOString().slice(0, 19).replace(/:/g, '-'));
  let groups = 0, merged = 0;
  for (const g of findDuplicates().groups.filter((x) => x.kind === 'name')) {
    if (!db.prepare('SELECT 1 FROM things WHERE id = ?').get(g.keep_id)) continue;
    const r = mergeGroup(user, g.keep_id, g.things.map((t) => t.id), !!b.sum_quantity);
    if (r.merged) { groups++; merged += r.merged; }
  }
  changed(user, 'thing', null, req);
  return { groups, merged };
});

// ---------- boodschappenlijst ----------
route('POST', '/api/things/:id/bought', USER, async ({ req, params, user }) => {
  const id = Number(params.id);
  const cur = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Niet gevonden');
  const add = numOrNull((await readJson(req)).quantity);
  if (add == null || add < 0) throw bad('Aantal ontbreekt');
  const nq = cur.quantity + add;
  tx(db, () => {
    db.prepare('UPDATE things SET quantity = ?, on_list = 0, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(nq, user.id, now(), id);
    logActivity(user, id, 'bought', `${user.display_name} kocht ${num(add)}× "${cur.name}" (nu ${num(nq)})`);
  });
  changed(user, 'thing', id, req);
  jobs.checkLowStock(id);
  return { thing: getThing(id) };
});
route('POST', '/api/shopping/send', USER, async ({ user }) => {
  const rows = listThings({ shopping: '1', limit: 500 });
  if (!rows.length) throw bad('De boodschappenlijst is leeg');
  const items = rows.map((t) => ({ id: t.id, name: t.name, quantity: t.quantity, min_quantity: t.min_quantity, need: t.min_quantity != null ? Math.max(1, t.min_quantity - t.quantity + 1) : 1, location: t.path.map((p) => p.name).join(' › ') }));
  const r = await jobs.sendHa({ event: 'shopping', title: 'Boodschappenlijst', message: `${user.display_name} stuurde ${items.length} ${items.length === 1 ? 'product' : 'producten'}: ${items.map((i) => i.name).join(', ')}`, items });
  if (!r.ok) throw bad(`Versturen naar Home Assistant mislukt: ${r.reason || 'status ' + r.status}`);
  return { sent: items.length };
});

// ---------- API-tokens (Home Assistant, scripts, native app) ----------
route('GET', '/api/tokens', USER, ({ user }) => ({
  tokens: db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC').all(user.id),
}));
route('POST', '/api/tokens', USER, async ({ req, user }) => {
  if (user._viaToken) throw new HttpError(403, 'Maak tokens aan vanuit de app');
  const name = str((await readJson(req)).name, 60);
  if (!name) throw bad('Geef het token een naam, bijv. "Home Assistant"');
  const t = auth.createApiToken(db, user.id, name);
  logActivity(user, null, 'token', `${user.display_name} maakte API-token "${name}" aan`);
  return { id: t.id, token: t.token };
});
route('DELETE', '/api/tokens/:id', USER, ({ params, user }) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(Number(params.id), user.id);
  return { ok: true };
});

// ---------- CSV-import ----------
class DryRun extends Error {}
function importRecords(user, records, { dryRun, skipDuplicates }) {
  const stats = { created_items: 0, created_containers: 0, skipped: 0, created_tags: 0, errors: [] };
  const containers = new Map();
  for (const c of db.prepare('SELECT id, parent_id, name FROM things WHERE is_container = 1').all()) containers.set(`${c.parent_id || 0}|${c.name.toLowerCase()}`, c.id);
  const tagIds = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.name.toLowerCase(), t.id]));
  const t = now();
  const insThing = db.prepare(`INSERT INTO things(parent_id,is_container,name,description,notes,quantity,min_quantity,barcode,price,expires_on,created_by,updated_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ensurePath = (names) => {
    let parent = null;
    for (const raw of names) {
      const name = raw.slice(0, 200);
      const key = `${parent || 0}|${name.toLowerCase()}`;
      let id = containers.get(key);
      if (!id) {
        id = Number(insThing.run(parent, 1, name, '', '', 1, null, null, null, null, user.id, user.id, t, t).lastInsertRowid);
        containers.set(key, id); stats.created_containers++;
      }
      parent = id;
    }
    return parent;
  };
  const tagId = (name) => {
    const k = name.toLowerCase().slice(0, 60);
    if (!tagIds.has(k)) { tagIds.set(k, Number(db.prepare('INSERT INTO tags(name) VALUES(?)').run(name.slice(0, 60)).lastInsertRowid)); stats.created_tags++; }
    return tagIds.get(k);
  };
  const dup = db.prepare('SELECT 1 FROM things WHERE is_container = 0 AND lower(name) = lower(?) AND parent_id IS ?');
  try {
    tx(db, () => {
      for (const r of records) {
        try {
          if (r.is_container) { const before = stats.created_containers; ensurePath([...r.location, r.name]); if (stats.created_containers === before) stats.skipped++; continue; }
          const parent = ensurePath(r.location);
          if (skipDuplicates && dup.get(r.name, parent)) { stats.skipped++; continue; }
          const q = r.quantity == null ? 1 : Math.max(0, r.quantity);
          const id = Number(insThing.run(parent, 0, r.name.slice(0, 200), r.description.slice(0, 2000), r.notes.slice(0, 10000), q, r.min_quantity, r.barcode && r.barcode.slice(0, 100), r.price, r.expires_on, user.id, user.id, t, t).lastInsertRowid);
          for (const tg of r.tags) db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?,?)').run(id, tagId(tg));
          stats.created_items++;
        } catch (e) { stats.errors.push(`Regel ${r.line}: ${e.message}`); if (stats.errors.length > 50) throw e; }
      }
      if (dryRun) throw new DryRun();
      logActivity(user, null, 'import', `${user.display_name} importeerde ${stats.created_items} items en ${stats.created_containers} containers`);
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return stats;
}
route('POST', '/api/import.csv', USER, async ({ req, query, user }) => {
  const text = (await readBody(req, 5 * 1024 * 1024)).toString('utf8');
  let parsed;
  try { parsed = rowsToRecords(parseCsv(text)); } catch (e) { throw bad(e.message); }
  if (!parsed.records.length) throw bad('Geen regels gevonden om te importeren');
  if (parsed.records.length > 5000) throw bad('Maximaal 5000 regels per import');
  const dryRun = query.dry === '1';
  const stats = importRecords(user, parsed.records, { dryRun, skipDuplicates: query.skip_duplicates !== '0' });
  if (!dryRun) changed(user, 'thing', null, req);
  return { dry_run: dryRun, rows: parsed.records.length, columns: parsed.columns, ...stats };
});

// ---------- Dozenlijst importeren (sheet: doosnummer + inhoud per cel) ----------
// Stap 1: voorbeeld met wat al bestaat; stap 2: alleen de aangevinkte nieuwe dingen aanmaken.
route('POST', '/api/import/boxes', USER, async ({ req }) => {
  const buf = await readBody(req, 10 * 1024 * 1024);
  let rows;
  try { rows = boxes.readSheet(buf, String(req.headers['x-filename'] || '')); } catch (e) { throw bad(e.message); }
  try {
    return await boxes.plan(rows, { db, pathOf, allNames, lookupSet: async (code) => { try { return await lego.lookup(code); } catch { return null; } } });
  } catch (e) { throw bad(e.message); }
});
route('POST', '/api/import/boxes/apply', USER, async ({ req, user }) => {
  const b = await readJson(req, 2 * 1024 * 1024);
  const list = Array.isArray(b.boxes) ? b.boxes.slice(0, 500) : [];
  const parent = b.parent_id ? Number(b.parent_id) : null;
  if (parent && !db.prepare('SELECT 1 FROM things WHERE id = ? AND is_container = 1').get(parent)) throw bad('Doel bestaat niet');
  jobs.makeBackup(new Date().toISOString().slice(0, 19).replace(/:/g, '-'));
  const t = now();
  const ins = db.prepare(`INSERT INTO things(parent_id,is_container,name,description,notes,quantity,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const stats = { boxes: 0, items: 0, photos_pending: 0 };
  const photos = [];
  let legoTag = null;
  tx(db, () => {
    for (const box of list) {
      let boxId = box.existing_id ? Number(box.existing_id) : null;
      if (boxId && !db.prepare('SELECT 1 FROM things WHERE id = ? AND is_container = 1').get(boxId)) boxId = null;
      const items = Array.isArray(box.items) ? box.items.slice(0, 200) : [];
      if (!boxId) {
        if (!items.length && !box.create_empty) continue;
        boxId = Number(ins.run(parent, 1, str(box.name || `Doos ${box.number}`, 200), str((box.notes || []).join(', '), 2000), '', 1, user.id, user.id, t, t).lastInsertRowid);
        stats.boxes++;
      }
      for (const it of items) {
        const name = str(it.name, 200);
        if (!name) continue;
        const id = Number(ins.run(boxId, 0, name, str(it.description, 2000), '', Math.max(0, Number(it.quantity) || 1), user.id, user.id, t, t).lastInsertRowid);
        if (it.lego) {
          legoTag = legoTag || (db.prepare("SELECT id FROM tags WHERE lower(name) = 'lego'").get() || {}).id || Number(db.prepare("INSERT INTO tags(name, color) VALUES('Lego', '#e53935')").run().lastInsertRowid);
          db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?, ?)').run(id, legoTag);
        }
        if (it.image_url) photos.push([id, String(it.image_url)]);
        stats.items++;
      }
    }
    logActivity(user, null, 'import', `${user.display_name} importeerde een dozenlijst (${stats.boxes} dozen, ${stats.items} spullen)`);
  });
  stats.photos_pending = photos.length;
  changed(user, 'thing', null, req);
  // Foto's op de achtergrond ophalen (paar tegelijk), daarna nog een live-update.
  (async () => {
    const queue = photos.slice();
    await Promise.all([0, 1, 2, 3].map(async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const img = await fetchImage(p[1], MAX_IMAGE).catch(() => null);
        if (img && db.prepare('SELECT 1 FROM things WHERE id = ?').get(p[0])) storeImage(user, p[0], img.buf, img.mime, null);
      }
    }));
    changed(user, 'thing', null, null);
  })().catch((e) => console.warn('Foto\'s dozenlijst:', e.message));
  return stats;
});

// ---------- Find my stuff-back-up (.bckp) importeren ----------
// Stap 1 uploadt en toont een overzicht; stap 2 voert de import uit op hetzelfde bestand (geen tweede upload van ~100 MB).
const FMS_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(FMS_DIR, { recursive: true });
const fmsFile = (token) => (/^[a-f0-9]{32}$/.test(token) ? path.join(FMS_DIR, `fms-${token}.zip`) : null);
setInterval(() => {
  for (const f of fs.readdirSync(FMS_DIR)) {
    const full = path.join(FMS_DIR, f);
    try { if (Date.now() - fs.statSync(full).mtimeMs > 3600e3) fs.unlinkSync(full); } catch { /* */ }
  }
}, 15 * 60e3).unref();
route('POST', '/api/import/findmystuff', ADMIN, async ({ req }) => {
  const buf = await readBody(req, 300 * 1024 * 1024);
  if (!buf.length) throw bad('Leeg bestand');
  let parsed;
  try { parsed = fms.parseBackup(buf); } catch (e) { throw bad(e.message); }
  const token = require('node:crypto').randomBytes(16).toString('hex');
  fs.writeFileSync(fmsFile(token), buf);
  const prev = db.prepare('SELECT value FROM meta WHERE key = ?').get(`fms_import_${fms.fingerprint(parsed)}`);
  return { token, summary: fms.summarize(parsed), sample: parsed.things.slice(0, 8).map((t) => t.name), already_imported: prev ? prev.value : null };
});
route('POST', '/api/import/findmystuff/:token', ADMIN, async ({ req, params, user }) => {
  const file = fmsFile(params.token);
  if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Upload verlopen, probeer het opnieuw');
  const b = await readJson(req);
  const parentId = b.parent_id ? Number(b.parent_id) : null;
  if (parentId && !db.prepare('SELECT 1 FROM things WHERE id = ? AND is_container = 1').get(parentId)) throw bad('Doelcontainer bestaat niet');
  const parsed = fms.parseBackup(fs.readFileSync(file));
  const stats = fms.importBackup(parsed, {
    db, tx, user, now, parentId, attachOnly: !!b.attach_only,
    storeImageFile: (thingId, data, mime, position) => {
      const ext = IMAGE_TYPES[mime];
      const id = Number(db.prepare('INSERT INTO images(thing_id,mime,ext,position,created_by,created_at) VALUES(?,?,?,?,?,?)').run(thingId, mime, ext, position, user.id, now()).lastInsertRowid);
      fs.writeFileSync(path.join(IMG_DIR, `${id}.${ext}`), data);
    },
  });
  fs.unlink(file, () => {});
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`fms_import_${fms.fingerprint(parsed)}`, now());
  changed(user, 'thing', null, req);
  changed(user, 'tag', null, req);
  return { stats };
});

// Alles wissen (bijv. na een mislukte of dubbele import). Maakt eerst een back-up; gebruikers en API-tokens blijven.
route('POST', '/api/wipe', ADMIN, async ({ req, user }) => {
  const b = await readJson(req);
  if (b.confirm !== 'WISSEN') throw bad('Typ WISSEN om te bevestigen');
  const backup = jobs.makeBackup(new Date().toISOString().slice(0, 19).replace(/:/g, '-'));
  const imgs = db.prepare('SELECT id, ext FROM images').all();
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM things) things, (SELECT COUNT(*) FROM tags) tags').get();
  tx(db, () => {
    db.exec("DELETE FROM things; DELETE FROM notified; DELETE FROM meta WHERE key LIKE 'fms_import_%';");
    if (b.tags) db.exec('DELETE FROM tags;');
    logActivity(user, null, 'wipe', `${user.display_name} wiste alle spullen (${counts.things})${b.tags ? ' en tags' : ''}; back-up ${backup}`);
  });
  deleteImageFiles(imgs);
  changed(user, 'thing', null, req);
  changed(user, 'tag', null, req);
  return { ok: true, backup, deleted_things: counts.things, deleted_tags: b.tags ? counts.tags : 0 };
});

// ---------- back-ups (beheerder) ----------
route('GET', '/api/backups', ADMIN, () => ({ backups: jobs.listBackups(), config: jobs.config }));
route('POST', '/api/backups', ADMIN, ({ user }) => {
  const name = jobs.makeBackup(new Date().toISOString().slice(0, 19).replace(/:/g, '-'));
  logActivity(user, null, 'backup', `${user.display_name} maakte een back-up`);
  return { name };
});
route('GET', '/api/backups/:name', ADMIN, ({ params, res }) => {
  const file = jobs.backupFile(params.name);
  if (!file) throw new HttpError(404, 'Back-up niet gevonden');
  res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="${params.name}"`, 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
  return res;
});
// Volledige back-up: verse database-kopie + alle foto's in één .tar
route('GET', '/api/backup.tar', ADMIN, async ({ res }) => {
  const snap = jobs.snapshot();
  const entries = [{ name: 'mijn-spullen.db', file: snap }];
  for (const f of fs.readdirSync(IMG_DIR)) entries.push({ name: `images/${f}`, file: path.join(IMG_DIR, f) });
  res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="mijn-spullen-volledig-${new Date().toISOString().slice(0, 10)}.tar"`, 'Cache-Control': 'no-store' });
  try { await writeTar(res, entries); } finally { fs.unlink(snap, () => {}); }
  return res;
});

// ---------- Home Assistant ----------
// Voor een REST-sensor in HA (met een API-token): aantallen en lijstjes.
route('GET', '/api/summary', USER, () => jobs.summary());
route('GET', '/api/integrations', USER, () => ({ ...jobs.config }));
route('POST', '/api/integrations/ha/test', ADMIN, async ({ user }) => {
  const r = await jobs.sendHa({ event: 'test', title: 'Mijn Spullen', message: `Testmelding van ${user.display_name}. Het werkt!`, items: [] });
  if (!r.ok) throw bad(`Home Assistant-melding mislukt: ${r.reason || 'status ' + r.status}`);
  return { ok: true };
});
route('POST', '/api/integrations/ha/expiring', ADMIN, async () => ({ result: await jobs.notifyExpiring(true) }));

// ---------- statische bestanden ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Niet gevonden');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // App-code altijd hervalideren, zodat een nieuwe versie direct overal actief is; iconen mogen langer.
    'Cache-Control': /\.(html|js|css|webmanifest)$/.test(rel) ? 'no-cache' : 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data: https://cdn.rebrickable.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    let matched = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(url.pathname);
      if (m) { matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!matched) throw new HttpError(404, 'Onbekend endpoint');
    let user = null;
    if (matched.opts.auth) {
      user = auth.getUser(db, req);
      if (!user) throw new HttpError(401, 'Niet ingelogd');
      if (matched.opts.admin && user.role !== 'admin') throw new HttpError(403, 'Alleen voor beheerders');
    }
    // CSRF-bescherming: schrijfacties moeten een eigen header meesturen (kan cross-site niet zonder CORS).
    // Met een API-token (Authorization-header) is er geen cookie in het spel en dus geen CSRF-risico.
    if (!['GET', 'HEAD'].includes(req.method) && !(user && user._viaToken) && req.headers['x-requested-with'] !== 'mijn-spullen') {
      throw new HttpError(403, 'Ongeldig verzoek');
    }
    const result = await matched.handler({ req, res, params, query: Object.fromEntries(url.searchParams), user });
    if (result === res || res.writableEnded || res.headersSent) return;
    send(res, 200, result);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Interne fout' });
  }
});

// verlopen sessies opruimen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600e3).unref();

// Eenmalig: dozen consequent "Doos 101" noemen (was "101" of "Box 101"); dubbele dozen daarna samenvoegen.
function renameBoxes() {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'boxes_renamed_v1'").get()) return;
  const rows = db.prepare('SELECT id, parent_id, name FROM things WHERE is_container = 1').all()
    .map((t) => ({ ...t, m: t.name.match(/^\s*(?:box|doos)?\s*#?\s*(\d{1,4})\s*$/i) })).filter((t) => t.m && t.name !== `Doos ${Number(t.m[1])}`);
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) return; // nog geen account: later opnieuw
  if (rows.length) {
    jobs.makeBackup(new Date().toISOString().slice(0, 19).replace(/:/g, '-'));
    tx(db, () => { for (const t of rows) db.prepare('UPDATE things SET name = ?, version = version + 1, updated_at = ? WHERE id = ?').run(`Doos ${Number(t.m[1])}`, now(), t.id); });
    const groups = db.prepare(`SELECT parent_id, name, GROUP_CONCAT(id) ids FROM things WHERE is_container = 1 AND name LIKE 'Doos %' GROUP BY parent_id, name HAVING COUNT(*) > 1`).all();
    let merged = 0;
    for (const g of groups) { const ids = g.ids.split(',').map(Number).sort((a, b) => a - b); merged += mergeGroup(admin, ids[0], ids.slice(1), false).merged; }
    logActivity(admin, null, 'rename', `${rows.length} dozen hernoemd naar "Doos …"${merged ? `, ${merged} dubbele dozen samengevoegd` : ''}`);
    console.log(`Dozen hernoemd: ${rows.length}, samengevoegd: ${merged}`);
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('boxes_renamed_v1', ?)").run(now());
}

if (require.main === module) {
  try { renameBoxes(); } catch (e) { console.error('Dozen hernoemen mislukt:', e.message); }
  jobs.start();
  server.listen(PORT, () => console.log(`Mijn Spullen ${VERSION} luistert op :${PORT} (data: ${DATA_DIR})`));
}
module.exports = { server, db, jobs };
