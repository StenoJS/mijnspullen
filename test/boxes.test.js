'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const SETS = 'set_num,name,year,theme_id,num_parts,img_url\n10246-1,Detective\'s Office,2015,1,2262,\n10211-1,Grand Emporium,2010,1,2182,\n31077-1,Modular Sweet Surprises,2018,1,422,\n21338-1,A-Frame Cabin,2023,1,2082,\n10312-1,Jazz Club,2023,1,2899,\n';
const rb = http.createServer((req, res) => res.end(zlib.gzipSync(req.url.includes('sets') ? SETS : 'id,name,parent_id\n1,Icons,\n')));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-boxes-'));
let server, base;
test.before(async () => {
  await new Promise((r) => rb.listen(0, r));
  process.env.LEGO_DATA_URL = `http://127.0.0.1:${rb.address().port}`;
  ({ server } = require('../server/index.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections?.(); rb.close(); });

test('dozenlijst importeren zonder dubbelen', async () => {
  let cookie = '';
  const a = async (method, url, body, extra = {}) => {
    const raw = typeof body === 'string';
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' });
  const post = async (x) => (await a('POST', '/api/things', x)).body.thing;
  const zolder = await post({ name: 'Zolder', is_container: true });
  const b101 = await post({ name: 'Box 101', is_container: true, parent_id: zolder.id });
  await post({ name: '10246 Detective\'s Office', parent_id: b101.id });
  const kast = await post({ name: 'Kast', is_container: true });
  await post({ name: '31077', parent_id: kast.id }); // staat al ergens anders

  const csv = ';Box-nummer;Inhoud\n;101;10246;10211\nx;104;Lego uitzoeken, halfvol;31077;2x 21338 (cabin wood)\n;201;10312;2xnieuw\n;114\n';
  const p = (await a('POST', '/api/import/boxes', csv, { 'content-type': 'text/csv', 'x-filename': 'dozen.csv' })).body;
  assert.equal(p.boxes.length, 4);
  assert.equal(p.default_parent.id, zolder.id);
  const [x101, x104, x201] = p.boxes;
  assert.equal(x101.existing.id, b101.id);
  assert.deepEqual(x101.items.map((i) => [i.code, i.status]), [['10246', 'exists'], ['10211', 'new']]);
  assert.equal(x101.items[1].name, '10211 Grand Emporium');
  assert.equal(x104.existing, null);
  assert.equal(x104.mark, 'x');
  assert.equal(x104.items.find((i) => i.code === '31077').status, 'elsewhere');
  assert.equal(x104.items.find((i) => i.code === '21338').quantity, 2);
  assert.equal(x201.items[0].quantity, 2);
  assert.deepEqual(x201.notes, ['nieuw']);

  // Alleen de nieuwe dingen aanmaken (wat de app standaard aanvinkt).
  const sel = p.boxes.map((b) => ({ number: b.number, existing_id: b.existing && b.existing.id, notes: b.notes, items: b.items.filter((i) => i.status === 'new') }));
  const r = (await a('POST', '/api/import/boxes/apply', { parent_id: zolder.id, boxes: sel })).body;
  assert.equal(r.boxes, 2, 'Box 104 en 201 (114 is leeg en wordt overgeslagen)');
  assert.equal(r.items, 4); // 10211, "Lego uitzoeken, halfvol", 21338, 10312
  const inZolder = (await a('GET', `/api/things?parent=${zolder.id}`)).body.things.map((t) => t.name).sort();
  assert.deepEqual(inZolder, ['Box 101', 'Doos 104', 'Doos 201']);
  // Nog een keer: niets nieuws meer.
  const again = (await a('POST', '/api/import/boxes', csv, { 'content-type': 'text/csv' })).body;
  assert.equal(again.boxes.flatMap((b) => b.items).filter((i) => i.status === 'new').length, 0);
});
