'use strict';
// Import van een Find my stuff-back-up (.bckp): een zip met backup.txt (JSON) en foto's.
// Leest alleen de eigen export van de gebruiker; er wordt niets uit de app zelf overgenomen.
const path = require('node:path');
const { readZip } = require('./zip');

// colorId 0–8 is een index in het palet van de app; dit benadert die kleuren.
const TAG_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e88e5', '#3949ab', '#8e24aa', '#6d4c41'];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function parseBackup(buf) {
  const zip = readZip(buf);
  const txt = zip.read('backup.txt');
  if (!txt) throw new Error('backup.txt ontbreekt: is dit wel een Find my stuff-back-up?');
  let data;
  try { data = JSON.parse(txt.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('backup.txt is geen geldige JSON'); }
  const things = Array.isArray(data.thingBackupList) ? data.thingBackupList : [];
  if (!things.length) throw new Error('Geen spullen gevonden in de back-up');
  // Foto's: uri kan een pad in de zip zijn of alleen een bestandsnaam.
  const byBase = new Map();
  for (const name of zip.entries.keys()) if (MIME[path.extname(name).toLowerCase()]) byBase.set(path.basename(name), name);
  const images = (Array.isArray(data.images) ? data.images : []).map((im) => {
    const uri = String(im.uri || '').replace(/^.*?:\/\//, '');
    let entry = zip.entries.has(uri) ? uri : null;
    if (!entry) { const tail = uri.split('/').filter(Boolean); for (let i = 0; i < tail.length && !entry; i++) { const p = tail.slice(i).join('/'); if (zip.entries.has(p)) entry = p; } }
    if (!entry) entry = byBase.get(path.basename(uri)) || null;
    return { itemId: im.itemId, primary: !!im.isPrimary, entry };
  });
  return { zip, data, things, tags: data.tagBackupList || [], links: data.thingTagsBackupList || [], images };
}

function summarize(b) {
  const containers = b.things.filter((t) => t.isVisuallyStorage).length;
  return {
    things: b.things.length, containers, items: b.things.length - containers,
    tags: b.tags.length, tagged: b.links.length,
    images: b.images.length, images_found: b.images.filter((i) => i.entry).length,
    barcodes: b.things.filter((t) => t.barcode).length,
  };
}

// Find my stuff gebruikt soms strings ("1") en soms getallen (1) als id: altijd als string vergelijken.
const K = (v) => (v == null ? null : String(v));
const ms2iso = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? new Date(Number(v)).toISOString() : null);
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (ms2iso(v) || '').slice(0, 10) || null);

// ctx: { db, tx, user, now, storeImageFile(thingId, buf, mime, position), parentId }
function importBackup(b, ctx) {
  const { db, user } = ctx;
  const now = ctx.now();
  const attach = !!ctx.attachOnly; // alleen foto's/tags aanvullen bij een eerdere import
  const stats = { ...summarize(b), matched_things: 0, unmatched_things: 0, created_things: 0, created_tags: 0, reused_tags: 0, imported_images: 0, skipped_images: 0 };
  const idMap = new Map();
  ctx.tx(db, () => {
    // tags (bestaande met dezelfde naam hergebruiken)
    const existing = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.name.toLowerCase(), t.id]));
    const tagMap = new Map();
    for (const t of b.tags) {
      const name = String(t.name || '').trim().slice(0, 60);
      if (!name) continue;
      let id = existing.get(name.toLowerCase());
      if (id) stats.reused_tags++;
      else {
        id = Number(db.prepare('INSERT INTO tags(name, color) VALUES(?, ?)').run(name, TAG_COLORS[Number(t.colorId) % TAG_COLORS.length] || '#64748b').lastInsertRowid);
        existing.set(name.toLowerCase(), id); stats.created_tags++;
      }
      tagMap.set(K(t.id), id);
    }
    // spullen: ouders eerst (parentId kan naar elk ander record wijzen)
    const byId = new Map(b.things.map((t) => [K(t.id), t]));
    const used = new Set();
    const findExisting = db.prepare('SELECT id FROM things WHERE parent_id IS ? AND name = ? AND is_container = ? ORDER BY id');
    const ins = db.prepare(`INSERT INTO things(parent_id,is_container,name,description,notes,quantity,barcode,price,expires_on,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const visiting = new Set();
    const create = (t) => {
      const key = K(t.id);
      if (idMap.has(key)) return idMap.get(key);
      if (visiting.has(key)) return ctx.parentId ?? null; // kringverwijzing: op hoofdniveau zetten
      visiting.add(key);
      const parent = t.parentId != null && byId.has(K(t.parentId)) ? create(byId.get(K(t.parentId))) : (ctx.parentId ?? null);
      if (attach) {
        const name = String(t.name || 'Naamloos').trim().slice(0, 200) || 'Naamloos';
        const hit = parent === undefined ? null : findExisting.all(parent, name, t.isVisuallyStorage ? 1 : 0).find((r) => !used.has(r.id));
        if (hit) { used.add(hit.id); stats.matched_things++; } else stats.unmatched_things++;
        idMap.set(key, hit ? hit.id : undefined);
        return hit ? hit.id : undefined;
      }
      const notes = [t.datePurchase ? `Aankoopdatum: ${isoDate(t.datePurchase)}` : null, t.note || t.notes || null].filter(Boolean).join('\n');
      const price = Number(t.price) > 0 ? Number(t.price) / 100 : null; // Find my stuff bewaart centen
      const id = Number(ins.run(parent, t.isVisuallyStorage ? 1 : 0, String(t.name || 'Naamloos').trim().slice(0, 200) || 'Naamloos',
        String(t.description || '').trim().slice(0, 2000), notes.slice(0, 10000), Math.max(0, Number(t.quantity ?? 1) || 0),
        t.barcode ? String(t.barcode).trim().slice(0, 100) : null, price, t.dateExpiration ? isoDate(t.dateExpiration) : null,
        user.id, user.id, ms2iso(t.created) || now, ms2iso(t.lastModification) || ms2iso(t.created) || now).lastInsertRowid);
      idMap.set(key, id); stats.created_things++;
      return id;
    };
    for (const t of b.things) create(t);
    const link = db.prepare('INSERT OR IGNORE INTO thing_tags(thing_id, tag_id) VALUES(?, ?)');
    for (const l of b.links) {
      const tid = idMap.get(K(l.thingId));
      if (tid) for (const g of l.tagIds || []) if (tagMap.has(K(g))) link.run(tid, tagMap.get(K(g)));
    }
    db.prepare('INSERT INTO activity(user_id,thing_id,action,summary,at) VALUES(?,?,?,?,?)')
      .run(user.id, null, 'import', attach ? `${user.display_name} vulde foto's en tags aan uit een Find my stuff-back-up` : `${user.display_name} importeerde een Find my stuff-back-up (${stats.created_things} spullen)`, now);
  });
  // Foto's na de transactie (bestanden schrijven), primaire foto eerst.
  const perThing = new Map();
  for (const im of b.images) { const k = K(im.itemId); (perThing.get(k) || perThing.set(k, []).get(k)).push(im); }
  const hasImages = db.prepare('SELECT 1 FROM images WHERE thing_id = ? LIMIT 1');
  for (const [itemId, list] of perThing) {
    const tid = idMap.get(itemId);
    if (attach && tid && hasImages.get(tid)) { stats.skipped_images += list.length; continue; } // al foto's: niet dubbel
    list.sort((a, c) => Number(c.primary) - Number(a.primary));
    list.forEach((im, pos) => {
      if (!tid || !im.entry || pos >= 10) { stats.skipped_images++; return; }
      const mime = MIME[path.extname(im.entry).toLowerCase()];
      const buf = b.zip.read(im.entry);
      if (!buf || !buf.length || buf.length > 8 * 1024 * 1024) { stats.skipped_images++; return; }
      ctx.storeImageFile(tid, buf, mime, pos);
      stats.imported_images++;
    });
  }
  return stats;
}

module.exports = { parseBackup, summarize, importBackup };
