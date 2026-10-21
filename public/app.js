import { CLIENT_ID, h, flat, icon, api, ApiError, setUnauthorizedHandler, money, num, daysUntil, fmtDate, expiryText, debounce, toast, openDialog, confirmDialog, uploadPhoto } from './lib.js';

const app = document.getElementById('app');
const S = { me: null, tags: [], version: '' };
let routeToken = 0;
let refresh = null; // wordt door de actieve view ingesteld voor live-updates
let events = null;

// ============ opstarten ============
setUnauthorizedHandler(() => { if (S.me) { S.me = null; renderAuth('login'); } });

async function boot() {
  try {
    const st = await api('GET', '/api/setup-status');
    S.version = st.version;
    if (st.needsSetup) return renderAuth('setup');
    const me = await api('GET', '/api/me');
    S.me = me.user;
    await start();
  } catch (e) {
    if (e.status === 401) return renderAuth('login');
    app.replaceChildren(h('p', { class: 'boot' }, e.message || 'Kan de server niet bereiken'),
      h('p', { class: 'boot' }, h('button', { class: 'btn', onclick: () => location.reload() }, 'Opnieuw proberen')));
  }
}

async function start() {
  await loadTags();
  connectEvents();
  window.addEventListener('hashchange', route);
  await route();
}

async function loadTags() { S.tags = (await api('GET', '/api/tags')).tags; }
const tagById = (id) => S.tags.find((t) => t.id === id);
function tagsFlat() {
  const out = [];
  const walk = (parent, depth) => S.tags.filter((t) => (t.parent_id || null) === parent).forEach((t) => { out.push({ ...t, depth }); walk(t.id, depth + 1); });
  walk(null, 0);
  // wees-tags (parent verwijderd) komen alsnog mee
  S.tags.forEach((t) => { if (!out.find((o) => o.id === t.id)) out.push({ ...t, depth: 0 }); });
  return out;
}

function connectEvents() {
  if (events) events.close();
  events = new EventSource('/api/events');
  const kick = debounce(() => { if (refresh) refresh(); }, 250);
  events.onmessage = async (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.src && ev.src === CLIENT_ID) return;
    if (ev.kind === 'tag') await loadTags().catch(() => {});
    kick();
  };
}

// ============ inloggen ============
function renderAuth(mode) {
  if (events) { events.close(); events = null; }
  refresh = null;
  const err = h('div', { class: 'error', role: 'alert' });
  const u = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const dn = h('input', { name: 'display', autocomplete: 'name' });
  const pw = h('input', { name: 'password', type: 'password', autocomplete: mode === 'setup' ? 'new-password' : 'current-password', required: true, minlength: mode === 'setup' ? 8 : 1 });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, mode === 'setup' ? 'Account aanmaken' : 'Inloggen');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const body = mode === 'setup' ? { username: u.value, display_name: dn.value, password: pw.value } : { username: u.value, password: pw.value };
        const r = await api('POST', mode === 'setup' ? '/api/setup' : '/api/login', body);
        S.me = r.user;
        await start();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
  h('div', { class: 'field' }, h('label', {}, 'Gebruikersnaam'), u),
  mode === 'setup' && h('div', { class: 'field' }, h('label', {}, 'Je naam'), dn),
  h('div', { class: 'field' }, h('label', {}, mode === 'setup' ? 'Wachtwoord (minimaal 8 tekens)' : 'Wachtwoord'), pw),
  err, btn);
  app.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'logo' }, icon('box')),
    h('h1', {}, 'Mijn Spullen'),
    h('p', {}, mode === 'setup' ? 'Welkom! Maak het eerste (beheerders)account aan.' : 'Log in om je spullen te zien.'),
    form, h('div', { class: 'ver' }, S.version && `versie ${S.version}`)));
  u.focus();
}

// ============ shell ============
function shell(title, opts = {}) {
  const main = h('main');
  const back = opts.back != null && h('a', { class: 'btn icon ghost', href: opts.back, 'aria-label': 'Terug' }, icon('back'));
  const nav = [['#/', 'home', 'Spullen', (r) => r === 'home'], ['#/search', 'search', 'Zoeken', (r) => r === 'search'], ['#/tags', 'tag', 'Tags', (r) => r === 'tags'], ['#/more', 'more', 'Meer', (r) => r === 'more']];
  app.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, back, h('h1', {}, title), opts.actions),
    main,
    h('nav', { class: 'nav' }, h('div', { class: 'nav-in' }, nav.map(([href, ic, label, on]) => h('a', { href, class: on(opts.tab) ? 'on' : '' }, icon(ic), label))))));
  window.scrollTo(0, 0);
  return main;
}
const scanBtn = (ctx) => h('button', { class: 'btn icon ghost', 'aria-label': 'Scan barcode', onclick: () => scanAndGo(ctx) }, icon('scan'));

// ============ router ============
async function route() {
  const token = ++routeToken;
  refresh = null;
  const raw = location.hash.slice(1) || '/';
  const [p, qs] = raw.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = p.split('/').filter(Boolean);
  const id = Number(seg[1]);
  try {
    if (!seg.length) await viewBrowse(null, token);
    else if (seg[0] === 'c' && id) await viewBrowse(id, token);
    else if (seg[0] === 't' && id) await viewThing(id, null, token);
    else if (seg[0] === 'new') await viewThing(null, q, token);
    else if (seg[0] === 'search') await viewSearch(q, token);
    else if (seg[0] === 'tags') await viewTags(token);
    else if (seg[0] === 'more') await viewMore(token);
    else await viewBrowse(null, token);
  } catch (e) {
    if (token !== routeToken || e.status === 401) return;
    const main = shell('Oeps', { back: '#/' });
    main.append(h('div', { class: 'empty' }, e.status === 404 ? 'Dit item bestaat niet (meer).' : e.message, h('br'), h('a', { class: 'btn', href: '#/' }, 'Naar het begin')));
  }
}
const stale = (t) => t !== routeToken;

// ============ rijen ============
function badgesFor(t) {
  const b = [];
  if (!t.is_container && t.min_quantity != null && t.quantity <= t.min_quantity) b.push(h('span', { class: 'badge low' }, 'Bijna op'));
  const d = daysUntil(t.expires_on);
  if (d != null && d <= 30) b.push(h('span', { class: 'badge exp' }, d < 0 ? 'Verlopen' : d === 0 ? 'Vandaag' : `Nog ${d} d`));
  for (const tid of t.tag_ids.slice(0, 3)) { const g = tagById(tid); if (g) b.push(h('span', { class: 'badge tag', style: `background:${g.color}` }, g.name)); }
  return b;
}
function thingRow(t, { showPath } = {}) {
  const go = () => { location.hash = t.is_container ? `#/c/${t.id}` : `#/t/${t.id}`; };
  const thumb = h('div', { class: 'thumb' }, t.cover_image_id ? h('img', { src: `/api/images/${t.cover_image_id}?thumb=1`, loading: 'lazy', alt: '' }) : icon(t.is_container ? 'folder' : 'box'));
  let sub = '';
  if (showPath && t.path.length) sub = t.path.map((p) => p.name).join(' › ');
  else if (t.is_container) sub = t.child_count === 1 ? '1 onderdeel' : `${t.child_count} onderdelen`;
  else if (t.description) sub = t.description;
  const row = h('div', { class: 'row' + (t.is_container ? ' container' : ''), role: 'link', tabindex: '0', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
    thumb,
    h('div', { class: 'main' }, h('div', { class: 'name' }, (t.favourite ? '★ ' : '') + t.name), sub && h('div', { class: 'sub' }, sub), h('div', { class: 'badges' }, badgesFor(t))));
  if (!t.is_container) {
    const out = h('output', {}, num(t.quantity));
    const adj = (delta) => async (e) => {
      e.stopPropagation();
      try { const r = await api('POST', `/api/things/${t.id}/adjust`, { delta }); out.textContent = num(r.thing.quantity); }
      catch (ex) { toast(ex.message, true); }
    };
    row.append(h('div', { class: 'qty', onclick: (e) => e.stopPropagation() },
      h('button', { 'aria-label': 'Minder', onclick: adj(-1) }, icon('minus')), out, h('button', { 'aria-label': 'Meer', onclick: adj(1) }, icon('plus'))));
  }
  return row;
}

// ============ bladeren ============
async function viewBrowse(id, token) {
  const load = async () => {
    const [cur, list, stats] = await Promise.all([
      id ? api('GET', `/api/things/${id}`) : null,
      api('GET', `/api/things?parent=${id || 'root'}`),
      id ? null : api('GET', '/api/stats'),
    ]);
    if (stale(token)) return;
    const c = cur && cur.thing;
    const parentHref = c ? (c.path.length ? `#/c/${c.path[c.path.length - 1].id}` : '#/') : null;
    const main = shell(c ? c.name : 'Mijn Spullen', {
      tab: 'home', back: parentHref,
      actions: [c && h('a', { class: 'btn icon ghost', href: `#/t/${c.id}`, 'aria-label': 'Bewerken' }, icon('more')), scanBtn(id)],
    });
    if (!c) {
      const s = stats.stats;
      main.append(
        h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); location.hash = `#/search?q=${encodeURIComponent(e.target.q.value)}`; } }, icon('search'), h('input', { name: 'q', placeholder: 'Zoek in al je spullen…', type: 'search', 'aria-label': 'Zoeken' })),
        h('div', { class: 'stats' },
          h('a', { class: 'stat', href: '#/search' }, h('b', {}, num(s.items)), h('span', {}, 'items')),
          h('a', { class: 'stat' + (s.low ? ' alert' : ''), href: '#/search?low=1' }, h('b', {}, num(s.low)), h('span', {}, 'bijna op')),
          h('a', { class: 'stat' + (s.expiring ? ' alert' : ''), href: '#/search?expiring=30' }, h('b', {}, num(s.expiring)), h('span', {}, 'verloopt'))));
    } else {
      main.append(h('nav', { class: 'crumbs', 'aria-label': 'Locatie' }, h('a', { href: '#/' }, 'Alles'), c.path.map((p) => [' › ', h('a', { href: `#/c/${p.id}` }, p.name)]), ' › ', h('b', {}, c.name)));
    }
    if (!list.things.length) {
      main.append(h('div', { class: 'empty' }, c ? 'Hier staat nog niets.' : 'Begin met een plek, bijvoorbeeld "Huis" of "Zolder".', h('br'),
        h('a', { class: 'btn primary', href: `#/new?container=1${id ? `&parent=${id}` : ''}` }, icon('plus'), 'Nieuwe container')));
    } else {
      main.append(h('div', { class: 'list' }, list.things.map((t) => thingRow(t))));
    }
    main.append(h('button', { class: 'fab', 'aria-label': 'Toevoegen', onclick: () => addDialog(id) }, icon('plus')));
  };
  refresh = () => load().catch(() => {});
  await load();
}
function addDialog(parent) {
  const p = parent ? `&parent=${parent}` : '';
  openDialog((close) => h('div', { class: 'dlg' }, h('h2', {}, 'Toevoegen'),
    h('a', { class: 'btn primary', href: `#/new?container=0${p}`, onclick: () => close() }, icon('box'), 'Nieuw item'),
    h('a', { class: 'btn', href: `#/new?container=1${p}`, onclick: () => close() }, icon('folder'), 'Nieuwe container (kamer, kast, doos…)'),
    h('button', { class: 'btn ghost', onclick: () => close() }, 'Annuleren')));
}

// ============ zoeken ============
async function viewSearch(q, token) {
  const state = { q: q.q || '', low: q.low === '1', expiring: q.expiring || '', favourite: q.favourite === '1', tag: q.tag || '' };
  const main = shell('Zoeken', { tab: 'search', actions: scanBtn(null) });
  const results = h('div', { class: 'list' });
  const input = h('input', { type: 'search', placeholder: 'Naam, omschrijving, barcode of tag…', value: state.q, 'aria-label': 'Zoeken' });
  const chipBox = h('div', { class: 'chips' });
  const run = async () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.low) p.set('low', '1');
    if (state.expiring) p.set('expiring', state.expiring);
    if (state.favourite) p.set('favourite', '1');
    if (state.tag) p.set('tag', state.tag);
    history.replaceState(null, '', '#/search' + (p.toString() ? '?' + p : ''));
    p.set('sort', state.expiring ? 'expires' : 'name');
    const r = await api('GET', '/api/things?' + p);
    if (stale(token)) return;
    results.replaceChildren(...(r.things.length ? r.things.map((t) => thingRow(t, { showPath: true })) : [h('div', { class: 'empty' }, 'Niets gevonden.')]));
  };
  const drawChips = () => {
    const chip = (label, on, fn, dot) => h('button', { class: 'chip' + (on ? ' on' : ''), onclick: () => { fn(); drawChips(); run().catch((e) => toast(e.message, true)); } }, dot && h('span', { class: 'dot', style: `background:${dot}` }), label);
    chipBox.replaceChildren(...flat(
      chip('Bijna op', state.low, () => { state.low = !state.low; }),
      chip('Verloopt ≤ 30 d', state.expiring === '30', () => { state.expiring = state.expiring === '30' ? '' : '30'; }),
      chip('★ Favoriet', state.favourite, () => { state.favourite = !state.favourite; }),
      tagsFlat().map((t) => chip(t.name, state.tag === String(t.id), () => { state.tag = state.tag === String(t.id) ? '' : String(t.id); }, t.color))));
  };
  input.addEventListener('input', debounce(() => { state.q = input.value.trim(); run().catch((e) => toast(e.message, true)); }, 250));
  main.append(h('div', { class: 'search' }, icon('search'), input), chipBox, results);
  drawChips();
  refresh = () => run().catch(() => {});
  await run();
  if (!state.q && !q.low && !q.expiring) input.focus();
}

// ============ scannen ============
function scanDialog() {
  return openDialog((close) => {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const note = h('div', { class: 'meta' }, 'Houd de barcode of QR-code voor de camera…');
    const manual = h('input', { placeholder: 'Of typ de code hier', inputmode: 'text', 'aria-label': 'Code' });
    let stream = null;
    const finish = (v) => { stream && stream.getTracks().forEach((t) => t.stop()); close(v); };
    (async () => {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { note.textContent = 'Camera-scan wordt door deze browser niet ondersteund. Typ de code hieronder.'; video.parentElement && (video.parentElement.style.display = 'none'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream; await video.play();
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] });
        const tick = async () => {
          if (!video.isConnected) { stream.getTracks().forEach((t) => t.stop()); return; }
          try { const codes = await det.detect(video); if (codes.length) return finish(codes[0].rawValue); } catch { /* volgende frame */ }
          setTimeout(tick, 200);
        };
        tick();
      } catch { note.textContent = 'Geen cameratoegang (HTTPS en toestemming nodig). Typ de code hieronder.'; }
    })();
    return h('form', { class: 'dlg', onsubmit: (e) => { e.preventDefault(); if (manual.value.trim()) finish(manual.value.trim()); } },
      h('h2', {}, 'Barcode scannen'), h('div', { class: 'video-wrap' }, video), note,
      h('div', { class: 'inline' }, manual, h('button', { class: 'btn primary', type: 'submit' }, 'OK')),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => finish(undefined) }, 'Sluiten')));
  });
}
async function scanAndGo(parentId) {
  const code = await scanDialog();
  if (!code) return;
  try {
    const r = await api('GET', `/api/things?barcode=${encodeURIComponent(code)}`);
    if (r.things.length === 1) { location.hash = r.things[0].is_container ? `#/c/${r.things[0].id}` : `#/t/${r.things[0].id}`; return; }
    if (r.things.length > 1) { location.hash = `#/search?q=${encodeURIComponent(code)}`; return; }
    const ok = await confirmDialog('Niet gevonden', `Er is nog niets met code "${code}". Nieuw item aanmaken?`, 'Nieuw item', false);
    if (ok) location.hash = `#/new?container=0&barcode=${encodeURIComponent(code)}${parentId ? `&parent=${parentId}` : ''}`;
  } catch (e) { toast(e.message, true); }
}

// ============ locatie kiezen ============
async function pickLocation(excludeId, currentId) {
  const { nodes } = await api('GET', '/api/tree');
  const kids = new Map();
  nodes.forEach((n) => { const k = n.parent_id || 0; (kids.get(k) || kids.set(k, []).get(k)).push(n); });
  const banned = new Set();
  if (excludeId) { const walk = (i) => { banned.add(i); (kids.get(i) || []).forEach((c) => walk(c.id)); }; walk(excludeId); }
  return openDialog((close) => {
    const rows = [h('button', { class: 'pick' + (!currentId ? ' cur' : ''), type: 'button', onclick: () => close({ id: null }) }, icon('home'), 'Hoofdniveau (geen locatie)')];
    const walk = (pid, depth) => (kids.get(pid) || []).forEach((n) => {
      if (banned.has(n.id)) return;
      rows.push(h('button', { class: 'pick' + (n.id === currentId ? ' cur' : ''), type: 'button', style: `padding-left:${10 + depth * 18}px`, onclick: () => close({ id: n.id }) }, icon(n.is_container ? 'folder' : 'box'), n.name));
      walk(n.id, depth + 1);
    });
    walk(0, 1);
    return h('div', { class: 'dlg' }, h('h2', {}, 'Kies een locatie'), h('div', { class: 'dlg-scroll' }, rows), h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => close(undefined) }, 'Annuleren')));
  });
}

// ============ item bekijken/bewerken ============
async function viewThing(id, q, token) {
  let t = null;
  if (id) t = (await api('GET', `/api/things/${id}`)).thing;
  if (stale(token)) return;
  const isNew = !t;
  const f = isNew
    ? { is_container: q.container === '1', name: '', description: '', notes: '', quantity: 1, min_quantity: '', barcode: q.barcode || '', price: '', expires_on: '', favourite: false, parent_id: q.parent ? Number(q.parent) : null, tag_ids: [], path: [] }
    : { ...t, min_quantity: t.min_quantity ?? '', barcode: t.barcode || '', price: t.price ?? '', expires_on: t.expires_on || '' };
  if (isNew && f.parent_id) { const p = (await api('GET', `/api/things/${f.parent_id}`).catch(() => null)); if (p) f.path = [...p.thing.path, { id: p.thing.id, name: p.thing.name }]; else f.parent_id = null; }
  const pending = []; // foto's voor een nog niet opgeslagen item
  let images = isNew ? [] : t.images.slice();
  let dirty = false;

  const back = f.path.length ? `#/c/${f.path[f.path.length - 1].id}` : '#/';
  const main = shell(isNew ? (f.is_container ? 'Nieuwe container' : 'Nieuw item') : f.name, { back: isNew ? back : (t.is_container ? `#/c/${t.id}` : back), tab: 'home' });
  const bannerBox = h('div');
  const err = h('div', { class: 'error', role: 'alert' });
  const inp = (key, attrs = {}) => h('input', { value: f[key] ?? '', oninput: (e) => { f[key] = e.target.value; dirty = true; }, ...attrs });

  const nameI = inp('name', { required: true, maxlength: 200, placeholder: f.is_container ? 'bijv. Zolder, Kast 2, Doos kabels' : 'bijv. USB-C kabel' });
  const typeSeg = isNew && h('div', { class: 'field' }, h('label', {}, 'Soort'), h('div', { class: 'seg' },
    ['Item', 'Container'].map((lbl, i) => h('button', { type: 'button', class: (i === 1) === f.is_container ? 'on' : '', onclick: (e) => { f.is_container = i === 1; [...e.target.parentElement.children].forEach((b, j) => b.classList.toggle('on', j === i)); itemOnly.forEach((el) => { el.style.display = f.is_container ? 'none' : ''; }); } }, lbl))));

  const locBtn = h('button', { class: 'btn', type: 'button', style: 'justify-content:flex-start;font-weight:500', onclick: async () => {
    const r = await pickLocation(id, f.parent_id);
    if (!r) return;
    f.parent_id = r.id; dirty = true;
    if (r.id) { const p = await api('GET', `/api/things/${r.id}`); f.path = [...p.thing.path, { id: p.thing.id, name: p.thing.name }]; } else f.path = [];
    drawLoc();
  } });
  const drawLoc = () => locBtn.replaceChildren(icon('move'), f.path.length ? f.path.map((p) => p.name).join(' › ') : 'Hoofdniveau');
  drawLoc();

  const scanInto = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Scan', onclick: async () => { const c = await scanDialog(); if (c) { f.barcode = c; barcodeI.value = c; dirty = true; } } }, icon('scan'));
  const barcodeI = inp('barcode', { maxlength: 100, inputmode: 'text', placeholder: 'EAN / QR / eigen code' });

  const qtyF = h('div', { class: 'field' }, h('label', {}, 'Aantal'), inp('quantity', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' }));
  const minF = h('div', { class: 'field' }, h('label', {}, 'Melden bij ≤'), inp('min_quantity', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: 'optioneel' }));
  const priceF = h('div', { class: 'field' }, h('label', {}, 'Prijs per stuk (€)'), inp('price', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'optioneel' }));
  const itemOnly = [qtyF, minF, priceF];
  if (f.is_container) itemOnly.forEach((el) => { el.style.display = 'none'; });

  // tags
  const tagBox = h('div', { class: 'chips' });
  const drawTags = () => tagBox.replaceChildren(...flat(
    tagsFlat().map((g) => h('button', { type: 'button', class: 'chip' + (f.tag_ids.includes(g.id) ? ' on' : ''), style: g.depth ? `margin-left:${g.depth * 10}px` : '', onclick: () => { f.tag_ids = f.tag_ids.includes(g.id) ? f.tag_ids.filter((x) => x !== g.id) : [...f.tag_ids, g.id]; dirty = true; drawTags(); } }, h('span', { class: 'dot', style: `background:${g.color}` }), g.name)),
    h('button', { type: 'button', class: 'chip', onclick: async () => { const nid = await tagDialog(); if (nid) { f.tag_ids.push(nid); dirty = true; drawTags(); } } }, icon('plus'), 'Nieuwe tag')));
  drawTags();

  // foto's
  const photoBox = h('div', { class: 'photos' });
  const fileI = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: async (e) => {
    for (const file of e.target.files) {
      try {
        if (isNew) pending.push(file);
        else images.push(await uploadPhoto(id, file));
      } catch (ex) { toast(ex.message, true); }
    }
    e.target.value = ''; drawPhotos();
  } });
  const drawPhotos = () => photoBox.replaceChildren(...flat(
    images.map((im) => h('div', { class: 'photo', onclick: () => window.open(`/api/images/${im.id}`, '_blank') },
      h('img', { src: `/api/images/${im.id}?thumb=1`, alt: '' }),
      h('button', { type: 'button', 'aria-label': 'Foto verwijderen', onclick: async (e) => { e.stopPropagation(); if (!await confirmDialog('Foto verwijderen?', 'Deze foto wordt definitief verwijderd.')) return; try { await api('DELETE', `/api/images/${im.id}`); images = images.filter((x) => x.id !== im.id); drawPhotos(); } catch (ex) { toast(ex.message, true); } } }, icon('x')))),
    pending.map((file, i) => h('div', { class: 'photo' }, h('img', { src: URL.createObjectURL(file), alt: '' }), h('button', { type: 'button', 'aria-label': 'Verwijderen', onclick: () => { pending.splice(i, 1); drawPhotos(); } }, icon('x')))),
    h('button', { type: 'button', class: 'addphoto', 'aria-label': 'Foto toevoegen', onclick: () => fileI.click() }, icon('camera'))));
  drawPhotos();

  const favBtn = h('button', { type: 'button', class: 'btn sm', onclick: (e) => { f.favourite = !f.favourite; dirty = true; e.currentTarget.classList.toggle('primary', f.favourite); } }, icon('star'), 'Favoriet');
  if (f.favourite) favBtn.classList.add('primary');

  const save = async (ev) => {
    ev.preventDefault(); err.textContent = '';
    const body = {
      name: f.name, is_container: f.is_container, description: f.description, notes: f.notes, barcode: f.barcode,
      expires_on: f.expires_on, favourite: f.favourite, parent_id: f.parent_id, tag_ids: f.tag_ids,
      quantity: f.is_container ? (f.quantity === '' ? 1 : f.quantity) : f.quantity, min_quantity: f.is_container ? '' : f.min_quantity, price: f.is_container ? '' : f.price,
    };
    saveBtn.disabled = true;
    try {
      if (isNew) {
        const r = await api('POST', '/api/things', body);
        for (const file of pending) { try { await uploadPhoto(r.thing.id, file); } catch (ex) { toast(ex.message, true); } }
        toast('Opgeslagen');
        location.hash = f.is_container ? `#/c/${r.thing.id}` : (f.parent_id ? `#/c/${f.parent_id}` : '#/');
      } else {
        try {
          const r = await api('PATCH', `/api/things/${id}`, { ...body, version: t.version });
          dirty = false; toast('Opgeslagen');
          t = r.thing;
          location.hash = t.is_container ? `#/c/${id}` : (t.parent_id ? `#/c/${t.parent_id}` : '#/');
        } catch (ex) {
          if (ex.status !== 409) throw ex;
          const choice = await openDialog((close) => h('div', { class: 'dlg' }, h('h2', {}, 'Conflict'),
            h('p', { style: 'margin:0;color:var(--muted)' }, `${ex.data.current.updated_by_name || 'Iemand anders'} heeft dit item zojuist gewijzigd. Wat wil je doen?`),
            h('div', { class: 'dlg-actions' },
              h('button', { class: 'btn', onclick: () => close('reload') }, 'Nieuwste laden'),
              h('button', { class: 'btn primary', onclick: () => close('overwrite') }, 'Mijn versie opslaan'))));
          if (choice === 'reload') { dirty = false; return route(); }
          if (choice === 'overwrite') {
            await api('PATCH', `/api/things/${id}`, { ...body, version: ex.data.current.version });
            dirty = false; toast('Opgeslagen'); location.hash = back;
          }
        }
      }
    } catch (ex) { err.textContent = ex.message; } finally { saveBtn.disabled = false; }
  };
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Toevoegen' : 'Opslaan');

  const form = h('form', { class: 'card', onsubmit: save },
    typeSeg,
    h('div', { class: 'field' }, h('label', {}, 'Naam'), nameI),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Locatie'), locBtn),
    h('div', { class: 'grid2' }, qtyF, minF),
    h('div', { class: 'field' }, h('label', {}, "Foto's"), photoBox, fileI),
    h('div', { class: 'field' }, h('label', {}, 'Tags'), tagBox),
    h('div', { class: 'grid2' }, priceF, h('div', { class: 'field' }, h('label', {}, 'Houdbaar tot'), inp('expires_on', { type: 'date' }))),
    h('div', { class: 'field' }, h('label', {}, 'Barcode / QR'), h('div', { class: 'inline' }, barcodeI, scanInto)),
    h('div', { class: 'field' }, h('label', {}, 'Omschrijving'), h('input', { value: f.description, maxlength: 2000, oninput: (e) => { f.description = e.target.value; dirty = true; } })),
    h('div', { class: 'field' }, h('label', {}, 'Notities'), h('textarea', { oninput: (e) => { f.notes = e.target.value; dirty = true; } }, f.notes)),
    h('div', { class: 'actions' }, favBtn),
    !isNew && h('div', { class: 'meta' }, `Aangemaakt door ${t.created_by_name || 'onbekend'} op ${fmtDate(t.created_at)}`, h('br'), `Laatst gewijzigd door ${t.updated_by_name || 'onbekend'} op ${fmtDate(t.updated_at)}`, t.expires_on ? h('br') : null, t.expires_on ? expiryText(t.expires_on) : null),
    err,
    h('div', { class: 'actions' }, saveBtn,
      !isNew && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        const kids = t.child_count;
        if (!await confirmDialog(`"${t.name}" verwijderen?`, kids ? `Dit verwijdert ook alles wat erin zit (${kids} direct onderdeel${kids === 1 ? '' : 'en'} en dieper). Dit kan niet ongedaan worden gemaakt.` : 'Dit kan niet ongedaan worden gemaakt.')) return;
        try { await api('DELETE', `/api/things/${id}`); toast('Verwijderd'); location.hash = back; } catch (ex) { toast(ex.message, true); }
      } }, icon('trash'), 'Verwijderen')));
  main.append(bannerBox, form);
  if (isNew) nameI.focus();

  // live: iemand anders wijzigde dit item
  if (!isNew) refresh = async () => {
    try {
      const cur = (await api('GET', `/api/things/${id}`)).thing;
      if (cur.version === t.version) return;
      if (!dirty) { route(); return; }
      bannerBox.replaceChildren(h('div', { class: 'banner' }, `${cur.updated_by_name || 'Iemand'} heeft dit item gewijzigd.`, h('button', { class: 'btn sm', onclick: () => route() }, 'Verversen')));
    } catch (ex) { if (ex.status === 404) { toast('Dit item is verwijderd', true); location.hash = back; } }
  };
}

// ============ tags ============
async function tagDialog(existing) {
  return openDialog((close) => {
    const name = h('input', { value: existing ? existing.name : '', required: true, maxlength: 60, placeholder: 'bijv. Elektronica' });
    const color = h('input', { type: 'color', value: existing ? existing.color : '#0f766e', style: 'height:44px;padding:4px' });
    const parent = h('select', {}, h('option', { value: '' }, '— geen (hoofdtag) —'),
      tagsFlat().filter((t) => !existing || t.id !== existing.id).map((t) => h('option', { value: t.id, selected: existing && existing.parent_id === t.id }, ' '.repeat(t.depth * 3) + t.name)));
    const err = h('div', { class: 'error' });
    return h('form', { class: 'dlg', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const body = { name: name.value, color: color.value, parent_id: parent.value || null };
        let nid;
        if (existing) await api('PATCH', `/api/tags/${existing.id}`, body); else nid = (await api('POST', '/api/tags', body)).id;
        await loadTags(); close(nid || existing.id);
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('h2', {}, existing ? 'Tag bewerken' : 'Nieuwe tag'),
    h('div', { class: 'field' }, h('label', {}, 'Naam'), name),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', {}, 'Kleur'), color), h('div', { class: 'field' }, h('label', {}, 'Onder'), parent)),
    err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Annuleren'), h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan')));
  });
}
async function viewTags(token) {
  const draw = () => {
    const main = shell('Tags', { tab: 'tags', actions: h('button', { class: 'btn icon ghost', 'aria-label': 'Nieuwe tag', onclick: async () => { if (await tagDialog()) draw(); } }, icon('plus')) });
    const flat = tagsFlat();
    if (!flat.length) { main.append(h('div', { class: 'empty' }, 'Nog geen tags. Tags helpen je dingen te groeperen, bijvoorbeeld "Gereedschap" of "Winter".', h('br'), h('button', { class: 'btn primary', onclick: async () => { if (await tagDialog()) draw(); } }, icon('plus'), 'Eerste tag'))); return; }
    main.append(h('div', { class: 'list' }, flat.map((t) => h('div', { class: 'row', style: `margin-left:${t.depth * 16}px` },
      h('div', { class: 'thumb', style: `background:${t.color};color:#fff` }, icon('tag')),
      h('a', { class: 'main', href: `#/search?tag=${t.id}`, style: 'text-decoration:none;color:inherit' }, h('div', { class: 'name' }, t.name), h('div', { class: 'sub' }, `${t.use_count} item${t.use_count === 1 ? '' : 's'}`)),
      h('button', { class: 'btn sm', onclick: async () => { if (await tagDialog(t)) draw(); } }, 'Bewerk'),
      h('button', { class: 'btn sm danger', 'aria-label': 'Verwijderen', onclick: async () => { if (!await confirmDialog(`Tag "${t.name}" verwijderen?`, 'De tag wordt van alle items gehaald. De items zelf blijven bestaan.')) return; try { await api('DELETE', `/api/tags/${t.id}`); await loadTags(); draw(); } catch (ex) { toast(ex.message, true); } } }, icon('trash'))))));
  };
  await loadTags();
  if (stale(token)) return;
  draw();
  refresh = async () => { await loadTags().catch(() => {}); draw(); };
}

// ============ meer ============
async function viewMore(token) {
  const draw = async () => {
    const [users, act] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/activity?limit=25')]);
    if (stale(token)) return;
    const main = shell('Meer', { tab: 'more' });
    const isAdmin = S.me.role === 'admin';
    main.append(
      h('div', { class: 'card' }, h('div', { class: 'userrow' }, h('div', { class: 'thumb' }, icon('user')), h('div', { class: 'main' }, h('b', {}, S.me.display_name), h('div', { class: 'sub' }, `@${S.me.username} · ${S.me.role === 'admin' ? 'beheerder' : 'lid'}`))),
        h('div', { class: 'actions', style: 'margin-top:10px' },
          h('button', { class: 'btn', onclick: pwDialog }, 'Wachtwoord wijzigen'),
          h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/logout'); } catch { /* */ } S.me = null; location.hash = '#/'; renderAuth('login'); } }, icon('logout'), 'Uitloggen'))),
      h('div', { class: 'section-title' }, 'Gebruikers'),
      h('div', { class: 'card' }, users.map((u) => h('div', { class: 'userrow' },
        h('div', { class: 'main' }, h('b', {}, u.display_name, u.disabled ? ' (geblokkeerd)' : ''), h('div', { class: 'sub' }, `@${u.username} · ${u.role === 'admin' ? 'beheerder' : 'lid'}`)),
        isAdmin && u.id !== S.me.id && h('button', { class: 'btn sm', onclick: () => userDialog(u).then((ok) => ok && draw()) }, 'Beheer'))),
      isAdmin && h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => userDialog().then((ok) => ok && draw()) }, icon('plus'), 'Gebruiker toevoegen'))),
      h('div', { class: 'section-title' }, 'Gegevens'),
      h('div', { class: 'card' }, h('a', { class: 'btn', href: '/api/export.csv', download: true }, icon('download'), 'Exporteer alles als CSV')),
      h('div', { class: 'section-title' }, 'Recente activiteit'),
      h('div', { class: 'card' }, act.activity.length ? act.activity.map((a) => h('div', { class: 'act' }, a.summary, h('small', {}, fmtDate(a.at)))) : 'Nog geen activiteit.'),
      h('div', { class: 'ver' }, `Mijn Spullen ${S.version} (alpha)`));
  };
  refresh = () => draw().catch(() => {});
  await draw();
}
function pwDialog() {
  return openDialog((close) => {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const err = h('div', { class: 'error' });
    return h('form', { class: 'dlg', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/api/me/password', { current: cur.value, password: nw.value }); toast('Wachtwoord gewijzigd'); close(true); } catch (ex) { err.textContent = ex.message; } } },
      h('h2', {}, 'Wachtwoord wijzigen'), h('div', { class: 'field' }, h('label', {}, 'Huidig wachtwoord'), cur), h('div', { class: 'field' }, h('label', {}, 'Nieuw wachtwoord (min. 8 tekens)'), nw), err,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan')));
  });
}
function userDialog(u) {
  return openDialog((close) => {
    const un = h('input', { value: u ? u.username : '', required: true, disabled: !!u, autocapitalize: 'none' });
    const dn = h('input', { value: u ? u.display_name : '' });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: !u, placeholder: u ? 'leeg laten = niet wijzigen' : '' });
    const role = h('select', {}, h('option', { value: 'member', selected: !u || u.role === 'member' }, 'Lid'), h('option', { value: 'admin', selected: u && u.role === 'admin' }, 'Beheerder'));
    const err = h('div', { class: 'error' });
    const patch = async (body) => { try { await api('PATCH', `/api/users/${u.id}`, body); close(true); } catch (ex) { err.textContent = ex.message; } };
    return h('form', { class: 'dlg', onsubmit: async (e) => {
      e.preventDefault();
      try {
        if (!u) { await api('POST', '/api/users', { username: un.value, display_name: dn.value, password: pw.value }); toast('Gebruiker aangemaakt'); close(true); }
        else { const b = { display_name: dn.value, role: role.value }; if (pw.value) b.password = pw.value; await patch(b); }
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('h2', {}, u ? `Beheer ${u.display_name}` : 'Gebruiker toevoegen'),
    h('div', { class: 'field' }, h('label', {}, 'Gebruikersnaam'), un), h('div', { class: 'field' }, h('label', {}, 'Naam'), dn),
    h('div', { class: 'field' }, h('label', {}, 'Wachtwoord'), pw), u && h('div', { class: 'field' }, h('label', {}, 'Rol'), role), err,
    h('div', { class: 'dlg-actions' },
      u && h('button', { class: 'btn danger', type: 'button', onclick: () => patch({ disabled: !u.disabled }) }, u.disabled ? 'Deblokkeren' : 'Blokkeren'),
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan')));
  });
}

// service worker (alleen app-shell; API blijft altijd online)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
