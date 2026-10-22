'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Nep-Home Assistant: image_upload + ai_task.generate_data.
const calls = [];
const ha = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    calls.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/image/upload') return res.end(JSON.stringify({ id: 'abc123', name: 'x.jpg' }));
    if (req.url.startsWith('/api/services/ai_task/generate_data')) {
      const ent = JSON.parse(body).entity_id;
      if (ent === 'ai_task.druk') { res.statusCode = 500; return res.end('Error: 503 UNAVAILABLE. This model is currently experiencing high demand.'); }
      if (ent === 'ai_task.kapot') { res.statusCode = 400; return res.end('Entity not found'); }
      return res.end(JSON.stringify({ changed_states: [], service_response: { conversation_id: 'c', data: { name: 'Bosch accuboormachine', description: 'Groene accuboor met koffer.', tags: 'gereedschap, Elektrisch', quantity: 1, is_container: false } } }));
    }
    if (req.url === '/api/states/ai_task.google_ai_task') return res.end(JSON.stringify({ attributes: { friendly_name: 'Google AI Task' } }));
    res.statusCode = 404; res.end('{}');
  });
});

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ai-'));
let server, base;
test.before(async () => {
  await new Promise((r) => ha.listen(0, r));
  process.env.HA_URL = `http://127.0.0.1:${ha.address().port}`;
  process.env.HA_TOKEN = 'testtoken';
  process.env.AI_RETRY_DELAYS = '10,10';
  ({ server } = require('../server/index.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); server.closeAllConnections?.(); ha.close(); ha.closeAllConnections?.(); });

test('AI-fotoherkenning via Home Assistant', async () => {
  let cookie = '';
  const a = async (method, url, body, extra = {}) => {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'mijn-spullen', ...(cookie ? { cookie } : {}), ...(body && !isRaw ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? (isRaw ? body : JSON.stringify(body)) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await a('POST', '/api/setup', { username: 'steno', display_name: 'Steno', password: 'langgenoeg1' });
  assert.equal((await a('GET', '/api/me')).body.ai, true);
  const tag = (await a('POST', '/api/tags', { name: 'Gereedschap' })).body.id;
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const r = await a('POST', '/api/ai/recognize', jpg, { 'content-type': 'image/jpeg' });
  assert.equal(r.status, 200);
  assert.equal(r.body.suggestion.name, 'Bosch accuboormachine');
  assert.deepEqual(r.body.suggestion.tag_ids, [tag]);
  assert.deepEqual(r.body.suggestion.new_tags, ['Elektrisch']);
  const up = calls.find((c) => c.url === '/api/image/upload');
  assert.equal(up.auth, 'Bearer testtoken');
  assert.match(up.type, /multipart\/form-data/);
  const gen = JSON.parse(calls.find((c) => c.url.startsWith('/api/services/ai_task')).body);
  assert.equal(gen.entity_id, 'ai_task.google_ai_task');
  assert.equal(gen.attachments[0].media_content_id, 'media-source://image_upload/abc123');
  assert.match(gen.instructions, /Gereedschap/);

  // Met een opgeslagen foto
  const t = (await a('POST', '/api/things', { name: 'Ding' })).body.thing;
  const im = (await a('POST', `/api/things/${t.id}/images`, jpg, { 'content-type': 'image/jpeg' })).body.image;
  assert.equal((await a('POST', `/api/ai/recognize?image_id=${im.id}`)).status, 200);
  assert.equal((await a('POST', '/api/ai/recognize?image_id=9999')).status, 404);

  // Token in de app zelf (Meer → Koppelingen) gaat voor de omgeving; het token komt nooit terug naar de browser.
  const info = (await a('PUT', '/api/integrations/ai', { token: 'Bearer dbtoken' })).body;
  assert.equal(info.token_set, true);
  assert.ok(!JSON.stringify(info).includes('dbtoken'));
  assert.equal((await a('POST', '/api/integrations/ai/test')).body.name, 'Google AI Task');
  assert.equal(calls.at(-1).auth, 'Bearer dbtoken');
  assert.equal((await a('PUT', '/api/integrations/ai', { entity: 'light.keuken' })).status, 400);

  // Drukte: eerst opnieuw proberen, dan de volgende entiteit; alleen drukte → 503 met nette melding.
  await a('PUT', '/api/integrations/ai', { entity: 'ai_task.druk, ai_task.google_ai_task' });
  let n = calls.length;
  let rr = await a('POST', '/api/ai/recognize', jpg, { 'content-type': 'image/jpeg' });
  assert.equal(rr.status, 200);
  assert.equal(calls.slice(n).filter((c) => c.url.startsWith('/api/services')).length, 4, '3x druk + 1x goed');
  await a('PUT', '/api/integrations/ai', { entity: 'ai_task.druk' });
  rr = await a('POST', '/api/ai/recognize', jpg, { 'content-type': 'image/jpeg' });
  assert.equal(rr.status, 503);
  assert.match(rr.body.error, /overbelast/);
  await a('PUT', '/api/integrations/ai', { entity: 'ai_task.kapot' });
  n = calls.length;
  rr = await a('POST', '/api/ai/recognize', jpg, { 'content-type': 'image/jpeg' });
  assert.equal(rr.status, 502);
  assert.equal(calls.slice(n).filter((c) => c.url.startsWith('/api/services')).length, 1, 'echte fout: niet herhalen');
});
