'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

// Nep-Rebrickable met dezelfde kolommen als de echte download.
const SETS = 'set_num,name,year,theme_id,num_parts,img_url\n31077-1,Modular Sweet Surprises,2018,672,422,https://cdn.rebrickable.com/media/sets/31077-1.jpg\n60050-1,"Train Station, City",2014,56,423,https://cdn.rebrickable.com/media/sets/60050-1.jpg\n60050-2,Train Station (variant),2014,56,423,\n';
const THEMES = 'id,name,parent_id\n22,Creator,\n672,Creator 3-in-1,22\n52,City,\n56,Trains,52\n';
let hits = 0;
const rb = http.createServer((req, res) => {
  hits++;
  const body = req.url.endsWith('/sets.csv.gz') ? SETS : req.url.endsWith('/themes.csv.gz') ? THEMES : null;
  if (!body) { res.statusCode = 404; return res.end(); }
  res.end(zlib.gzipSync(body));
});

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lego-'));
let server, base;
test.before(async () => {
  await new Promise((r) => rb.listen(0, r));
  process.env.LEGO_DATA_URL = `http://127.0.0.1:${rb.address().port}`;
  ({ server } = require('../server/index.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections?.(); rb.close(); });

test('Lego-sets op nummer', async () => {
  let cookie = '';
  const a = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' });
  const r = await a('GET', '/api/lego/31077');
  assert.equal(r.status, 200);
  assert.equal(r.body.set.name, 'Modular Sweet Surprises');
  assert.equal(r.body.set.description, 'LEGO · Creator › Creator 3-in-1 · 2018 · 422 onderdelen');
  assert.equal((await a('GET', '/api/lego/60050-2')).body.set.name, 'Train Station (variant)');
  assert.equal((await a('GET', '/api/lego/99999')).status, 404);
  const before = hits;
  await a('GET', '/api/lego/60050');
  assert.equal(hits, before, 'database wordt niet opnieuw opgehaald');

  const box = (await a('POST', '/api/things', { name: 'Lego boxen', is_container: true })).body.thing;
  const t1 = (await a('POST', '/api/things', { name: '31077', parent_id: box.id })).body.thing;
  const t2 = (await a('POST', '/api/things', { name: 'Lego 60050', parent_id: box.id, description: 'Eigen notitie' })).body.thing;
  await a('POST', '/api/things', { name: '12345', parent_id: box.id }); // bestaat niet
  await a('POST', '/api/things', { name: 'Kast', parent_id: box.id });
  const c = (await a('GET', '/api/lego-candidates')).body.candidates;
  assert.equal(c.length, 3);
  assert.equal(c.find((x) => x.name === '12345').set, null);
  const done = (await a('POST', '/api/lego-apply', { ids: c.map((x) => x.id) })).body;
  assert.equal(done.updated, 2);
  const x1 = (await a('GET', `/api/things/${t1.id}`)).body.thing;
  assert.equal(x1.name, '31077 Modular Sweet Surprises');
  assert.match(x1.description, /Creator 3-in-1/);
  assert.deepEqual(x1.tag_ids, [done.tag_id]);
  const x2 = (await a('GET', `/api/things/${t2.id}`)).body.thing;
  assert.equal(x2.name, '60050 Train Station, City');
  assert.equal(x2.description, 'Eigen notitie', 'eigen omschrijving blijft staan');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'lego', 'sets.csv.gz')));
});
