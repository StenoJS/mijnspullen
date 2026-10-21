'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const hooks = [];
const ha = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); });
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v04-'));
let server, jobs, base;
test.before(async () => {
  await new Promise((r) => ha.listen(0, r));
  process.env.HA_WEBHOOK_URL = `http://127.0.0.1:${ha.address().port}/hook`;
  ({ server, jobs } = require('../server/index.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections?.(); ha.close(); });

function client() {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (isRaw ? body : JSON.stringify(body)) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
}

test('0.4: prullenbak, meerdere tegelijk, uitlenen, boodschappen', async () => {
  const a = client();
  await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' });
  const post = async (b) => (await a('POST', '/api/things', b)).body.thing;
  const huis = await post({ name: 'Huis', is_container: true });
  const schuur = await post({ name: 'Schuur', is_container: true, parent_id: huis.id });
  const zolder = await post({ name: 'Zolder', is_container: true, parent_id: huis.id });
  const boor = await post({ name: 'Boormachine', parent_id: schuur.id });
  const hamer = await post({ name: 'Hamer', parent_id: schuur.id });
  const koffie = await post({ name: 'Koffie', parent_id: zolder.id, quantity: 1, min_quantity: 2 });
  const tag = (await a('POST', '/api/tags', { name: 'Gereedschap' })).body.id;
  await a('PATCH', `/api/things/${boor.id}`, { tag_ids: [tag] });
  const img = (await a('POST', `/api/things/${boor.id}/images`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { 'content-type': 'image/jpeg' })).body.image;

  // --- prullenbak: hele subboom weg en volledig terug ---
  assert.equal((await a('DELETE', `/api/things/${schuur.id}`)).status, 200);
  assert.equal((await a('GET', '/api/things?q=boormachine')).body.things.length, 0);
  const trash = (await a('GET', '/api/trash')).body.items;
  assert.equal(trash.length, 1);
  assert.equal(trash[0].item_count, 3);
  assert.equal((await a('GET', `/api/images/${img.id}`)).status, 404);
  const back = (await a('POST', `/api/trash/${trash[0].id}/restore`)).body.thing;
  assert.equal(back.id, schuur.id, 'zelfde id terug');
  const boor2 = (await a('GET', `/api/things/${boor.id}`)).body.thing;
  assert.deepEqual(boor2.path.map((p) => p.name), ['Huis', 'Schuur']);
  assert.deepEqual(boor2.tag_ids, [tag]);
  assert.equal((await a('GET', `/api/images/${img.id}`)).status, 200, 'foto ook terug');
  assert.equal((await a('GET', '/api/trash')).body.items.length, 0);

  // herstellen als de oude plek weg is → hoofdniveau
  await a('DELETE', `/api/things/${hamer.id}`);
  const hamerTrash = (await a('GET', '/api/trash')).body.items[0];
  await a('DELETE', `/api/things/${schuur.id}`);
  const h2 = (await a('POST', `/api/trash/${hamerTrash.id}/restore`)).body.thing;
  assert.equal(h2.parent_id, null);
  assert.equal((await a('DELETE', '/api/trash')).body.purged, 1, 'prullenbak legen');

  // --- meerdere tegelijk ---
  const k2 = await post({ name: 'Thee', parent_id: zolder.id });
  let r = await a('POST', '/api/things/bulk', { ids: [h2.id, k2.id], action: 'move', parent_id: huis.id });
  assert.equal(r.body.done, 2);
  assert.equal((await a('GET', `/api/things?parent=${huis.id}`)).body.things.length, 3);
  assert.equal((await a('POST', '/api/things/bulk', { ids: [huis.id], action: 'move', parent_id: zolder.id })).body.done, 0, 'niet in zichzelf');
  r = await a('POST', '/api/things/bulk', { ids: [h2.id, k2.id], action: 'tag', tag_id: tag });
  assert.equal(r.body.done, 2);
  assert.equal((await a('GET', `/api/things?tag=${tag}`)).body.things.length, 2);
  // container + kind tegelijk verwijderen → één prullenbak-item
  r = await a('POST', '/api/things/bulk', { ids: [zolder.id, koffie.id], action: 'delete' });
  assert.equal(r.body.done, 1);
  assert.equal((await a('GET', '/api/trash')).body.items[0].item_count, 2);
  await a('POST', `/api/trash/${(await a('GET', '/api/trash')).body.items[0].id}/restore`);

  // --- uitlenen ---
  r = await a('PATCH', `/api/things/${h2.id}`, { lent_to: 'Buurman Henk', lent_due: '2020-01-01' });
  assert.equal(r.body.thing.lent_to, 'Buurman Henk');
  assert.ok(r.body.thing.lent_at);
  assert.equal((await a('GET', '/api/things?lent=1')).body.things.length, 1);
  assert.equal((await a('GET', '/api/stats')).body.stats.lent, 1);
  const od = await jobs.notifyOverdueLending();
  assert.equal(od.count, 1);
  assert.equal(hooks.at(-1).event, 'lend_overdue');
  assert.equal((await jobs.notifyOverdueLending()).count, 0, 'maar één keer');
  r = await a('PATCH', `/api/things/${h2.id}`, { lent_to: '' });
  assert.equal(r.body.thing.lent_to, null);
  assert.equal(r.body.thing.lent_due, null);

  // --- boodschappen ---
  await a('PATCH', `/api/things/${k2.id}`, { on_list: true });
  let list = (await a('GET', '/api/things?shopping=1')).body.things.map((t) => t.name).sort();
  assert.deepEqual(list, ['Koffie', 'Thee']);
  r = await a('POST', '/api/shopping/send');
  assert.equal(r.body.sent, 2);
  const shop = hooks.at(-1);
  assert.equal(shop.event, 'shopping');
  assert.equal(shop.items.find((i) => i.name === 'Koffie').need, 2);
  r = await a('POST', `/api/things/${koffie.id}/bought`, { quantity: 3 });
  assert.equal(r.body.thing.quantity, 4);
  await a('POST', `/api/things/${k2.id}/bought`, { quantity: 1 });
  assert.equal((await a('GET', '/api/things?shopping=1')).body.things.length, 0);
});
