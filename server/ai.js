'use strict';
// Fotoherkenning via Home Assistant: foto uploaden (image_upload), ai_task.generate_data met de foto als bijlage,
// daarna de foto in HA weer opruimen. Zo gebruikt de app de AI die al in HA is ingesteld (bijv. Google Gemini).
// Token en entiteit staan in de database (Meer → Koppelingen) of in de omgeving (HA_TOKEN, HA_AI_ENTITY).
const HA_URL = (process.env.HA_URL || (() => { try { return new URL(process.env.HA_WEBHOOK_URL).origin; } catch { return ''; } })()).replace(/\/+$/, '');
const DEFAULT_ENTITY = 'ai_task.google_ai_task';
let getSetting = () => null;
const token = () => getSetting('ha_token') || process.env.HA_TOKEN || '';
const entity = () => getSetting('ha_ai_entity') || process.env.HA_AI_ENTITY || DEFAULT_ENTITY;
// Meerdere entiteiten mogen (komma-gescheiden): bij drukte wordt de volgende geprobeerd.
const entities = () => entity().split(',').map((e) => e.trim()).filter(Boolean);
// Tijdelijke fouten van de AI-dienst (overbelast, quotum): even wachten en opnieuw proberen.
const isBusy = (msg) => /\b(429|503)\b|overload|high demand|unavailable|resource.?exhausted|rate.?limit|try again|niet op tijd/i.test(msg);
const RETRY_DELAYS = (process.env.AI_RETRY_DELAYS || '2000,5000').split(',').map(Number).filter((n) => n >= 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const CONTENTS_STRUCTURE = {
  container_name: { description: 'Korte Nederlandse naam voor de opbergplek zelf (bijv. "Doos kabels", "Gereedschapskist", "La keukenkast").', required: true, selector: { text: {} } },
  container_description: { description: 'Eén korte zin over de opbergplek (kleur, materiaal, formaat).', selector: { text: {} } },
  items: { description: 'Alle afzonderlijke spullen die je erin ziet, één per regel, als "aantal | naam | korte omschrijving". Naam 1 tot 5 woorden, merk en type als zichtbaar. Gelijke dingen samen op één regel met het aantal. Maximaal 40 regels.', required: true, selector: { text: { multiline: true } } },
};

const instructionsFor = (lines, tagNames) => [
  ...lines,
  'Antwoord in het Nederlands. Verzin niets wat je niet ziet.',
  tagNames.length ? `Kies tags bij voorkeur uit deze bestaande tags: ${tagNames.slice(0, 80).join(', ')}. Alleen een nieuwe tag als er echt niets past.` : '',
].filter(Boolean).join('\n');

// Foto naar HA, AI-taak uitvoeren (met opnieuw proberen en uitwijken bij drukte), foto weer opruimen.
async function runTask(buf, mime, instructions, structure) {
  if (!configured()) throw new Error('Fotoherkenning is niet ingesteld: voeg een Home Assistant-token toe onder Meer → Koppelingen');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `mijn-spullen.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}`);
  const up = await haFetch('/api/image/upload', { method: 'POST', body: form }, 30000);
  if (!up || !up.id) throw new Error('Uploaden naar Home Assistant mislukt');
  try {
    const ask = (entityId) => haFetch('/api/services/ai_task/generate_data?return_response', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId, task_name: 'Mijn Spullen fotoherkenning', instructions, structure,
        attachments: [{ media_content_id: `media-source://image_upload/${up.id}`, media_content_type: mime }],
      }),
    }, 90000);
    let r = null, last = null;
    const deadline = Date.now() + 150000; // nooit langer dan ~2,5 minuut laten wachten
    for (const entityId of entities()) {
      for (let attempt = 0; attempt <= RETRY_DELAYS.length && !r && Date.now() < deadline; attempt++) {
        if (attempt) await sleep(RETRY_DELAYS[attempt - 1]);
        try { r = await ask(entityId); } catch (e) {
          last = e;
          if (!isBusy(e.message)) throw e; // echte fout (token, entiteit): niet blijven proberen
          console.warn(`AI-taak ${entityId} druk (poging ${attempt + 1}): ${e.message.slice(0, 120)}`);
        }
      }
      if (r) break;
    }
    if (!r) {
      const err = new Error('De AI-dienst (Google) is nu overbelast. Probeer het over een minuut opnieuw.');
      err.busy = true; err.detail = last && last.message;
      throw err;
    }
    return (r.service_response && r.service_response.data) || {};
  } finally { deleteUpload(up.id); }
}

const splitTags = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);

async function recognize(buf, mime, tagNames) {
  const d = await runTask(buf, mime, instructionsFor(['Je helpt bij een huishoudelijke inventaris-app. Bekijk de foto en beschrijf het belangrijkste voorwerp.'], tagNames), STRUCTURE);
  if (!d.name) throw new Error('De AI herkende niets op deze foto');
  return {
    name: String(d.name).trim().slice(0, 200),
    description: String(d.description || '').trim().slice(0, 2000),
    tags: splitTags(d.tags),
    quantity: Number(d.quantity) > 0 ? Math.round(Number(d.quantity)) : 1,
    is_container: d.is_container === true || d.is_container === 'true',
  };
}

// Regels "aantal | naam | omschrijving" (ook "3x naam" of alleen "naam") omzetten naar items.
function parseItems(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!line) continue;
    let [a, b, c] = line.split('|').map((x) => x.trim());
    let qty = 1, name, desc = '';
    if (b !== undefined && /^\d+([.,]\d+)?\s*x?$/i.test(a)) { qty = Number(a.replace(/x$/i, '').replace(',', '.')); name = b; desc = c || ''; }
    else if (b !== undefined) { name = a; desc = b; }
    else { const m = a.match(/^(\d+)\s*(?:x|×|stuks?)?\s+(.+)$/i); if (m) { qty = Number(m[1]); name = m[2]; } else name = a; }
    name = (name || '').replace(/^["']|["']$/g, '').trim().slice(0, 200);
    if (!name) continue;
    out.push({ name, quantity: qty > 0 && qty < 10000 ? qty : 1, description: desc.slice(0, 500) });
    if (out.length >= 60) break;
  }
  return out;
}

async function recognizeContents(buf, mime) {
  const d = await runTask(buf, mime, instructionsFor([
    'Je helpt bij een huishoudelijke inventaris-app. De foto toont een open doos, la, kast of andere opbergplek.',
    'Geef een naam voor de opbergplek en maak een lijst van alle losse spullen die erin liggen of staan.',
  ], []), CONTENTS_STRUCTURE);
  const items = parseItems(d.items);
  if (!items.length) throw new Error('De AI zag geen losse spullen op deze foto');
  return {
    container: { name: String(d.container_name || 'Doos').trim().slice(0, 200), description: String(d.container_description || '').trim().slice(0, 2000) },
    items,
  };
}

// Controle van token + entiteit zonder foto: bestaat de AI-entiteit en mag het token erbij?
async function check() {
  if (!configured()) throw new Error('Geen token ingesteld');
  const names = [];
  for (const e of entities()) {
    const st = await haFetch(`/api/states/${encodeURIComponent(e)}`, {}, 10000);
    names.push((st.attributes && st.attributes.friendly_name) || e);
  }
  return { entity: entity(), name: names.join(' + ') };
}

module.exports = {
  recognize, recognizeContents, parseItems, check, configured,
  init: (fn) => { getSetting = fn; },
  info: () => ({ configured: configured(), ha_url: HA_URL || null, entity: entity(), token_set: !!token(), token_from_env: !getSetting('ha_token') && !!process.env.HA_TOKEN }),
};
