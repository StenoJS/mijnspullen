'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-test-'));
const { server } = require('../server/index.js');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); server.closeAllConnections?.(); });

function client() {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'x-requested-with': 'mijn-spullen', cookie, ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
}

test('volledige flow: setup, gebruikers, spullen, conflicten, tags, foto, export', async () => {
  const a = client(), b = client();
  assert.equal((await a('GET', '/api/setup-status')).body.needsSetup, true);
  assert.equal((await a('GET', '/api/things')).status, 401);
  assert.equal((await a('POST', '/api/setup', { username: 'steno', password: 'kort' })).status, 400);
  assert.equal((await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' })).status, 200);
  assert.equal((await a('POST', '/api/setup', { username: 'x2', password: 'langgenoeg1' })).status, 403);

  // CSRF-header verplicht
  const noHdr = await fetch(base + '/api/things', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHdr.status, 401);

  // tweede gebruiker
  assert.equal((await a('POST', '/api/users', { username: 'linda', display_name: 'Linda', password: 'wachtwoord2' })).status, 200);
  assert.equal((await b('POST', '/api/login', { username: 'linda', password: 'fout' })).status, 401);
  assert.equal((await b('POST', '/api/login', { username: 'linda', password: 'wachtwoord2' })).status, 200);
  assert.equal((await b('POST', '/api/users', { username: 'x', password: 'xxxxxxxx' })).status, 403);

  // boom: huis > kamer > doos > item
  const huis = (await a('POST', '/api/things', { name: 'Huis', is_container: true })).body.thing;
  const zolder = (await a('POST', '/api/things', { name: 'Zolder', is_container: true, parent_id: huis.id })).body.thing;
  const doos = (await b('POST', '/api/things', { name: 'Doos kabels', is_container: true, parent_id: zolder.id })).body.thing;
  const tag = (await a('POST', '/api/tags', { name: 'Elektronica', color: '#3366ff' })).body.id;
  const kabel = (await a('POST', '/api/things', { name: 'USB-C kabel', parent_id: doos.id, quantity: 2, min_quantity: 3, barcode: '8712345678901', price: 4.5, expires_on: '2020-01-01', tag_ids: [tag] })).body.thing;
  assert.deepEqual(kabel.path.map((p) => p.name), ['Huis', 'Zolder', 'Doos kabels']);
  assert.equal(kabel.created_by_name, 'Steno');

  // zoeken / filters
  assert.equal((await a('GET', '/api/things?q=usb')).body.things.length, 1);
  assert.equal((await a('GET', '/api/things?q=elektronica')).body.things.length, 1, 'zoeken op tagnaam');
  assert.equal((await a('GET', '/api/things?barcode=8712345678901')).body.things[0].id, kabel.id);
  assert.equal((await a('GET', '/api/things?low=1')).body.things.length, 1);
  assert.equal((await a('GET', '/api/things?expiring=30')).body.things.length, 1);
  assert.equal((await a('GET', `/api/things?tag=${tag}`)).body.things.length, 1);
  assert.equal((await a('GET', '/api/things?parent=root')).body.things.length, 1);
  assert.equal((await a('GET', `/api/things?scope=${huis.id}&q=kabel`)).body.things.length, 2); // doos + kabel

  // optimistische versie: b wijzigt na a
  const r1 = await a('PATCH', `/api/things/${kabel.id}`, { version: kabel.version, quantity: 5 });
  assert.equal(r1.status, 200);
  const r2 = await b('PATCH', `/api/things/${kabel.id}`, { version: kabel.version, name: 'Oud' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.current.quantity, 5);

  // aanpassen aantal
  assert.equal((await b('POST', `/api/things/${kabel.id}/adjust`, { delta: -10 })).body.thing.quantity, 0);

  // cirkel verplaatsen verboden
  assert.equal((await a('PATCH', `/api/things/${huis.id}`, { parent_id: kabel.id })).status, 400);
  // verplaatsen kan
  assert.equal((await a('PATCH', `/api/things/${kabel.id}`, { parent_id: huis.id })).status, 200);

  // foto
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await a('POST', `/api/things/${kabel.id}/images`, png, { 'content-type': 'image/png' });
  assert.equal(up.status, 200);
  const img = await fetch(`${base}/api/images/${up.body.image.id}`, { headers: { cookie: (await (async () => '')()) } });
  assert.equal(img.status, 401, 'foto zonder login niet toegankelijk');
  assert.equal((await a('POST', `/api/things/${kabel.id}/images`, Buffer.from('x'), { 'content-type': 'text/html' })).status, 415);

  // stats + export + activiteit
  const st = (await a('GET', '/api/stats')).body.stats;
  assert.equal(st.items, 1); assert.equal(st.containers, 3);
  const csv = (await a('GET', '/api/export.csv')).body;
  assert.match(csv, /USB-C kabel/);
  assert.ok((await a('GET', '/api/activity')).body.activity.length >= 5);

  // verwijderen cascade
  assert.equal((await a('DELETE', `/api/things/${huis.id}`)).status, 200);
  assert.equal((await a('GET', '/api/things')).body.things.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, 'images')), ['trash'], 'fotobestanden naar de prullenbak');
  assert.ok(fs.readdirSync(path.join(process.env.DATA_DIR, 'images', 'trash')).length > 0);

  // logout
  assert.equal((await b('POST', '/api/logout')).status, 200);
  assert.equal((await b('GET', '/api/me')).status, 401);
});
