'use strict';
// Herstel getest: een back-up (los .db-bestand én de volledige .tar met foto's) terugzetten in een verse
// datamap en kijken of een nieuwe server daar gewoon mee opstart, met alle spullen, tags, foto's en de prullenbak.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-restore-src-'));
const { server, jobs } = require('../server/index.js');
const { checkBackup } = require('../server/check-backup.js');
let base;
const children = [];
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); server.closeAllConnections?.(); for (const c of children) c.kill(); });

function client(root) {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(root() + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (isRaw ? body : JSON.stringify(body)) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function startServer(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health')).ok) return { url, child, log: () => log }; } catch { /* nog niet klaar */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server start niet:\n${log}`);
}
// Minimale tar-lezer (ustar), alleen voor deze test.
function untar(buf, dir) {
  for (let p = 0; p + 512 <= buf.length;) {
    const name = buf.toString('utf8', p, p + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.toString('latin1', p + 124, p + 136).replace(/\0.*$/s, '').trim(), 8);
    const file = path.join(dir, name);
    assert.ok(file.startsWith(dir + path.sep), 'geen paden buiten de map');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
}

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const src = client(() => base);
const fixture = {};

test('bron: spullen, tags, foto\'s, avatar en iets in de prullenbak', async () => {
  await src('POST', '/api/setup', { username: 'steno', password: 'langgenoeg1' });
  const tag = (await src('POST', '/api/tags', { name: 'Kerst', color: '#e53935' })).body.id;
  const zolder = (await src('POST', '/api/things', { name: 'Zolder', is_container: true })).body.thing;
  const ballen = (await src('POST', '/api/things', { name: 'Kerstballen', parent_id: zolder.id, quantity: 24, tag_ids: [tag], nfc_id: 'AA:BB' })).body.thing;
  const img = (await src('POST', `/api/things/${ballen.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  await src('PUT', `/api/images/${img.id}/thumb`, JPEG, { 'content-type': 'image/jpeg' });
  await src('PUT', '/api/me/avatar', JPEG, { 'content-type': 'image/jpeg' });
  const piek = (await src('POST', '/api/things', { name: 'Piek', parent_id: zolder.id })).body.thing;
  const pimg = (await src('POST', `/api/things/${piek.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  const trash = (await src('DELETE', `/api/things/${piek.id}`)).body.trash_id;
  Object.assign(fixture, { tag, zolder, ballen, img, piek, pimg, trash });
});

test('los .db-bestand: controleren, terugzetten en opstarten', async () => {
  const name = jobs.makeBackup('2026-11-23T12-00-00');
  const file = jobs.backupFile(name);
  const check = checkBackup(file);
  assert.equal(check.ok, true);
  assert.equal(check.schema_version, 5);
  assert.deepEqual([check.containers, check.items, check.tags, check.images, check.trash, check.admins], [1, 1, 1, 1, 1, 1]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-restore-db-'));
  fs.copyFileSync(file, path.join(dir, 'mijn-spullen.db'));
  const s = await startServer(dir);
  const c = client(() => s.url);
  assert.equal((await c('POST', '/api/login', { username: 'steno', password: 'langgenoeg1' })).status, 200, 'inloggen met het oude wachtwoord');
  const t = (await c('GET', `/api/things/${fixture.ballen.id}`)).body.thing;
  assert.equal(t.name, 'Kerstballen');
  assert.equal(t.quantity, 24);
  assert.deepEqual(t.tag_ids, [fixture.tag]);
  assert.deepEqual(t.path.map((p) => p.name), ['Zolder']);
  assert.equal((await c('GET', '/api/things?nfc=aa:bb')).body.things[0].id, fixture.ballen.id, 'NFC-tag en QR-label wijzen nog naar hetzelfde id');
  assert.equal((await c('GET', `/api/images/${fixture.img.id}`)).status, 404, 'een los .db-bestand heeft geen foto\'s: daarvoor is de .tar');
  // Na herstel gewoon verder werken: nieuwe id's botsen niet met oude.
  const nieuw = (await c('POST', '/api/things', { name: 'Nieuw na herstel' })).body.thing;
  assert.ok(nieuw.id > fixture.piek.id);
  s.child.kill();
});

test('volledige .tar: database + foto\'s + prullenbak terugzetten', async () => {
  const tar = await src('GET', '/api/backup.tar');
  assert.equal(tar.status, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-restore-tar-'));
  untar(tar.body, dir);
  assert.ok(fs.existsSync(path.join(dir, 'mijn-spullen.db')));
  assert.equal(checkBackup(path.join(dir, 'mijn-spullen.db')).ok, true);

  const s = await startServer(dir);
  const c = client(() => s.url);
  assert.equal((await c('POST', '/api/login', { username: 'steno', password: 'langgenoeg1' })).status, 200);
  const im = await c('GET', `/api/images/${fixture.img.id}`);
  assert.equal(im.status, 200);
  assert.ok(im.body.equals(JPEG), 'foto komt byte voor byte terug');
  assert.equal((await c('GET', `/api/images/${fixture.img.id}?thumb=1`)).status, 200);
  const me = (await c('GET', '/api/me')).body.user;
  assert.equal((await c('GET', `/api/avatars/${me.id}`)).status, 200, 'avatar ook');
  // Ook uit de prullenbak terugzetten werkt nog, mét foto.
  const back = (await c('POST', `/api/trash/${fixture.trash}/restore`)).body.thing;
  assert.equal(back.id, fixture.piek.id);
  assert.equal((await c('GET', `/api/images/${fixture.pimg.id}`)).status, 200);
  s.child.kill();
});
