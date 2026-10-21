'use strict';
// Fotoherkenning via Home Assistant: foto uploaden (image_upload), ai_task.generate_data met de foto als bijlage,
// daarna de foto in HA weer opruimen. Zo gebruikt de app de AI die al in HA is ingesteld (bijv. Google Gemini).
// Token en entiteit staan in de database (Meer → Koppelingen) of in de omgeving (HA_TOKEN, HA_AI_ENTITY).
const HA_URL = (process.env.HA_URL || (() => { try { return new URL(process.env.HA_WEBHOOK_URL).origin; } catch { return ''; } })()).replace(/\/+$/, '');
const DEFAULT_ENTITY = 'ai_task.google_ai_task';
let getSetting = () => null;
const token = () => getSetting('ha_token') || process.env.HA_TOKEN || '';
const entity = () => getSetting('ha_ai_entity') || process.env.HA_AI_ENTITY || DEFAULT_ENTITY;
const configured = () => !!(HA_URL && token());

async function haFetch(pathname, opts = {}, timeoutMs = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(HA_URL + pathname, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.headers || {}) }, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`Home Assistant gaf ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Home Assistant reageerde niet op tijd' : e.message);
  } finally { clearTimeout(timer); }
}

// image_upload heeft geen REST-delete; via de WebSocket-API opruimen (best effort).
function deleteUpload(imageId) {
  if (typeof WebSocket !== 'function') return;
  try {
    const ws = new WebSocket(HA_URL.replace(/^http/, 'ws') + '/api/websocket');
    const stop = setTimeout(() => ws.close(), 10000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token() }));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'image/delete', image_id: imageId }));
      else { clearTimeout(stop); ws.close(); }
    };
    ws.onerror = () => { clearTimeout(stop); };
  } catch { /* niet erg: blijft dan in HA staan */ }
}

const STRUCTURE = {
  name: { description: 'Korte Nederlandse naam van het voorwerp, 1 tot 5 woorden. Merk en product als die zichtbaar zijn.', required: true, selector: { text: {} } },
  description: { description: 'Eén korte Nederlandse zin met wat het is (kleur, maat, materiaal of inhoud als dat zichtbaar is).', selector: { text: {} } },
  tags: { description: 'Eén tot drie korte tags, gescheiden door komma\'s.', selector: { text: {} } },
  quantity: { description: 'Hoeveel stuks van dit voorwerp zichtbaar zijn (1 als het één ding is).', selector: { number: {} } },
  is_container: { description: 'true als de foto vooral een opbergplek toont (kast, doos, lade, plank, kamer) in plaats van een los voorwerp.', selector: { boolean: {} } },
};

async function recognize(buf, mime, tagNames) {
  if (!configured()) throw new Error('Fotoherkenning is niet ingesteld: voeg een Home Assistant-token toe onder Meer → Koppelingen');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `mijn-spullen.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}`);
  const up = await haFetch('/api/image/upload', { method: 'POST', body: form }, 30000);
  if (!up || !up.id) throw new Error('Uploaden naar Home Assistant mislukt');
  try {
    const instructions = [
      'Je helpt bij een huishoudelijke inventaris-app. Bekijk de foto en beschrijf het belangrijkste voorwerp.',
      'Antwoord in het Nederlands. Verzin niets wat je niet ziet.',
      tagNames.length ? `Kies tags bij voorkeur uit deze bestaande tags: ${tagNames.slice(0, 80).join(', ')}. Alleen een nieuwe tag als er echt niets past.` : '',
    ].filter(Boolean).join('\n');
    const r = await haFetch('/api/services/ai_task/generate_data?return_response', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_id: entity(), task_name: 'Mijn Spullen fotoherkenning', instructions, structure: STRUCTURE,
        attachments: [{ media_content_id: `media-source://image_upload/${up.id}`, media_content_type: mime }],
      }),
    });
    const d = (r && r.service_response && r.service_response.data) || {};
    if (!d.name) throw new Error('De AI herkende niets op deze foto');
    return {
      name: String(d.name).trim().slice(0, 200),
      description: String(d.description || '').trim().slice(0, 2000),
      tags: String(d.tags || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5),
      quantity: Number(d.quantity) > 0 ? Math.round(Number(d.quantity)) : 1,
      is_container: d.is_container === true || d.is_container === 'true',
    };
  } finally { deleteUpload(up.id); }
}

// Controle van token + entiteit zonder foto: bestaat de AI-entiteit en mag het token erbij?
async function check() {
  if (!configured()) throw new Error('Geen token ingesteld');
  const st = await haFetch(`/api/states/${encodeURIComponent(entity())}`, {}, 10000);
  return { entity: entity(), name: (st.attributes && st.attributes.friendly_name) || entity() };
}

module.exports = {
  recognize, check, configured,
  init: (fn) => { getSetting = fn; },
  info: () => ({ configured: configured(), ha_url: HA_URL || null, entity: entity(), token_set: !!token(), token_from_env: !getSetting('ha_token') && !!process.env.HA_TOKEN }),
};
