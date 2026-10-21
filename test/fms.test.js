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
    thingTagsBackupList: [{ thingId: 3, tagIds: [1] }],
    images: [
      { id: 1, itemId: 3, uri: 'photo_1.jpg', isPrimary: false },
      { id: 2, itemId: 3, uri: 'images/detail/3/photo_2.jpg', isPrimary: true },
      { id: 3, itemId: 2, uri: 'content://x/files/photo_3.jpg', isPrimary: true },
    ],
  };
  const zip = makeZip({ 'backup.txt': Buffer.from(JSON.stringify(backup)), 'photo_1.jpg': jpg, 'images/detail/3/photo_2.jpg': jpg, 'images/detail/2/photo_3.jpg': jpg });
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
});
