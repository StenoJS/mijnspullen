'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Nep-Home Assistant die webhooks opvangt.
const hooks = [];
const ha = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); });
});

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v02-'));
process.env.APP_URL = 'https://spullen.example';
let server, jobs, base;

test.before(async () => {
  await new Promise((r) => ha.listen(0, r));
  process.env.HA_WEBHOOK_URL = `http://127.0.0.1:${ha.address().port}/api/webhook/test`;
  ({ server, jobs } = require('../server/index.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections?.(); ha.close(); });

function client() {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('0.2: NFC, API-tokens, import, back-ups, Home Assistant', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' })).status, 200);

  // --- NFC-koppeling ---
  const kast = (await a('POST', '/api/things', { name: 'Kast', is_container: true, nfc_id: '04:A1:B2:C3' })).body.thing;
  assert.equal(kast.nfc_id, '04:a1:b2:c3');
  assert.equal((await a('GET', '/api/things?nfc=04:A1:B2:C3')).body.things[0].id, kast.id);

  // --- API-token: werkt zonder cookie en zonder CSRF-header ---
  const tok = (await a('POST', '/api/tokens', { name: 'Home Assistant' })).body;
  assert.match(tok.token, /^ms_/);
  const bearer = { authorization: `Bearer ${tok.token}` };
  let r = await fetch(base + '/api/summary', { headers: bearer });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/things', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Via token', parent_id: kast.id }) });
  assert.equal(r.status, 200, 'schrijven met token zonder X-Requested-With');
  assert.equal((await fetch(base + '/api/summary', { headers: { authorization: 'Bearer ms_ongeldigongeldigongeldig' } })).status, 401);
  assert.equal((await a('GET', '/api/tokens')).body.tokens[0].prefix, tok.token.slice(0, 10));
  assert.equal((await a('DELETE', `/api/tokens/${tok.id}`)).status, 200);
  assert.equal((await fetch(base + '/api/summary', { headers: bearer })).status, 401, 'ingetrokken token');

  // --- Home Assistant: bijna-op melding één keer, opnieuw na aanvullen ---
  const melk = (await a('POST', '/api/things', { name: 'Melk', quantity: 3, min_quantity: 1, parent_id: kast.id })).body.thing;
  await a('POST', `/api/things/${melk.id}/adjust`, { delta: -2 });
  await a('POST', `/api/things/${melk.id}/adjust`, { delta: -1 });
  await wait(100);
  let low = hooks.filter((x) => x.event === 'low_stock');
  assert.equal(low.length, 1, 'één melding, niet bij elke stap');
  assert.equal(low[0].items[0].location, 'Kast');
  assert.equal(low[0].items[0].url, `https://spullen.example/#/t/${melk.id}`);
  await a('POST', `/api/things/${melk.id}/adjust`, { delta: 5 });
  await a('POST', `/api/things/${melk.id}/adjust`, { delta: -5 });
  await wait(100);
  assert.equal(hooks.filter((x) => x.event === 'low_stock').length, 2);

  await a('POST', '/api/things', { name: 'Yoghurt', expires_on: new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) });
  const exp = (await a('POST', '/api/integrations/ha/expiring')).body.result;
  assert.equal(exp.count, 1);
  assert.equal(jobs.summary().low_count, 1);
  assert.equal((await a('POST', '/api/integrations/ha/test')).status, 200);

  // --- CSV-import (rondje via eigen export) ---
  const csv = '﻿naam;locatie;type;aantal;minimum;prijs;houdbaar_tot;tags\r\n'
    + 'Schroevendraaier;Huis > Schuur > Gereedschapskist;item;2;;"4,50";;Gereedschap|Klussen\r\n'
    + 'Boormachine;Huis > Schuur;item;1;;;;Gereedschap\r\n'
    + 'Lampjes;Huis > Zolder;item;10;2;;31-12-2030;\r\n'
    + 'Formule;Huis;item;1;;;;\r\n';
  const dry = (await a('POST', '/api/import.csv?dry=1', csv, { 'content-type': 'text/csv' })).body;
  assert.equal(dry.created_items, 4);
  assert.equal(dry.created_containers, 4);
  assert.equal((await a('GET', '/api/things?q=boormachine')).body.things.length, 0, 'proefimport schrijft niets');
  const imp = (await a('POST', '/api/import.csv', csv, { 'content-type': 'text/csv' })).body;
  assert.equal(imp.created_items, 4);
  assert.equal(imp.created_tags, 2);
  const sd = (await a('GET', '/api/things?q=schroevendraaier')).body.things[0];
  assert.deepEqual(sd.path.map((p) => p.name), ['Huis', 'Schuur', 'Gereedschapskist']);
  assert.equal(sd.price, 4.5);
  const lamp = (await a('GET', '/api/things?q=lampjes')).body.things[0];
  assert.equal(lamp.expires_on, '2030-12-31');
  const again = (await a('POST', '/api/import.csv', csv, { 'content-type': 'text/csv' })).body;
  assert.equal(again.created_items, 0);
  assert.equal(again.skipped, 4, 'dubbele regels overgeslagen');
  // export → import geeft dezelfde locaties terug
  const exported = (await a('GET', '/api/export.csv')).body.toString('utf8');
  assert.match(exported, /Huis > Schuur > Gereedschapskist/);

  // --- back-ups ---
  const bk = (await a('POST', '/api/backups')).body.name;
  const list = (await a('GET', '/api/backups')).body.backups;
  assert.ok(list.find((b) => b.name === bk));
  const dl = await a('GET', `/api/backups/${bk}`);
  assert.equal(dl.body.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await a('GET', '/api/backups/..%2Fmijn-spullen.db')).status, 404);
  const tar = await a('GET', '/api/backup.tar');
  assert.equal(tar.status, 200);
  assert.equal(tar.body.subarray(0, 15).toString(), 'mijn-spullen.db');
  assert.equal(tar.body.subarray(257, 262).toString(), 'ustar');
  assert.equal(tar.body.subarray(512, 527).toString(), 'SQLite format 3');
});
