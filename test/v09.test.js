'use strict';
// 0.9.0: id's worden nooit hergebruikt, thumbnails niet verkeerd gecachet, back-ups apart bewaard, nette 400's.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v09-'));
process.env.BACKUP_KEEP = '2';
const { server, jobs } = require('../server/index.js');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); server.closeAllConnections?.(); });

let cookie = '';
async function call(method, url, body, extra = {}) {
  const isRaw = Buffer.isBuffer(body);
  const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (isRaw ? body : JSON.stringify(body)) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, headers: res.headers, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

test('id\'s van verwijderde spullen en foto\'s komen niet terug; herstellen houdt hetzelfde id', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'steno', password: 'langgenoeg1' })).status, 200);
  const a = (await call('POST', '/api/things', { name: 'Boormachine' })).body.thing;
  const img = (await call('POST', `/api/things/${a.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  const trash = (await call('DELETE', `/api/things/${a.id}`)).body.trash_id;
  const b = (await call('POST', '/api/things', { name: 'Schroevendraaier' })).body.thing;
  assert.ok(b.id > a.id, 'nieuw ding krijgt een nieuw id');
  const img2 = (await call('POST', `/api/things/${b.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  assert.ok(img2.id > img.id, 'nieuwe foto krijgt een nieuw id');
  const restored = (await call('POST', `/api/trash/${trash}/restore`)).body.thing;
  assert.equal(restored.id, a.id, 'QR-label/NFC-tag blijft werken na herstellen');
  assert.deepEqual(restored.image_ids, [img.id]);
  assert.equal((await call('GET', `/api/images/${img.id}`)).status, 200);
});

test('thumbnail zonder thumb wordt niet een jaar gecachet', async () => {
  const t = (await call('POST', '/api/things', { name: 'Lamp' })).body.thing;
  const im = (await call('POST', `/api/things/${t.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  assert.match((await call('GET', `/api/images/${im.id}?thumb=1`)).headers.get('cache-control'), /no-cache/);
  await call('PUT', `/api/images/${im.id}/thumb`, JPEG, { 'content-type': 'image/jpeg' });
  assert.match((await call('GET', `/api/images/${im.id}?thumb=1`)).headers.get('cache-control'), /immutable/);
});

test('nette foutmeldingen in plaats van een interne fout', async () => {
  assert.equal((await call('POST', '/api/tags', { name: 'Sub', parent_id: 9999 })).status, 400);
  assert.equal((await call('GET', '/api/lego/%E0%A4%A')).status, 400);
});

test('houdbaarheid gebruikt de lokale datum', async () => {
  const d = new Date(); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await call('POST', '/api/things', { name: 'Melk', expires_on: iso });
  const r = (await call('GET', '/api/things?expiring=0')).body.things;
  assert.ok(r.some((t) => t.name === 'Melk'));
  assert.ok(jobs.summary().expiring.some((t) => t.name === 'Melk'));
});

test('losse back-ups drukken de dagelijkse niet weg', async () => {
  for (const day of ['2026-01-01', '2026-01-02']) jobs.makeBackup(day);
  for (let i = 0; i < 4; i++) jobs.makeBackup(`2026-02-0${i + 1}T10-00-00`);
  const names = jobs.listBackups().map((b) => b.name);
  assert.ok(names.includes('mijn-spullen-2026-01-01.db') && names.includes('mijn-spullen-2026-01-02.db'));
  assert.equal(names.filter((n) => n.includes('T')).length, 2);
});
