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
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
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
    const fields = ['parent_id', 'is_container', 'name', 'description', 'notes', 'quantity', 'min_quantity', 'barcode', 'nfc_id', 'price', 'expires_on', 'favourite'];
    const sets = [], args = [];
    for (const f of fields) if (f in v) { sets.push(`${f} = ?`); args.push(v[f]); }
    sets.push('version = version + 1', 'updated_by = ?', 'updated_at = ?');
    args.push(user.id, now(), id);
    db.prepare(`UPDATE things SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (v.nfc_id) releaseNfc(v.nfc_id, id);
    if (v.tag_ids) setTags(id, v.tag_ids);
    const moved = 'parent_id' in v && v.parent_id !== cur.parent_id;
    logActivity(user, id, moved ? 'move' : 'update', `${user.display_name} ${moved ? 'verplaatste' : 'wijzigde'} "${v.name || cur.name}"`);
  });
  if ('expires_on' in v && v.expires_on !== cur.expires_on) jobs.expiryChanged(id);
}

function deleteImageFiles(rows) {
  for (const r of rows) {
    for (const suffix of ['', '.thumb']) {
      try { fs.unlinkSync(path.join(IMG_DIR, `${r.id}${suffix}.${r.ext}`)); } catch { /* al weg */ }
    }
  }
}
function deleteThing(user, id) {
  const cur = db.prepare('SELECT * FROM things WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Niet gevonden');
  const ids = descendantIds(id);
  const imgs = db.prepare(`SELECT id, ext FROM images WHERE thing_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  tx(db, () => {
    db.prepare('DELETE FROM things WHERE id = ?').run(id); // cascade naar kinderen, tags, afbeeldingen
    logActivity(user, null, 'delete', `${user.display_name} verwijderde "${cur.name}"${ids.length > 1 ? ` en ${ids.length - 1} onderliggende items` : ''}`);
  });
  deleteImageFiles(imgs);
}

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
route('GET', '/api/me', USER, ({ user }) => ({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }, version: VERSION }));
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
  deleteThing(user, Number(params.id));
  changed(user, 'thing', null, req);
  return { ok: true };
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
    SUM(expires_on IS NOT NULL AND expires_on <= date('now', '+30 days')) AS expiring
    FROM things`).get();
  return { stats: { items: s.items || 0, containers: s.containers || 0, total_quantity: s.total_quantity, total_value: s.total_value, low: s.low || 0, expiring: s.expiring || 0 } };
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
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
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

if (require.main === module) {
  jobs.start();
  server.listen(PORT, () => console.log(`Mijn Spullen ${VERSION} luistert op :${PORT} (data: ${DATA_DIR})`));
}
module.exports = { server, db, jobs };
