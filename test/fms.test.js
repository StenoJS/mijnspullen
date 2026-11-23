'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fms-'));
const { server } = require('../server/index.js');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); server.closeAllConnections?.(); });

// Kleine zip-schrijver voor de test (deflate), zodat er geen echte back-up nodig is.
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp); centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('Find my stuff-back-up importeren', async () => {
  let cookie = '';
  const call = async (method, url, body, ct) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', cookie, ...(ct ? { 'content-type': ct } : {}) }, body });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/setup', JSON.stringify({ username: 'steno', password: 'langgenoeg1' }), 'application/json');
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const backup = {
    schemaVersion: 1,
    thingBackupList: [
      { id: 3, name: 'Lego uitzoeken', parentId: 2, isVisuallyStorage: false, quantity: 1, description: 'Diverse Lego ', price: 12500, created: 1700000000000 },
      { id: 1, name: 'Opslagruimte ', isVisuallyStorage: true, quantity: 1, price: 0 },
      { id: 2, name: '104', parentId: 1, isVisuallyStorage: true, quantity: 1 },
      { id: 4, name: 'Trivial Pursuit', parentId: 2, isVisuallyStorage: false, quantity: 1 },
      { id: 5, name: 'Trivial Pursuit', parentId: 2, isVisuallyStorage: false, quantity: 0, barcode: '8715600240801', dateExpiration: '2025-11-19', datePurchase: '2021-12-15' },
    ],
    tagBackupList: [{ id: 1, name: 'Lego', colorId: 3 }],
    thingTagsBackupList: [{ thingId: '3', tagIds: ['1'] }],
    images: [
      { id: 'a1', itemId: '3', uri: 'images/photo_1.jpg', isPrimary: false },
      { id: 'a2', itemId: '3', uri: 'images/detail/3/photo_2.jpg', isPrimary: true },
      { id: 'a3', itemId: '2', uri: 'images/photo_3.jpg', isPrimary: true },
    ],
  };
  const zip = makeZip({ 'backup.txt': Buffer.from(JSON.stringify(backup)), 'photo_1.jpg': jpg, 'images/detail/3/photo_2.jpg': jpg, 'photo_3.jpg': jpg });
  const up = await call('POST', '/api/import/findmystuff', zip, 'application/zip');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.summary.containers, 2);
  assert.equal(up.body.summary.images_found, 3);
  assert.equal((await call('GET', '/api/things?q=lego')).body.things.length, 0, 'eerst alleen controleren');
  const ap = await call('POST', `/api/import/findmystuff/${up.body.token}`, '{}', 'application/json');
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.stats.created_things, 5);
  assert.equal(ap.body.stats.imported_images, 3);
  const lego = (await call('GET', '/api/things?q=uitzoeken')).body.things[0];
  assert.deepEqual(lego.path.map((p) => p.name), ['Opslagruimte', '104']);
  assert.equal(lego.price, 125);
  assert.equal(lego.description, 'Diverse Lego');
  assert.equal(lego.image_ids.length, 2);
  assert.equal(lego.tag_ids.length, 1);
  const tp = (await call('GET', '/api/things?q=trivial')).body.things;
  assert.equal(tp.length, 2, 'dubbele namen blijven allebei bestaan');
  const tp2 = tp.find((t) => t.barcode);
  assert.equal(tp2.expires_on, '2025-11-19');
  assert.equal(tp2.quantity, 0);
  assert.match(tp2.notes, /Aankoopdatum: 2021-12-15/);
  assert.equal((await call('GET', '/api/images-without-thumb')).body.ids.length, 3);
  assert.equal((await call('POST', `/api/import/findmystuff/${up.body.token}`, '{}', 'application/json')).status, 404, 'token is eenmalig');
  assert.equal((await call('POST', '/api/import/findmystuff', Buffer.from('geen zip'), 'application/zip')).status, 400);

  // Aanvullen bij een eerdere import: niets dubbel aanmaken
  const up2 = await call('POST', '/api/import/findmystuff', zip, 'application/zip');
  const ap2 = (await call('POST', `/api/import/findmystuff/${up2.body.token}`, JSON.stringify({ attach_only: true }), 'application/json')).body.stats;
  assert.equal(ap2.created_things, 0);
  assert.equal(ap2.matched_things, 5, 'ook beide Trivial Pursuits');
  assert.equal(ap2.imported_images, 0, 'had al foto\'s');
  assert.equal((await call('GET', '/api/things?q=trivial')).body.things.length, 2);
  assert.ok(up2.body.already_imported, 'herkent een eerdere import');

  // Alles wissen: eerst bevestiging, dan back-up + leeg
  assert.equal((await call('POST', '/api/wipe', JSON.stringify({ confirm: 'nee' }), 'application/json')).status, 400);
  const w = await call('POST', '/api/wipe', JSON.stringify({ confirm: 'WISSEN' }), 'application/json');
  assert.equal(w.body.deleted_things, 5);
  assert.ok((await call('GET', '/api/backups')).body.backups.some((x) => x.name === w.body.backup));
  assert.equal((await call('GET', '/api/things?q=trivial')).body.things.length, 0);
  assert.equal((await call('GET', '/api/images-without-thumb')).body.ids.length, 0);
  const up3 = await call('POST', '/api/import/findmystuff', zip, 'application/zip');
  assert.equal(up3.body.already_imported, null, 'na wissen weer schoon');
});

test('Find my stuff: getallen of strings als id, kringverwijzing, doelcontainer, kapotte foto\'s en rechten', async () => {
  const jar = { admin: '', kim: '' };
  const as = (who) => async (method, url, body, ct) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', cookie: jar[who], ...(ct ? { 'content-type': ct } : {}) }, body });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const a = as('admin'), k = as('kim');
  const J = (o) => JSON.stringify(o);
  await a('POST', '/api/login', J({ username: 'steno', password: 'langgenoeg1' }), 'application/json');
  await a('POST', '/api/users', J({ username: 'kim', password: 'ookgoed123' }), 'application/json');
  await k('POST', '/api/login', J({ username: 'kim', password: 'ookgoed123' }), 'application/json');

  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const backup = {
    thingBackupList: [
      { id: '10', name: 'Zolder', isVisuallyStorage: true },
      { id: 11, name: 'Kerstdoos', parentId: '10', isVisuallyStorage: true },
      { id: '12', name: 'Kerstballen', parentId: 11, quantity: '24', price: '499' },
      { id: 13, name: 'Kip', parentId: 14 }, { id: 14, name: 'Ei', parentId: 13 }, // kring
      { id: 15, name: 'Wees', parentId: 999 }, // ouder bestaat niet
    ],
    tagBackupList: [{ id: '7', name: 'Kerst', colorId: 12 }],
    thingTagsBackupList: [{ thingId: 12, tagIds: [7] }, { thingId: '12', tagIds: ['7'] }],
    images: [
      { itemId: 12, uri: 'content://x/files/goed.jpg', isPrimary: true },
      { itemId: 12, uri: 'nep.jpg' }, // geen echte JPEG
      { itemId: 12, uri: 'bestaat-niet.jpg' },
    ],
  };
  const zip = makeZip({ 'backup.txt': Buffer.from('﻿' + J(backup)), 'files/goed.jpg': jpg, 'nep.jpg': Buffer.from('<svg onload=alert(1)>') });

  assert.equal((await k('POST', '/api/import/findmystuff', zip, 'application/zip')).status, 403, 'alleen de beheerder importeert');
  const doel = (await a('POST', '/api/things', J({ name: 'Uit Find my stuff', is_container: true }), 'application/json')).body.thing;
  const up = await a('POST', '/api/import/findmystuff', zip, 'application/zip');
  assert.equal(up.status, 200, J(up.body));
  assert.equal(up.body.summary.images_found, 2);
  assert.equal((await a('POST', `/api/import/findmystuff/${up.body.token}`, J({ parent_id: 999999 }), 'application/json')).status, 400, 'doel moet bestaan');
  const st = (await a('POST', `/api/import/findmystuff/${up.body.token}`, J({ parent_id: doel.id }), 'application/json')).body.stats;
  assert.equal(st.created_things, 6, 'kring en wees worden niet overgeslagen');
  assert.equal(st.imported_images, 1);
  assert.equal(st.skipped_images, 2, 'nep-foto en ontbrekende foto overgeslagen');

  const ballen = (await a('GET', '/api/things?q=kerstballen')).body.things[0];
  assert.deepEqual(ballen.path.map((p) => p.name), ['Uit Find my stuff', 'Zolder', 'Kerstdoos']);
  assert.equal(ballen.quantity, 24);
  assert.equal(ballen.price, 4.99);
  assert.equal(ballen.tag_ids.length, 1, 'tag één keer gekoppeld, ook al staat hij er dubbel in');
  assert.equal(ballen.image_ids.length, 1);
  const wees = (await a('GET', '/api/things?q=wees')).body.things[0];
  assert.deepEqual(wees.path.map((p) => p.name), ['Uit Find my stuff']);
  for (const n of ['kip', 'ei']) assert.equal((await a('GET', `/api/things?q=${n}`)).body.things.filter((t) => t.name.toLowerCase() === n).length, 1);
  const tag = (await a('GET', '/api/tags')).body.tags.find((t) => t.name === 'Kerst');
  assert.match(tag.color, /^#[0-9a-f]{6}$/, 'kleur-index buiten het palet geeft toch een geldige kleur');

  // Ongeldige uploads geven een nette 400.
  assert.equal((await a('POST', '/api/import/findmystuff', makeZip({ 'anders.txt': Buffer.from('x') }), 'application/zip')).status, 400);
  assert.equal((await a('POST', '/api/import/findmystuff', makeZip({ 'backup.txt': Buffer.from('{kapot') }), 'application/zip')).status, 400);
  assert.equal((await a('POST', '/api/import/findmystuff', makeZip({ 'backup.txt': Buffer.from(J({ thingBackupList: [] })) }), 'application/zip')).status, 400);
  assert.equal((await a('POST', '/api/import/findmystuff/../../etc', '{}', 'application/json')).status, 404);
});
