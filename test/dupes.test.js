'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const hooks = [];
const ha = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); });
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dupes-'));
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

test('0.4.1: dubbelen vinden en samenvoegen', async () => {
  const a = client();
  await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' });
  const post = async (b) => (await a('POST', '/api/things', b)).body.thing;
  const tag = (await a('POST', '/api/tags', { name: 'Zuivel' })).body.id;
  // Drie keer dezelfde import: alleen de derde heeft een foto en een tag.
  const copies = [];
  for (let i = 0; i < 3; i++) {
    const huis = await post({ name: 'Huis', is_container: true });
    const kast = await post({ name: 'Kast', is_container: true, parent_id: huis.id });
    const melk = await post({ name: 'Melk', parent_id: kast.id, quantity: 2, barcode: i === 0 ? '8710000000001' : null });
    copies.push({ huis, kast, melk });
  }
  const third = copies[2];
  await a('PATCH', `/api/things/${third.melk.id}`, { tag_ids: [tag], notes: 'Halfvol' });
  await a('POST', `/api/things/${third.melk.id}/images`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { 'content-type': 'image/jpeg' });
  // Eén echte losse dubbel in dezelfde kast, en een barcode-dubbel met een andere naam.
  const los = await post({ name: 'Kast', is_container: true });
  await post({ name: 'Yoghurt', parent_id: los.id, barcode: '8710000000001' });

  const d = (await a('GET', '/api/duplicates')).body;
  const names = d.groups.filter((g) => g.kind === 'name');
  assert.equal(names.length, 1, 'alleen de bovenste groep (Huis); Kast en Melk daaronder vallen mee');
  assert.equal(names[0].name, 'Huis');
  assert.equal(names[0].keep_id, third.huis.id, 'voorstel: de kopie met foto\'s');
  assert.equal(d.hidden, 2);
  assert.equal(d.groups.filter((g) => g.kind === 'barcode').length, 1);

  const r = (await a('POST', '/api/duplicates/merge', { keep_id: third.huis.id, drop_ids: [copies[0].huis.id, copies[1].huis.id] })).body;
  assert.equal(r.merged, 2);
  assert.equal(r.trash_ids.length, 2);
  const kids = (await a('GET', `/api/things?parent=${third.kast.id}`)).body.things;
  assert.equal(kids.length, 1, 'één Melk over');
  const melk = kids[0];
  assert.equal(melk.id, third.melk.id);
  assert.equal(melk.quantity, 2, 'aantallen niet opgeteld bij import-dubbelen');
  assert.equal(melk.barcode, '8710000000001', 'lege velden aangevuld');
  assert.equal(melk.image_ids.length, 1);
  assert.deepEqual(melk.tag_ids, [tag]);
  assert.equal((await a('GET', '/api/things?parent=root')).body.things.filter((t) => t.name === 'Huis').length, 1);
  assert.equal((await a('GET', '/api/duplicates')).body.groups.filter((g) => g.kind === 'name').length, 0);

  // Terugzetten uit de prullenbak geeft de (lege) kopie terug.
  assert.equal((await a('POST', `/api/trash/${r.trash_ids[0]}/restore`)).status, 200);

  // Losse items samenvoegen met optellen.
  const k2 = await post({ name: 'Doos', is_container: true });
  const s1 = await post({ name: 'Schroeven', parent_id: k2.id, quantity: 10 });
  const s2 = await post({ name: 'schroeven ', parent_id: k2.id, quantity: 5 });
  const g = (await a('GET', '/api/duplicates')).body.groups.find((x) => x.name === 'Schroeven');
  assert.ok(g);
  await a('POST', '/api/duplicates/merge', { keep_id: s1.id, drop_ids: [s2.id], sum_quantity: true });
  assert.equal((await a('GET', `/api/things/${s1.id}`)).body.thing.quantity, 15);

  // Alles in één keer (beheerder): de herstelde Huis-kopie verdwijnt weer.
  const all = (await a('POST', '/api/duplicates/merge-all', {})).body;
  assert.ok(all.merged >= 1);
  assert.equal((await a('GET', '/api/duplicates')).body.groups.filter((x) => x.kind === 'name').length, 0);
});
