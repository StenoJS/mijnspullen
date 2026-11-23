'use strict';
// 0.10 (release candidate voor 1.0): tags, veegacties en de beveiligingsronde.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v10-'));
const { server, db } = require('../server/index.js');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); server.closeAllConnections?.(); });

function client() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (isRaw ? body : JSON.stringify(body)) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, headers: res.headers, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  call.cookie = () => cookie;
  return call;
}
const admin = client();
const member = client();
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('setup en een tweede gebruiker', async () => {
  assert.equal((await admin('POST', '/api/setup', { username: 'steno', password: 'langgenoeg1' })).status, 200);
  assert.equal((await admin('POST', '/api/users', { username: 'kim', password: 'ookgoed123' })).status, 200);
  assert.equal((await member('POST', '/api/login', { username: 'kim', password: 'ookgoed123' })).status, 200);
});

test('tags: direct opslaan met PATCH tag_ids, vervangen, leegmaken en onbekende id\'s negeren', async () => {
  const lego = (await admin('POST', '/api/tags', { name: 'Lego', color: '#e53935' })).body.id;
  const trein = (await admin('POST', '/api/tags', { name: 'Treinen', parent_id: lego })).body.id;
  const kerst = (await admin('POST', '/api/tags', { name: 'Kerst' })).body.id;
  const t = (await admin('POST', '/api/things', { name: 'Stoomtrein 10194' })).body.thing;
  assert.deepEqual(t.tag_ids, []);

  let r = (await admin('PATCH', `/api/things/${t.id}`, { tag_ids: [trein, 99999, 'x', trein] })).body.thing;
  assert.deepEqual(r.tag_ids, [trein], 'dubbel en onbekend vallen weg');
  assert.equal(r.version, t.version + 1, 'eigen wijziging telt één versie op');
  assert.equal(r.name, 'Stoomtrein 10194', 'de rest blijft staan');

  r = (await admin('PATCH', `/api/things/${t.id}`, { tag_ids: [kerst, trein] })).body.thing;
  assert.deepEqual([...r.tag_ids].sort(), [kerst, trein].sort());

  // Filter op de hoofdtag neemt subtags mee; zoeken vindt ook op tagnaam.
  assert.ok((await admin('GET', `/api/things?tag=${lego}`)).body.things.some((x) => x.id === t.id));
  assert.ok((await admin('GET', '/api/things?q=treinen')).body.things.some((x) => x.id === t.id));
  assert.equal((await admin('GET', '/api/tags')).body.tags.find((g) => g.id === trein).use_count, 1);

  r = (await admin('PATCH', `/api/things/${t.id}`, { tag_ids: [] })).body.thing;
  assert.deepEqual(r.tag_ids, []);
  assert.equal((await admin('PATCH', `/api/things/${t.id}`, { tag_ids: 'Lego' })).status, 400);

  // Verouderde versie meesturen geeft een conflict (iemand anders wijzigde het net).
  assert.equal((await admin('PATCH', `/api/things/${t.id}`, { name: 'x', version: t.version })).status, 409);
});

test('tags: geen kringen, verwijderen ontkoppelt, bulk tag/untag', async () => {
  const a = (await admin('POST', '/api/tags', { name: 'A' })).body.id;
  const b = (await admin('POST', '/api/tags', { name: 'B', parent_id: a })).body.id;
  assert.equal((await admin('PATCH', `/api/tags/${a}`, { parent_id: b })).status, 400, 'A onder B onder A kan niet');
  assert.equal((await admin('PATCH', `/api/tags/${a}`, { parent_id: a })).status, 400);
  assert.equal((await admin('POST', '/api/tags', { name: 'Kleur', color: 'rood' })).status, 400);

  const x = (await admin('POST', '/api/things', { name: 'Ding 1' })).body.thing;
  const y = (await admin('POST', '/api/things', { name: 'Ding 2', tag_ids: [b] })).body.thing;
  assert.equal((await admin('POST', '/api/things/bulk', { action: 'tag', tag_id: a, ids: [x.id, y.id] })).body.done, 2);
  assert.equal((await admin('POST', '/api/things/bulk', { action: 'tag', tag_id: a, ids: [x.id, y.id] })).body.done, 0, 'al getagd: niets te doen');
  assert.equal((await admin('POST', '/api/things/bulk', { action: 'untag', tag_id: a, ids: [x.id] })).body.done, 1);
  assert.equal((await admin('POST', '/api/things/bulk', { action: 'tag', tag_id: 99999, ids: [x.id] })).status, 400);

  await admin('DELETE', `/api/tags/${b}`);
  assert.deepEqual((await admin('GET', `/api/things/${y.id}`)).body.thing.tag_ids, [a], 'verwijderde tag is van het ding af');
});

test('vegen: Op 0 en Ongedaan maken', async () => {
  const t = (await admin('POST', '/api/things', { name: 'Batterijen AA', quantity: 7, min_quantity: 2 })).body.thing;
  let r = (await admin('POST', `/api/things/${t.id}/adjust`, { delta: -t.quantity })).body.thing;
  assert.equal(r.quantity, 0);
  assert.ok((await admin('GET', '/api/things?shopping=1')).body.things.some((x) => x.id === t.id), 'staat nu op de lijst (onder de drempel)');
  r = (await admin('POST', `/api/things/${t.id}/adjust`, { delta: 7 })).body.thing;
  assert.equal(r.quantity, 7, 'ongedaan maken zet het oude aantal terug');
  r = (await admin('POST', `/api/things/${t.id}/adjust`, { delta: -100 })).body.thing;
  assert.equal(r.quantity, 0, 'nooit onder nul');
  assert.equal((await admin('POST', `/api/things/${t.id}/adjust`, { delta: 0 })).status, 400);
  assert.equal((await admin('POST', '/api/things/99999/adjust', { delta: 1 })).status, 404);
  const act = (await admin('GET', '/api/activity?limit=5')).body.activity;
  assert.match(act[0].summary, /van 7 naar 0/);
});

test('vegen: Verwijderen en terugzetten met tags, foto en inhoud', async () => {
  const tag = (await admin('POST', '/api/tags', { name: 'Gereedschap' })).body.id;
  const doos = (await admin('POST', '/api/things', { name: 'Doos 7', is_container: true })).body.thing;
  const boor = (await admin('POST', '/api/things', { name: 'Boor', parent_id: doos.id, tag_ids: [tag] })).body.thing;
  const img = (await admin('POST', `/api/things/${boor.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;

  // Een gewoon lid mag ook vegen/verwijderen en terugzetten (gedeelde inventaris).
  const del = (await member('DELETE', `/api/things/${doos.id}`)).body;
  assert.ok(del.trash_id);
  assert.equal((await admin('GET', `/api/things/${boor.id}`)).status, 404, 'inhoud gaat mee naar de prullenbak');
  const item = (await admin('GET', '/api/trash')).body.items.find((i) => i.id === del.trash_id);
  assert.equal(item.item_count, 2);
  assert.equal(item.deleted_by, 'kim');

  assert.equal((await member('DELETE', `/api/trash/${del.trash_id}`)).status, 403, 'definitief weggooien is voor de beheerder');
  const back = (await member('POST', `/api/trash/${del.trash_id}/restore`)).body.thing;
  assert.equal(back.id, doos.id);
  const b2 = (await admin('GET', `/api/things/${boor.id}`)).body.thing;
  assert.deepEqual(b2.tag_ids, [tag]);
  assert.deepEqual(b2.image_ids, [img.id]);
  assert.equal((await admin('GET', `/api/images/${img.id}`)).status, 200, 'foto komt terug uit de prullenbak');
  assert.equal((await admin('POST', `/api/trash/${del.trash_id}/restore`)).status, 404, 'maar één keer');
});

test('beveiliging: alleen echte foto\'s', async () => {
  const t = (await admin('POST', '/api/things', { name: 'Fotoding' })).body.thing;
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal((await admin('POST', `/api/things/${t.id}/images`, html, { 'content-type': 'image/png' })).status, 415);
  assert.equal((await admin('POST', `/api/things/${t.id}/images`, PNG, { 'content-type': 'image/jpeg' })).status, 415, 'type moet kloppen met de inhoud');
  assert.equal((await admin('POST', `/api/things/${t.id}/images`, PNG, { 'content-type': 'image/png' })).status, 200);
  const im = (await admin('POST', `/api/things/${t.id}/images`, JPEG, { 'content-type': 'image/jpeg' })).body.image;
  assert.equal((await admin('PUT', `/api/images/${im.id}/thumb`, html, { 'content-type': 'image/jpeg' })).status, 415);
  assert.equal((await admin('PUT', `/api/images/${im.id}/thumb`, PNG, { 'content-type': 'image/png' })).status, 200, 'thumbnail mag een ander formaat zijn');
  assert.equal((await admin('PUT', '/api/me/avatar', html, { 'content-type': 'image/jpeg' })).status, 415);
  assert.equal((await admin('PUT', '/api/me/avatar', JPEG, { 'content-type': 'image/jpeg' })).status, 200);
  const g = await admin('GET', `/api/images/${im.id}`);
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
});

test('beveiliging: rechten, CSRF en sessies', async () => {
  // Beheerdersfuncties zijn dicht voor een gewoon lid.
  for (const [m, u] of [['GET', '/api/backups'], ['POST', '/api/backups'], ['GET', '/api/backup.tar'], ['POST', '/api/users'], ['PATCH', '/api/users/1'],
    ['POST', '/api/wipe'], ['POST', '/api/import/findmystuff'], ['PUT', '/api/integrations/ai'], ['DELETE', '/api/trash'], ['POST', '/api/duplicates/merge-all']]) {
    assert.equal((await member(m, u, m === 'GET' ? undefined : {})).status, 403, `${m} ${u}`);
  }
  // Zonder sessie: niets.
  const anon = client();
  for (const u of ['/api/things', '/api/me', '/api/users', '/api/images/1', '/api/export.csv', '/api/events']) assert.equal((await anon('GET', u)).status, 401, u);
  // Schrijven zonder de eigen header (bijv. vanaf een andere site) mag niet.
  const res = await fetch(base + '/api/things', { method: 'POST', headers: { cookie: admin.cookie(), 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
  // Tweede setup kan niet meer.
  assert.equal((await anon('POST', '/api/setup', { username: 'hacker', password: 'langgenoeg1' })).status, 403);
  // API-tokens zijn van jezelf: een ander kan ze niet zien of intrekken.
  const tok = (await admin('POST', '/api/tokens', { name: 'HA' })).body;
  assert.equal((await member('GET', '/api/tokens')).body.tokens.length, 0);
  await member('DELETE', `/api/tokens/${tok.id}`);
  assert.equal((await admin('GET', '/api/tokens')).body.tokens.length, 1);
  // Een token kan geen wachtwoord wijzigen of nieuwe tokens maken.
  const bearer = { authorization: `Bearer ${tok.token}` };
  assert.equal((await fetch(base + '/api/me/password', { method: 'POST', headers: bearer, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/tokens', { method: 'POST', headers: bearer, body: '{"name":"x"}' })).status, 403);
  // Geblokkeerd lid: sessie direct weg.
  const kim = db.prepare("SELECT id FROM users WHERE username = 'kim'").get().id;
  assert.equal((await admin('PATCH', `/api/users/${kim}`, { disabled: true })).status, 200);
  assert.equal((await member('GET', '/api/me')).status, 401);
  assert.equal((await member('POST', '/api/login', { username: 'kim', password: 'ookgoed123' })).status, 401);
  await admin('PATCH', `/api/users/${kim}`, { disabled: false });
  // Wachtwoordregels.
  assert.equal((await admin('POST', '/api/users', { username: 'kort', password: 'kort' })).status, 400);
  assert.equal((await admin('POST', '/api/users', { username: 'lang', password: 'x'.repeat(300) })).status, 400);
});

test('beveiliging: login rate limit per naam en per IP', async () => {
  const anon = client();
  for (let i = 0; i < 10; i++) assert.equal((await anon('POST', '/api/login', { username: 'steno', password: 'fout' + i })).status, 401);
  assert.equal((await anon('POST', '/api/login', { username: 'steno', password: 'langgenoeg1' })).status, 429, 'ook met het goede wachtwoord even geblokkeerd');
  // Steeds een andere (niet-bestaande) naam proberen loopt vast op de IP-grens.
  let last;
  for (let i = 0; i < 25; i++) last = (await anon('POST', '/api/login', { username: `naam${i}`, password: 'fout' })).status;
  assert.equal(last, 429);
});

test('statische bestanden: geen pad buiten public/ en nette fout bij een kapot adres', async () => {
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.notEqual((await fetch(base + '/..%2fpackage.json')).status, 200);
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});
