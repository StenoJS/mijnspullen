import { CLIENT_ID, h, flat, icon, api, ApiError, setUnauthorizedHandler, money, num, daysUntil, fmtDate, expiryText, debounce, toast, openDialog, confirmDialog, uploadPhoto, shrinkImage } from './lib.js';
import { nfcSupported, readTag, linkTag } from './nfc.js';
import { qrSvg } from './qr.js';

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
  sel.on = false; sel.ids.clear();
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
    else if (seg[0] === 'labels') await viewLabels(Number(seg[1]) || null, q, token);
    else if (seg[0] === 'shopping') await viewShopping(token);
    else if (seg[0] === 'trash') await viewTrash(token);
    else if (seg[0] === 'duplicates') await viewDuplicates(token);
    else await viewBrowse(null, token);
  } catch (e) {
    if (token !== routeToken || e.status === 401) return;
    const main = shell('Oeps', { back: '#/' });
    main.append(h('div', { class: 'empty' }, e.status === 404 ? 'Dit item bestaat niet (meer).' : e.message, h('br'), h('a', { class: 'btn', href: '#/' }, 'Naar het begin')));
  }
}
const stale = (t) => t !== routeToken;

// ============ selecteren (meerdere tegelijk) ============
const sel = { on: false, ids: new Set(), bar: null, count: null };
function selectBtn(redraw) {
  return h('button', { class: 'btn icon ghost' + (sel.on ? ' primary' : ''), 'aria-label': 'Selecteren', title: 'Meerdere selecteren', onclick: () => { sel.on = !sel.on; sel.ids.clear(); redraw(); } }, icon('select'));
}
function bulkBar(redraw) {
  if (!sel.on) return null;
  const count = h('b', {}, '0 geselecteerd');
  sel.count = () => { count.textContent = `${sel.ids.size} geselecteerd`; };
  const run = async (body, msg) => {
    if (!sel.ids.size) { toast('Selecteer eerst iets', true); return; }
    try { const r = await api('POST', '/api/things/bulk', { ids: [...sel.ids], ...body }); toast(msg(r.done)); sel.on = false; sel.ids.clear(); redraw(); }
    catch (ex) { toast(ex.message, true); }
  };
  const bar = h('div', { class: 'bulkbar' }, h('div', { class: 'bulkbar-in' }, count,
    h('button', { class: 'btn sm', onclick: async () => { const r = await pickLocation(null, null, true); if (r) run({ action: 'move', parent_id: r.id }, (n) => `${n} verplaatst`); } }, icon('move'), 'Verplaatsen'),
    h('button', { class: 'btn sm', onclick: async () => { const t = await pickTag(); if (t) run({ action: t.remove ? 'untag' : 'tag', tag_id: t.id }, (n) => `Tag ${t.remove ? 'weggehaald bij' : 'gezet op'} ${n}`); } }, icon('tag'), 'Tag'),
    h('button', { class: 'btn sm', onclick: () => run({ action: 'list', value: true }, (n) => `${n} op de boodschappenlijst`) }, icon('cart'), 'Op lijst'),
    h('button', { class: 'btn sm danger', onclick: async () => {
      if (!sel.ids.size) return;
      if (await confirmDialog(`${sel.ids.size} dingen verwijderen?`, `Ze gaan naar de prullenbak (Meer → Prullenbak) en zijn daar ${30} dagen terug te zetten. Wat erin zit gaat mee.`)) run({ action: 'delete' }, (n) => `${n} naar de prullenbak`);
    } }, icon('trash'), 'Verwijderen'),
    h('button', { class: 'btn sm ghost', onclick: () => { sel.on = false; sel.ids.clear(); redraw(); } }, 'Klaar')));
  sel.count();
  return bar;
}
async function pickTag() {
  if (!S.tags.length) { toast('Maak eerst een tag aan (tabblad Tags)', true); return null; }
  return openDialog((close) => {
    const remove = h('input', { type: 'checkbox' });
    return h('div', { class: 'dlg' }, h('h2', {}, 'Welke tag?'),
      h('div', { class: 'chips' }, tagsFlat().map((g) => h('button', { class: 'chip', onclick: () => close({ id: g.id, remove: remove.checked }) }, h('span', { class: 'dot', style: `background:${g.color}` }), g.name))),
      h('label', { class: 'check' }, remove, 'Tag juist weghalen'),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Annuleren')));
  });
}

// ============ rijen ============
function badgesFor(t) {
  const b = [];
  if (t.lent_to) b.push(h('span', { class: 'badge lent' }, `Bij ${t.lent_to}`));
  if (!t.is_container && t.min_quantity != null && t.quantity <= t.min_quantity) b.push(h('span', { class: 'badge low' }, 'Bijna op'));
  const d = daysUntil(t.expires_on);
  if (d != null && d <= 30) b.push(h('span', { class: 'badge exp' }, d < 0 ? 'Verlopen' : d === 0 ? 'Vandaag' : `Nog ${d} d`));
  for (const tid of t.tag_ids.slice(0, 3)) { const g = tagById(tid); if (g) b.push(h('span', { class: 'badge tag', style: `background:${g.color}` }, g.name)); }
  return b;
}
function thingRow(t, { showPath } = {}) {
  const go = () => {
    if (sel.on) { if (sel.ids.has(t.id)) sel.ids.delete(t.id); else sel.ids.add(t.id); row.classList.toggle('picked', sel.ids.has(t.id)); sel.count && sel.count(); return; }
    location.hash = t.is_container ? `#/c/${t.id}` : `#/t/${t.id}`;
  };
  const thumb = h('div', { class: 'thumb' }, t.cover_image_id ? h('img', { src: `/api/images/${t.cover_image_id}?thumb=1`, loading: 'lazy', alt: '' }) : icon(t.is_container ? 'folder' : 'box'));
  let sub = '';
  if (showPath && t.path.length) sub = t.path.map((p) => p.name).join(' › ');
  else if (t.is_container) sub = t.child_count === 1 ? '1 onderdeel' : `${t.child_count} onderdelen`;
  else if (t.description) sub = t.description;
  const row = h('div', { class: 'row' + (t.is_container ? ' container' : '') + (sel.on && sel.ids.has(t.id) ? ' picked' : ''), role: 'link', tabindex: '0', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
    sel.on && h('span', { class: 'pickbox' }, icon('check')),
    thumb,
    h('div', { class: 'main' }, h('div', { class: 'name' }, (t.favourite ? '★ ' : '') + t.name), sub && h('div', { class: 'sub' }, sub), h('div', { class: 'badges' }, badgesFor(t))));
  if (!t.is_container && !sel.on) {
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
      actions: [selectBtn(load), h('a', { class: 'btn icon ghost', href: `#/labels/${id || 0}`, 'aria-label': 'Labels printen', title: 'Labels printen' }, icon('qr')),
        c && h('a', { class: 'btn icon ghost', href: `#/t/${c.id}`, 'aria-label': 'Bewerken' }, icon('more')), scanBtn(id)],
    });
    if (!c) {
      const s = stats.stats;
      main.append(
        h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); location.hash = `#/search?q=${encodeURIComponent(e.target.q.value)}`; } }, icon('search'), h('input', { name: 'q', placeholder: 'Zoek in al je spullen…', type: 'search', 'aria-label': 'Zoeken' })),
        h('div', { class: 'stats' },
          h('a', { class: 'stat', href: '#/search' }, h('b', {}, num(s.items)), h('span', {}, 'items')),
          h('a', { class: 'stat' + (s.shopping ? ' alert' : ''), href: '#/shopping' }, h('b', {}, num(s.shopping)), h('span', {}, 'boodschappen')),
          h('a', { class: 'stat' + (s.expiring ? ' warn' : ''), href: '#/search?expiring=30' }, h('b', {}, num(s.expiring)), h('span', {}, 'verloopt')),
          h('a', { class: 'stat', href: '#/search?lent=1' }, h('b', {}, num(s.lent)), h('span', {}, 'uitgeleend'))));
    } else {
      main.append(h('nav', { class: 'crumbs', 'aria-label': 'Locatie' }, h('a', { href: '#/' }, 'Alles'), c.path.map((p) => [' › ', h('a', { href: `#/c/${p.id}` }, p.name)]), ' › ', h('b', {}, c.name)));
    }
    if (!list.things.length) {
      main.append(h('div', { class: 'empty' }, c ? 'Hier staat nog niets.' : 'Begin met een plek, bijvoorbeeld "Huis" of "Zolder".', h('br'),
        h('a', { class: 'btn primary', href: `#/new?container=1${id ? `&parent=${id}` : ''}` }, icon('plus'), 'Nieuwe container')));
    } else {
      main.append(h('div', { class: 'list' }, list.things.map((t) => thingRow(t))));
    }
    if (sel.on) main.append(bulkBar(load));
    else main.append(h('button', { class: 'fab', 'aria-label': 'Toevoegen', onclick: () => addDialog(id) }, icon('plus')));
  };
  refresh = () => load().catch(() => {});
  await load();
}
function addDialog(parent) {
  const p = parent ? `&parent=${parent}` : '';
  openDialog((close) => h('div', { class: 'dlg' }, h('h2', {}, 'Toevoegen'),
    h('a', { class: 'btn primary', href: `#/new?container=0${p}`, onclick: () => close() }, icon('box'), 'Nieuw item'),
    h('a', { class: 'btn', href: `#/new?container=1${p}`, onclick: () => close() }, icon('folder'), 'Nieuwe container (kamer, kast, doos…)'),
    h('button', { class: 'btn', onclick: () => { close(); serialScan(parent); } }, icon('scan'), 'Scannen in serie (meerdere producten)'),
    h('button', { class: 'btn ghost', onclick: () => close() }, 'Annuleren')));
}

// ============ zoeken ============
async function viewSearch(q, token) {
  const state = { q: q.q || '', low: q.low === '1', expiring: q.expiring || '', favourite: q.favourite === '1', tag: q.tag || '', lent: q.lent === '1' };
  const barBox = h('div');
  const redraw = () => { sb.classList.toggle('primary', sel.on); barBox.replaceChildren(...flat(bulkBar(redraw))); run().catch(() => {}); };
  const sb = h('button', { class: 'btn icon ghost', 'aria-label': 'Selecteren', title: 'Meerdere selecteren', onclick: () => { sel.on = !sel.on; sel.ids.clear(); redraw(); } }, icon('select'));
  const main = shell('Zoeken', { tab: 'search', actions: [sb, scanBtn(null)] });
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
    if (state.lent) p.set('lent', '1');
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
      chip('Uitgeleend', state.lent, () => { state.lent = !state.lent; }),
      tagsFlat().map((t) => chip(t.name, state.tag === String(t.id), () => { state.tag = state.tag === String(t.id) ? '' : String(t.id); }, t.color))));
  };
  input.addEventListener('input', debounce(() => { state.q = input.value.trim(); run().catch((e) => toast(e.message, true)); }, 250));
  main.append(h('div', { class: 'search' }, icon('search'), input), chipBox, results, barBox);
  drawChips();
  refresh = () => run().catch(() => {});
  await run();
  if (!state.q && !q.low && !q.expiring && !q.lent) input.focus();
}

// ============ scannen ============
// Controlegetal van EAN-13/EAN-8/UPC-A: voorkomt half gelezen streepjescodes.
function validEan(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return true;
  const d = code.split('').map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
// Link naar een item/container in deze app (van een eigen QR-label of NFC-tag)?
function ownRoute(text) {
  try {
    const u = new URL(text);
    if (u.origin !== location.origin) return null;
    const m = /^#\/(c|t)\/(\d+)$/.exec(u.hash);
    return m ? `#/${m[1]}/${m[2]}` : null;
  } catch { return null; }
}
function scanDialog({ nfc = false } = {}) {
  return openDialog((close) => {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const wrap = h('div', { class: 'video-wrap' }, video, h('div', { class: 'aim' }));
    const note = h('div', { class: 'meta' }, 'Houd de barcode of QR-code in het kader…');
    const tools = h('div', { class: 'scan-tools' });
    const manual = h('input', { placeholder: 'Of typ de code hier', inputmode: 'text', 'aria-label': 'Code' });
    const ctl = new AbortController();
    let stream = null, done = false;
    const finish = (v) => {
      if (done) return; done = true;
      if (v) navigator.vibrate?.(40);
      stream && stream.getTracks().forEach((t) => t.stop());
      ctl.abort(); close(v);
    };
    const nfcNote = nfc && nfcSupported() && h('div', { class: 'nfc-hint' }, icon('nfc'), 'Of houd je telefoon bij een NFC-tag');
    if (nfcNote) readTag(ctl.signal).then((r) => finish({ nfc: r.serial, url: r.url })).catch(() => { if (!done) nfcNote.remove(); });
    (async () => {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
        note.textContent = 'Camera-scan wordt door deze browser niet ondersteund (bijv. Safari). Typ de code hieronder.'; wrap.style.display = 'none'; return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream; await video.play();
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        if (caps.torch) {
          let on = false;
          tools.append(h('button', { class: 'btn sm', type: 'button', onclick: async (e) => {
            on = !on; const b = e.currentTarget;
            try { await track.applyConstraints({ advanced: [{ torch: on }] }); b.classList.toggle('primary', on); } catch { /* */ }
          } }, icon('flash'), 'Lamp'));
        }
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          tools.append(h('label', { class: 'zoom' }, 'Zoom', h('input', { type: 'range', min: caps.zoom.min, max: Math.min(caps.zoom.max, caps.zoom.min * 4 || 4), step: caps.zoom.step || 0.1, value: caps.zoom.min,
            oninput: (e) => track.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }).catch(() => {}) })));
        }
        const formats = await BarcodeDetector.getSupportedFormats().catch(() => []);
        const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix', 'aztec', 'pdf417'];
        const det = new BarcodeDetector({ formats: formats.length ? want.filter((f) => formats.includes(f)) : want });
        let last = '', hits = 0;
        const tick = async () => {
          if (done || !video.isConnected) { stream.getTracks().forEach((t) => t.stop()); return; }
          try {
            const codes = await det.detect(video);
            const c = codes.find((x) => x.rawValue && (x.format === 'qr_code' || validEan(x.rawValue)));
            if (c) {
              // 2D-codes zijn betrouwbaar; voor streepjescodes twee keer dezelfde lezing eisen.
              hits = c.rawValue === last ? hits + 1 : 1; last = c.rawValue;
              if (hits >= (['qr_code', 'data_matrix', 'aztec', 'pdf417'].includes(c.format) ? 1 : 2)) return finish(c.rawValue);
            }
          } catch { /* volgende frame */ }
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => tick()); else setTimeout(tick, 120);
        };
        tick();
      } catch { note.textContent = 'Geen cameratoegang (HTTPS en toestemming nodig). Typ de code hieronder.'; wrap.style.display = 'none'; }
    })();
    return h('form', { class: 'dlg', onsubmit: (e) => { e.preventDefault(); if (manual.value.trim()) finish(manual.value.trim()); } },
      h('h2', {}, 'Scannen'), wrap, tools, note, nfcNote,
      h('div', { class: 'inline' }, manual, h('button', { class: 'btn primary', type: 'submit' }, 'OK')),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => finish(undefined) }, 'Sluiten')));
  });
}
async function scanAndGo(parentId) {
  const res = await scanDialog({ nfc: true });
  if (!res) return;
  const inParent = parentId ? `&parent=${parentId}` : '';
  try {
    if (typeof res === 'object') {
      const own = res.url && ownRoute(res.url);
      if (own) { location.hash = own; return; }
      if (!res.nfc) { toast('Deze NFC-tag heeft geen serienummer en geen link van Mijn Spullen', true); return; }
      const r = await api('GET', `/api/things?nfc=${encodeURIComponent(res.nfc)}`);
      if (r.things.length) { location.hash = r.things[0].is_container ? `#/c/${r.things[0].id}` : `#/t/${r.things[0].id}`; return; }
      const choice = await openDialog((close) => h('div', { class: 'dlg' }, h('h2', {}, 'Nieuwe NFC-tag'),
        h('p', { style: 'margin:0;color:var(--muted)' }, 'Deze tag is nog nergens aan gekoppeld. Wat wil je ermee?'),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', onclick: () => close() }, 'Niets'),
          h('button', { class: 'btn', onclick: () => close('0') }, 'Nieuw item'),
          h('button', { class: 'btn primary', onclick: () => close('1') }, 'Nieuwe container'))));
      if (choice) location.hash = `#/new?container=${choice}&nfc=${encodeURIComponent(res.nfc)}${inParent}`;
      return;
    }
    const own = ownRoute(res);
    if (own) { location.hash = own; return; }
    const r = await api('GET', `/api/things?barcode=${encodeURIComponent(res)}`);
    if (r.things.length === 1) { location.hash = r.things[0].is_container ? `#/c/${r.things[0].id}` : `#/t/${r.things[0].id}`; return; }
    if (r.things.length > 1) { location.hash = `#/search?q=${encodeURIComponent(res)}`; return; }
    const ok = await confirmDialog('Niet gevonden', `Er is nog niets met code "${res}". Nieuw item aanmaken?`, 'Nieuw item', false);
    if (ok) location.hash = `#/new?container=0&barcode=${encodeURIComponent(res)}${inParent}`;
  } catch (e) { toast(e.message, true); }
}

// ============ locatie kiezen ============
async function pickLocation(excludeId, currentId, onlyContainers) {
  const { nodes } = await api('GET', '/api/tree');
  const kids = new Map();
  nodes.forEach((n) => { const k = n.parent_id || 0; (kids.get(k) || kids.set(k, []).get(k)).push(n); });
  const banned = new Set();
  if (excludeId) { const walk = (i) => { banned.add(i); (kids.get(i) || []).forEach((c) => walk(c.id)); }; walk(excludeId); }
  return openDialog((close) => {
    const rows = [h('button', { class: 'pick' + (!currentId ? ' cur' : ''), type: 'button', onclick: () => close({ id: null }) }, icon('home'), 'Hoofdniveau (geen locatie)')];
    const walk = (pid, depth) => (kids.get(pid) || []).forEach((n) => {
      if (banned.has(n.id) || (onlyContainers && !n.is_container)) return;
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
    ? { is_container: q.container === '1', name: '', description: '', notes: '', quantity: 1, min_quantity: '', barcode: q.barcode || '', nfc_id: q.nfc || null, price: '', expires_on: '', favourite: false, parent_id: q.parent ? Number(q.parent) : null, tag_ids: [], path: [] }
    : { ...t, min_quantity: t.min_quantity ?? '', barcode: t.barcode || '', price: t.price ?? '', expires_on: t.expires_on || '', lent_to: t.lent_to || '', lent_due: t.lent_due || '' };
  if (isNew && f.parent_id) { const p = (await api('GET', `/api/things/${f.parent_id}`).catch(() => null)); if (p) f.path = [...p.thing.path, { id: p.thing.id, name: p.thing.name }]; else f.parent_id = null; }
  const pending = []; // foto's voor een nog niet opgeslagen item
  let pendingImageUrl = null; // productfoto uit Open Food Facts, wordt na opslaan overgenomen
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
  const lookupBtn = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Product opzoeken', title: 'Product opzoeken', onclick: () => lookup(true) }, icon('search'));
  const lookup = async (loud) => {
    const code = String(f.barcode || '').trim();
    if (!/^\d{6,14}$/.test(code)) { if (loud) toast('Opzoeken werkt met een EAN/UPC-streepjescode', true); return; }
    lookupBtn.disabled = true;
    try {
      const { product: p } = await api('GET', `/api/lookup/${code}`);
      if (!p) { if (loud) toast('Niet gevonden in Open Food Facts'); return; }
      if (!f.name || loud) { f.name = p.name; nameI.value = p.name; }
      if (p.description && !f.description) { f.description = p.description; descI.value = p.description; }
      dirty = true;
      if (p.image_url && !images.length && !pending.length) {
        if (isNew) pendingImageUrl = p.image_url;
        else { try { images.push((await api('POST', `/api/things/${id}/images/import`, { url: p.image_url })).image); drawPhotos(); } catch { /* geen foto, geen probleem */ } }
      }
      toast(`Gevonden: ${p.name}${p.image_url && (isNew ? pendingImageUrl : true) ? ' (met productfoto)' : ''}`);
      drawPhotos();
    } catch (ex) { if (loud) toast(ex.message, true); } finally { lookupBtn.disabled = false; }
  };

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
  const camI = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none', onchange: (e) => fileI.onchange(e) });
  const fileI = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  fileI.onchange = async (e) => {
    for (const file of e.target.files) {
      try {
        if (isNew) pending.push(file);
        else images.push(await uploadPhoto(id, file));
      } catch (ex) { toast(ex.message, true); }
    }
    e.target.value = ''; drawPhotos();
  };
  const drawPhotos = () => photoBox.replaceChildren(...flat(
    images.map((im) => h('div', { class: 'photo', onclick: () => window.open(`/api/images/${im.id}`, '_blank') },
      h('img', { src: `/api/images/${im.id}?thumb=1`, alt: '' }),
      h('button', { type: 'button', 'aria-label': 'Foto verwijderen', onclick: async (e) => { e.stopPropagation(); if (!await confirmDialog('Foto verwijderen?', 'Deze foto wordt definitief verwijderd.')) return; try { await api('DELETE', `/api/images/${im.id}`); images = images.filter((x) => x.id !== im.id); drawPhotos(); } catch (ex) { toast(ex.message, true); } } }, icon('x')))),
    pending.map((file, i) => h('div', { class: 'photo' }, h('img', { src: URL.createObjectURL(file), alt: '' }), h('button', { type: 'button', 'aria-label': 'Verwijderen', onclick: () => { pending.splice(i, 1); drawPhotos(); } }, icon('x')))),
    pendingImageUrl && h('div', { class: 'photo pending-url' }, icon('image'), h('small', {}, 'productfoto'), h('button', { type: 'button', 'aria-label': 'Niet gebruiken', onclick: () => { pendingImageUrl = null; drawPhotos(); } }, icon('x'))),
    h('button', { type: 'button', class: 'addphoto', 'aria-label': 'Foto maken', title: 'Foto maken', onclick: () => camI.click() }, icon('camera')),
    h('button', { type: 'button', class: 'addphoto', 'aria-label': 'Foto uit galerij', title: 'Uit galerij', onclick: () => fileI.click() }, icon('image'))));
  drawPhotos();

  const descI = h('input', { value: f.description, maxlength: 2000, oninput: (e) => { f.description = e.target.value; dirty = true; } });
  const nfcField = h('div', { class: 'field' });
  const drawNfc = () => nfcField.replaceChildren(...flat(
    h('span', { class: 'label' }, 'NFC-tag'),
    h('div', { class: 'inline' },
      h('span', { class: 'nfc-state' + (f.nfc_id ? ' on' : '') }, icon('nfc'), f.nfc_id ? `Gekoppeld (${f.nfc_id})` : 'Geen tag gekoppeld'),
      !isNew && nfcSupported() && h('button', { class: 'btn sm', type: 'button', onclick: () => nfcLinkDialog(t).then((serial) => { if (serial !== undefined) { f.nfc_id = serial; t.version++; drawNfc(); } }) }, f.nfc_id ? 'Opnieuw' : 'Koppelen'),
      f.nfc_id && h('button', { class: 'btn sm danger', type: 'button', onclick: () => { f.nfc_id = null; dirty = true; drawNfc(); } }, 'Loskoppelen')),
    isNew && !f.nfc_id && nfcSupported() && h('div', { class: 'meta' }, 'Na opslaan kun je hier een tag koppelen.'),
    !nfcSupported() && !f.nfc_id && h('div', { class: 'meta' }, 'NFC werkt in Chrome op Android. Je kunt ook een QR-label printen.')));
  drawNfc();
  // uitlenen + boodschappenlijst (alleen voor items)
  const lendTo = h('input', { value: f.lent_to || '', maxlength: 100, placeholder: 'Naam, bijv. Buurman Henk', oninput: (e) => { f.lent_to = e.target.value; dirty = true; } });
  const lendDue = h('input', { type: 'date', value: f.lent_due || '', oninput: (e) => { f.lent_due = e.target.value; dirty = true; } });
  const lendBox = h('div', { class: 'field' }, h('span', { class: 'label' }, 'Uitgeleend aan'),
    h('div', { class: 'lend-box' },
      h('div', { class: 'grid2' }, lendTo, lendDue),
      !isNew && t.lent_to && h('div', { class: 'switch-row' }, h('span', { class: 'meta', style: 'margin:0' }, `Sinds ${fmtDate(t.lent_at)}${t.lent_due ? ` · terug op ${t.lent_due}` : ''}`),
        h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
          try { await api('PATCH', `/api/things/${id}`, { lent_to: '', version: t.version }); toast(`"${t.name}" is terug`); dirty = false; route(); } catch (ex) { toast(ex.message, true); }
        } }, icon('undo'), 'Is terug'))));
  const listBtn = h('button', { type: 'button', class: 'btn sm' + (f.on_list ? ' primary' : ''), onclick: (e) => { f.on_list = !f.on_list; dirty = true; e.currentTarget.classList.toggle('primary', !!f.on_list); } }, icon('cart'), 'Op boodschappenlijst');
  itemOnly.push(lendBox, listBtn);
  if (f.is_container) [lendBox, listBtn].forEach((el) => { el.style.display = 'none'; });
  const favBtn = h('button', { type: 'button', class: 'btn sm', onclick: (e) => { f.favourite = !f.favourite; dirty = true; e.currentTarget.classList.toggle('primary', f.favourite); } }, icon('star'), 'Favoriet');
  if (f.favourite) favBtn.classList.add('primary');

  const save = async (ev) => {
    ev.preventDefault(); err.textContent = '';
    const body = {
      name: f.name, is_container: f.is_container, description: f.description, notes: f.notes, barcode: f.barcode,
      expires_on: f.expires_on, favourite: f.favourite, parent_id: f.parent_id, tag_ids: f.tag_ids, nfc_id: f.nfc_id || null,
      ...(f.is_container ? {} : { lent_to: f.lent_to || '', lent_due: f.lent_to ? f.lent_due : '', on_list: !!f.on_list }),
      quantity: f.is_container ? (f.quantity === '' ? 1 : f.quantity) : f.quantity, min_quantity: f.is_container ? '' : f.min_quantity, price: f.is_container ? '' : f.price,
    };
    saveBtn.disabled = true;
    try {
      if (isNew) {
        const r = await api('POST', '/api/things', body);
        for (const file of pending) { try { await uploadPhoto(r.thing.id, file); } catch (ex) { toast(ex.message, true); } }
        if (pendingImageUrl && !pending.length) await api('POST', `/api/things/${r.thing.id}/images/import`, { url: pendingImageUrl }).catch(() => {});
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
    h('div', { class: 'field' }, h('label', {}, "Foto's"), photoBox, fileI, camI),
    h('div', { class: 'field' }, h('label', {}, 'Tags'), tagBox),
    h('div', { class: 'grid2' }, priceF, h('div', { class: 'field' }, h('label', {}, 'Houdbaar tot'), inp('expires_on', { type: 'date' }))),
    h('div', { class: 'field' }, h('label', {}, 'Barcode / QR'), h('div', { class: 'inline' }, barcodeI, lookupBtn, scanInto)),
    h('div', { class: 'field' }, h('label', {}, 'Omschrijving'), descI),
    nfcField,
    lendBox,
    h('div', { class: 'field' }, h('label', {}, 'Notities'), h('textarea', { oninput: (e) => { f.notes = e.target.value; dirty = true; } }, f.notes)),
    h('div', { class: 'actions' }, favBtn, listBtn),
    !isNew && h('div', { class: 'meta' }, `Aangemaakt door ${t.created_by_name || 'onbekend'} op ${fmtDate(t.created_at)}`, h('br'), `Laatst gewijzigd door ${t.updated_by_name || 'onbekend'} op ${fmtDate(t.updated_at)}`, t.expires_on ? h('br') : null, t.expires_on ? expiryText(t.expires_on) : null),
    err,
    h('div', { class: 'actions' }, saveBtn,
      !isNew && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        const kids = t.child_count;
        if (!await confirmDialog(`"${t.name}" verwijderen?`, kids ? `Alles wat erin zit gaat mee (${kids} direct onderdeel${kids === 1 ? '' : 'en'} en dieper). Je kunt het 30 dagen terugzetten vanuit de prullenbak.` : 'Je kunt het 30 dagen terugzetten vanuit de prullenbak (Meer → Prullenbak).')) return;
        try {
          const r = await api('DELETE', `/api/things/${id}`);
          toast(`"${t.name}" naar de prullenbak`, false, { label: 'Ongedaan maken', fn: async () => { try { const x = await api('POST', `/api/trash/${r.trash_id}/restore`); toast('Teruggezet'); location.hash = x.thing.is_container ? `#/c/${x.thing.id}` : `#/t/${x.thing.id}`; } catch (ex) { toast(ex.message, true); } } });
          location.hash = back;
        } catch (ex) { toast(ex.message, true); }
      } }, icon('trash'), 'Verwijderen')));
  const labelCard = !isNew && h('div', { class: 'card label-card' },
    h('div', { class: 'qr-mini' }, qrSvg(thingUrl(t))),
    h('div', { class: 'main' }, h('b', {}, 'Label & NFC'), h('div', { class: 'sub' }, 'Scan deze QR-code of tik de NFC-tag aan om hier direct te komen.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn sm', href: `#/labels/${t.id}?only=1` }, icon('print'), 'Label printen'))));
  main.append(bannerBox, form, labelCard);
  if (isNew) nameI.focus();
  if (isNew && f.barcode && !f.name) lookup(false);

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

// ============ boodschappen ============
async function viewShopping(token) {
  const load = async () => {
    const [r, integ] = await Promise.all([api('GET', '/api/things?shopping=1&sort=name&limit=500'), api('GET', '/api/integrations')]);
    if (stale(token)) return;
    const main = shell('Boodschappen', { back: '#/', tab: 'home' });
    main.append(h('p', { class: 'meta', style: 'margin:0 0 10px' }, 'Alles wat bijna op is (aantal ≤ meldgrens) en wat je zelf op de lijst zette. Na "Gekocht" gaat het aantal omhoog en verdwijnt het van de lijst.'));
    if (!r.things.length) { main.append(h('div', { class: 'empty' }, 'Niets nodig. Zet iets op de lijst via een item, of geef items een meldgrens ("Melden bij ≤").')); return; }
    main.append(h('div', { class: 'list' }, r.things.map((t) => {
      const need = t.min_quantity != null ? Math.max(1, t.min_quantity - t.quantity + 1) : 1;
      return h('div', { class: 'row shop-row' },
        h('div', { class: 'thumb' }, t.cover_image_id ? h('img', { src: `/api/images/${t.cover_image_id}?thumb=1`, loading: 'lazy', alt: '' }) : icon('box')),
        h('a', { class: 'main', href: `#/t/${t.id}`, style: 'text-decoration:none;color:inherit' }, h('div', { class: 'name' }, t.name),
          h('div', { class: 'need' }, `Nog ${num(t.quantity)}${t.min_quantity != null ? ` · melden bij ≤ ${num(t.min_quantity)}` : ' · zelf op de lijst gezet'}${t.path.length ? ` · ${t.path.map((p) => p.name).join(' › ')}` : ''}`)),
        h('button', { class: 'btn sm primary', onclick: async () => {
          const n = await openDialog((close) => {
            const q = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: need });
            return h('form', { class: 'dlg', onsubmit: (e) => { e.preventDefault(); close(Number(q.value)); } }, h('h2', {}, `${t.name} gekocht`),
              h('div', { class: 'field' }, h('label', {}, 'Hoeveel erbij?'), q),
              h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan')));
          });
          if (n == null || Number.isNaN(n)) return;
          try { await api('POST', `/api/things/${t.id}/bought`, { quantity: n }); toast(`${t.name}: +${num(n)}`); load(); } catch (ex) { toast(ex.message, true); }
        } }, icon('check'), 'Gekocht'));
    })));
    main.append(h('div', { class: 'actions', style: 'margin-top:14px' },
      integ.haConfigured && h('button', { class: 'btn', onclick: async () => { try { const x = await api('POST', '/api/shopping/send'); toast(`${x.sent} producten naar Home Assistant gestuurd`); } catch (ex) { toast(ex.message, true); } } }, icon('home'), 'Stuur naar Home Assistant'),
      h('button', { class: 'btn', onclick: async () => {
        const text = r.things.map((t) => `- ${t.name}`).join('\n');
        try { if (navigator.share) await navigator.share({ title: 'Boodschappen', text }); else { await navigator.clipboard.writeText(text); toast('Lijst gekopieerd'); } } catch { /* geannuleerd */ }
      } }, icon('upload'), 'Delen / kopiëren')));
  };
  refresh = () => load().catch(() => {});
  await load();
}

// ============ prullenbak ============
async function viewTrash(token) {
  const load = async () => {
    const r = await api('GET', '/api/trash');
    if (stale(token)) return;
    const isAdmin = S.me.role === 'admin';
    const main = shell('Prullenbak', { back: '#/more', tab: 'more' });
    main.append(h('p', { class: 'meta', style: 'margin:0 0 10px' }, `Verwijderde spullen blijven hier ${r.days} dagen staan, inclusief alles wat erin zat en de foto's. Terugzetten gebeurt op de oude plek (of op het hoofdniveau als die niet meer bestaat).`));
    if (!r.items.length) { main.append(h('div', { class: 'empty' }, 'De prullenbak is leeg.')); return; }
    main.append(h('div', { class: 'list' }, r.items.map((x) => h('div', { class: 'row trash-row' },
      h('div', { class: 'thumb' }, icon(x.is_container ? 'folder' : 'box')),
      h('div', { class: 'main' }, h('div', { class: 'name' }, x.name), h('div', { class: 'sub' }, `${x.item_count > 1 ? `met ${x.item_count - 1} onderdelen · ` : ''}${x.deleted_by || 'iemand'} · ${fmtDate(x.deleted_at)}`)),
      h('button', { class: 'btn sm primary', onclick: async () => { try { await api('POST', `/api/trash/${x.id}/restore`); toast(`"${x.name}" teruggezet`); load(); } catch (ex) { toast(ex.message, true); } } }, icon('undo'), 'Terug'),
      isAdmin && h('button', { class: 'btn sm danger', 'aria-label': 'Definitief verwijderen', onclick: async () => { if (!await confirmDialog(`"${x.name}" definitief verwijderen?`, 'Dit kan niet ongedaan worden gemaakt.')) return; await api('DELETE', `/api/trash/${x.id}`); load(); } }, icon('trash'))))));
    if (isAdmin) main.append(h('div', { class: 'actions', style: 'margin-top:14px' }, h('button', { class: 'btn danger', onclick: async () => { if (!await confirmDialog('Prullenbak legen?', 'Alles hierin wordt definitief verwijderd, inclusief foto\'s.')) return; await api('DELETE', '/api/trash'); load(); } }, icon('trash'), 'Prullenbak legen')));
  };
  refresh = () => load().catch(() => {});
  await load();
}

// ============ dubbelen ============
async function viewDuplicates(token) {
  const load = async () => {
    const r = await api('GET', '/api/duplicates');
    if (stale(token)) return;
    const isAdmin = S.me.role === 'admin';
    const main = shell('Dubbelen', { back: '#/more', tab: 'more' });
    const byName = r.groups.filter((g) => g.kind === 'name');
    main.append(h('p', { class: 'meta', style: 'margin:0 0 10px' }, 'Spullen met dezelfde naam op dezelfde plek. Kies welke blijft: tags, foto\'s en lege velden van de andere gaan daarheen, de inhoud van containers wordt mee samengevoegd. De overgebleven kopie gaat naar de prullenbak.'));
    if (!r.groups.length) { main.append(h('div', { class: 'empty' }, 'Geen dubbelen gevonden.')); return; }
    if (isAdmin && byName.length > 1) {
      main.append(h('div', { class: 'actions', style: 'margin:0 0 14px' }, h('button', { class: 'btn primary', onclick: async () => {
        if (!await confirmDialog(`${byName.length} groepen in één keer samenvoegen?`, 'Per groep blijft de kopie met de meeste foto\'s. Aantallen worden niet opgeteld. Er wordt eerst een back-up gemaakt.')) return;
        try { const x = await api('POST', '/api/duplicates/merge-all', {}); toast(`${x.merged} dubbelen samengevoegd in ${x.groups} groepen`); load(); } catch (ex) { toast(ex.message, true); }
      } }, icon('link'), `Alles samenvoegen (${byName.length})`)));
    }
    for (const g of r.groups) {
      let keep = g.keep_id;
      const sum = h('input', { type: 'checkbox' });
      const rows = g.things.map((t) => {
        const radio = h('input', { type: 'radio', name: `keep-${g.key}`, checked: t.id === keep, onchange: () => { keep = t.id; } });
        const facts = g.is_container
          ? [`${t.subtree.count} onderdelen`, `${t.subtree.images} foto's`]
          : [`aantal ${num(t.quantity)}`, `${t.image_ids.length} foto's`, t.tag_ids.length ? `${t.tag_ids.length} tags` : null, t.barcode && g.kind !== 'barcode' ? 'barcode' : null];
        return h('div', { class: 'row dup-row', onclick: () => { radio.checked = true; keep = t.id; } }, radio,
          h('div', { class: 'thumb' }, t.cover_image_id ? h('img', { src: `/api/images/${t.cover_image_id}?thumb=1`, loading: 'lazy', alt: '' }) : icon(t.is_container ? 'folder' : 'box')),
          h('div', { class: 'main' }, h('div', { class: 'name' }, t.name),
            h('div', { class: 'sub' }, [t.path.map((p) => p.name).join(' › ') || 'Hoofdniveau', ...facts.filter(Boolean)].join(' · '))),
          h('a', { class: 'btn icon ghost', href: `#/${t.is_container ? 'c' : 't'}/${t.id}`, 'aria-label': 'Openen', onclick: (e) => e.stopPropagation() }, icon('chevron')));
      });
      main.append(h('div', { class: 'card dup-card' },
        h('div', { class: 'dup-head' }, h('b', {}, g.name), h('span', { class: 'meta' }, g.kind === 'barcode' ? `zelfde barcode ${g.barcode}` : `${g.things.length}×${g.is_container ? ' container' : ''}`)),
        h('div', { class: 'list' }, rows),
        h('div', { class: 'actions', style: 'margin-top:8px' },
          !g.is_container && h('label', { class: 'check' }, sum, 'Aantallen optellen'),
          h('button', { class: 'btn primary', onclick: async () => {
            try { const x = await api('POST', '/api/duplicates/merge', { keep_id: keep, drop_ids: g.things.map((t) => t.id).filter((id) => id !== keep), sum_quantity: sum.checked }); toast(`${x.merged} samengevoegd`); load(); }
            catch (ex) { toast(ex.message, true); }
          } }, icon('link'), 'Samenvoegen'))));
    }
    if (r.hidden) main.append(h('p', { class: 'meta' }, `${r.hidden} groepen binnen deze containers worden vanzelf mee samengevoegd.`));
  };
  refresh = () => load().catch(() => {});
  await load();
}

// ============ scannen in serie ============
// Camera blijft open: bekende code in deze container → +1, elders → melding, onbekend → nieuw item (met productgegevens).
function serialScan(parentId) {
  return openDialog((close) => {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const wrap = h('div', { class: 'video-wrap' }, video, h('div', { class: 'aim' }));
    const log = h('div', { class: 'serial-log' });
    const note = h('div', { class: 'meta', style: 'margin:0' }, parentId ? 'Scan het ene product na het andere. Bestaand in deze container: +1. Nieuw: wordt hier toegevoegd.' : 'Scan het ene product na het andere. Bestaand: +1. Nieuw: komt op het hoofdniveau.');
    const manual = h('input', { placeholder: 'Of typ een code', inputmode: 'numeric', 'aria-label': 'Code' });
    let stream = null, done = false, count = 0;
    const recent = new Map();
    const add = (cls, text) => { log.prepend(h('div', { class: cls }, text)); };
    const handle = async (code) => {
      const last = recent.get(code);
      if (last && Date.now() - last < 2500) return; // zelfde code die nog voor de camera hangt
      recent.set(code, Date.now());
      navigator.vibrate?.(40);
      try {
        const found = (await api('GET', `/api/things?barcode=${encodeURIComponent(code)}`)).things.filter((x) => !x.is_container);
        const here = found.find((x) => (x.parent_id || null) === (parentId || null));
        if (here) { const r = await api('POST', `/api/things/${here.id}/adjust`, { delta: 1 }); add('', `+1 ${here.name} (nu ${num(r.thing.quantity)})`); count++; return; }
        if (found.length) { add('err', `${found[0].name} staat al in ${found[0].path.map((p) => p.name).join(' › ') || 'het hoofdniveau'}; niet dubbel aangemaakt`); return; }
        const p = (await api('GET', `/api/lookup/${encodeURIComponent(code)}`).catch(() => ({}))).product;
        const t = (await api('POST', '/api/things', { name: p ? p.name : `Onbekend product ${code}`, description: p ? p.description : '', barcode: code, quantity: 1, parent_id: parentId || null })).thing;
        if (p && p.image_url) api('POST', `/api/things/${t.id}/images/import`, { url: p.image_url }).catch(() => {});
        add('new', `Nieuw: ${t.name}`); count++;
      } catch (ex) { add('err', `${code}: ${ex.message}`); }
    };
    const finish = () => { done = true; stream && stream.getTracks().forEach((x) => x.stop()); close(count); if (count) { toast(`${count} gescand`); if (refresh) refresh(); } };
    (async () => {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { wrap.style.display = 'none'; note.textContent = 'Camera-scan werkt niet in deze browser; typ de codes hieronder.'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        video.srcObject = stream; await video.play();
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
        let lastV = '', hits = 0;
        const tick = async () => {
          if (done || !video.isConnected) { stream.getTracks().forEach((x) => x.stop()); return; }
          try {
            const c = (await det.detect(video)).find((x) => x.rawValue && (x.format === 'qr_code' || validEan(x.rawValue)));
            if (c) { hits = c.rawValue === lastV ? hits + 1 : 1; lastV = c.rawValue; if (hits >= 2) { hits = 0; handle(c.rawValue); } }
          } catch { /* */ }
          setTimeout(tick, 150);
        };
        tick();
      } catch { wrap.style.display = 'none'; note.textContent = 'Geen cameratoegang; typ de codes hieronder.'; }
    })();
    return h('form', { class: 'dlg', onsubmit: (e) => { e.preventDefault(); const v = manual.value.trim(); if (v) { recent.delete(v); handle(v); manual.value = ''; } } },
      h('h2', {}, 'Scannen in serie'), wrap, note, log,
      h('div', { class: 'inline' }, manual, h('button', { class: 'btn', type: 'submit' }, 'Toevoegen')),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: finish }, 'Klaar')));
  });
}

// ============ NFC & labels ============
const thingUrl = (t) => `${location.origin}/#/${t.is_container ? 'c' : 't'}/${t.id}`;

// Tag koppelen: serienummer opslaan én de link op de tag zetten (werkt dan ook zonder dat de app open is).
function nfcLinkDialog(t) {
  return openDialog((close) => {
    const ctl = new AbortController();
    const note = h('p', { class: 'nfc-wait' }, icon('nfc'), 'Houd een NFC-tag tegen de achterkant van je telefoon…');
    const stop = (v) => { ctl.abort(); close(v); };
    linkTag(thingUrl(t), ctl.signal).then(async ({ serial, wrote, writeError }) => {
      if (!serial && !wrote) { note.textContent = `Kon niet op deze tag schrijven (${writeError ? writeError.message : 'onbekend'}).`; return; }
      try {
        if (serial) await api('PATCH', `/api/things/${t.id}`, { nfc_id: serial });
        toast(wrote ? 'NFC-tag gekoppeld en beschreven' : 'NFC-tag gekoppeld (alleen-lezen tag: werkt via de scanknop in de app)');
        stop(serial || null);
      } catch (ex) { note.textContent = ex.message; }
    }).catch((e) => {
      if (e.name === 'AbortError') return;
      note.textContent = e.name === 'NotAllowedError' ? 'Geen toestemming voor NFC. Sta NFC toe voor deze site in Chrome.' : `NFC-fout: ${e.message}`;
    });
    return h('div', { class: 'dlg' }, h('h2', {}, 'NFC-tag koppelen'), note,
      h('div', { class: 'meta' }, `Op de tag komt de link naar "${t.name}". Een tag die al bij iets anders hoorde, wordt daar losgekoppeld.`),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => stop(undefined) }, 'Annuleren')));
  });
}

async function viewLabels(id, q, token) {
  const opts = { items: q.items === '1', size: q.size || 'm', only: q.only === '1' };
  const load = async () => {
    let list;
    if (opts.only && id) list = [(await api('GET', `/api/things/${id}`)).thing];
    else {
      const { nodes } = await api('GET', '/api/tree');
      const kids = new Map();
      nodes.forEach((n) => { const k = n.parent_id || 0; (kids.get(k) || kids.set(k, []).get(k)).push(n); });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      list = [];
      const walk = (pid) => (kids.get(pid) || []).forEach((n) => { if (n.is_container || opts.items) list.push(n); walk(n.id); });
      if (id && byId.get(id)) list.push(byId.get(id));
      walk(id || 0);
      const names = new Map(nodes.map((n) => [n.id, n]));
      for (const n of list) { const p = []; let c = names.get(n.parent_id); while (c && p.length < 20) { p.unshift(c.name); c = names.get(c.parent_id); } n.where = p.join(' › '); }
    }
    if (stale(token)) return;
    const main = shell('Labels', { back: id ? `#/c/${id}` : '#/', tab: 'home', actions: h('button', { class: 'btn icon ghost', 'aria-label': 'Printen', onclick: () => window.print() }, icon('print')) });
    const setQ = (k, v) => { const p = new URLSearchParams({ ...(opts.items ? { items: '1' } : {}), size: opts.size, ...(opts.only ? { only: '1' } : {}) }); p.set(k, v); if (!v) p.delete(k); location.hash = `#/labels/${id || 0}?${p}`; };
    main.append(
      h('div', { class: 'card noprint' },
        h('p', { style: 'margin:0 0 10px' }, `${list.length} label${list.length === 1 ? '' : 's'}. Print op stickervel of gewoon papier en knip uit. Scannen opent meteen de juiste plek.`),
        h('div', { class: 'chips', style: 'margin:0' },
          [['s', 'Klein'], ['m', 'Middel'], ['l', 'Groot']].map(([k, l]) => h('button', { class: 'chip' + (opts.size === k ? ' on' : ''), onclick: () => setQ('size', k) }, l)),
          !opts.only && h('button', { class: 'chip' + (opts.items ? ' on' : ''), onclick: () => setQ('items', opts.items ? '' : '1') }, 'Ook items'),
          h('button', { class: 'chip on', onclick: () => window.print() }, icon('print'), 'Printen'))),
      list.length ? h('div', { class: `labels size-${opts.size}` }, list.map((n) => h('div', { class: 'lbl' }, qrSvg(thingUrl(n), { ecc: 'Q' }),
        h('div', { class: 'lbl-txt' }, h('b', {}, n.name), n.where && h('small', {}, n.where), h('small', { class: 'lbl-id' }, `#${n.id}`)))))
        : h('div', { class: 'empty' }, 'Geen containers om een label voor te maken.'));
  };
  refresh = null;
  await load();
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
    const isAdminQ = S.me.role === 'admin';
    const [users, act, tokens, integ, backups] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/activity?limit=25'), api('GET', '/api/tokens'), api('GET', '/api/integrations'),
      isAdminQ ? api('GET', '/api/backups') : null]);
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
      h('div', { class: 'card' }, h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '/api/export.csv', download: true }, icon('download'), 'Exporteer als CSV'),
        h('button', { class: 'btn', onclick: () => importDialog().then((ok) => ok && draw()) }, icon('upload'), 'Importeer CSV'),
        h('a', { class: 'btn', href: '#/labels/0' }, icon('qr'), 'Labels printen'),
        h('a', { class: 'btn', href: '#/shopping' }, icon('cart'), 'Boodschappen'),
        h('a', { class: 'btn', href: '#/trash' }, icon('trash'), 'Prullenbak'),
        h('a', { class: 'btn', href: '#/duplicates' }, icon('link'), 'Dubbelen opruimen'),
        isAdmin && h('button', { class: 'btn', onclick: () => fmsDialog().then((ok) => ok && draw()) }, icon('upload'), 'Find my stuff importeren'))),
      isAdmin && h('div', { class: 'section-title' }, 'Opnieuw beginnen'),
      isAdmin && h('div', { class: 'card' },
        h('p', { class: 'meta', style: 'margin:0 0 8px' }, 'Wist alle containers, items en foto\'s (bijv. na een dubbele import). Er wordt eerst automatisch een back-up gemaakt. Gebruikers blijven bestaan.'),
        h('button', { class: 'btn danger', onclick: () => wipeDialog().then((ok) => ok && draw()) }, icon('trash'), 'Alle spullen wissen')),
      isAdmin && h('div', { class: 'section-title' }, "Back-ups"),
      isAdmin && h('div', { class: 'card' },
        h('p', { class: 'meta', style: 'margin:0 0 8px' }, `Elke nacht om ${backups.config.backupHour}:00 een kopie van de database; de laatste ${backups.config.backupKeep} blijven bewaard (in het volume onder /data/backups). De volledige download bevat ook alle foto's.`),
        backups.backups.slice(0, 5).map((b) => h('div', { class: 'act' }, h('a', { href: `/api/backups/${encodeURIComponent(b.name)}`, download: true }, b.name), h('small', {}, `${(b.size / 1024).toFixed(0)} kB · ${fmtDate(b.created_at)}`))),
        !backups.backups.length && h('div', { class: 'meta' }, 'Nog geen back-ups.'),
        h('div', { class: 'actions', style: 'margin-top:10px' },
          h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/backups'); toast('Back-up gemaakt'); draw(); } catch (ex) { toast(ex.message, true); } } }, icon('shield'), 'Nu back-up maken'),
          h('a', { class: 'btn', href: '/api/backup.tar', download: true }, icon('download'), "Volledige back-up (.tar)"))),
      h('div', { class: 'section-title' }, 'Koppelingen'),
      h('div', { class: 'card' },
        h('div', { class: 'userrow' }, h('div', { class: 'thumb' }, icon('home')), h('div', { class: 'main' }, h('b', {}, 'Home Assistant'),
          h('div', { class: 'sub' }, integ.haConfigured ? `Meldingen aan: bijna op, en houdbaarheid ≤ ${integ.notifyDays} dagen (dagelijks om ${integ.notifyHour}:00)` : 'Niet ingesteld (HA_WEBHOOK_URL in de stack)')),
          isAdmin && integ.haConfigured && h('button', { class: 'btn sm', onclick: async () => { try { await api('POST', '/api/integrations/ha/test'); toast('Testmelding verstuurd'); } catch (ex) { toast(ex.message, true); } } }, 'Test')),
        h('div', { class: 'section-sub' }, 'API-tokens'),
        h('p', { class: 'meta', style: 'margin:0 0 6px' }, 'Voor Home Assistant, scripts of een app: stuur "Authorization: Bearer <token>" mee. Een token heeft jouw rechten.'),
        tokens.tokens.map((tk) => h('div', { class: 'userrow' }, h('div', { class: 'main' }, h('b', {}, tk.name), h('div', { class: 'sub' }, `${tk.prefix}… · ${tk.last_used_at ? 'laatst gebruikt ' + fmtDate(tk.last_used_at) : 'nog niet gebruikt'}`)),
          h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog(`Token "${tk.name}" intrekken?`, 'Wat dit token gebruikt, werkt daarna niet meer.', 'Intrekken')) return; await api('DELETE', `/api/tokens/${tk.id}`); draw(); } }, 'Intrekken'))),
        h('div', { class: 'actions', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => tokenDialog().then((ok) => ok && draw()) }, icon('key'), 'Nieuw token'))),
      h('div', { class: 'section-title' }, 'Recente activiteit'),
      h('div', { class: 'card' }, act.activity.length ? act.activity.map((a) => h('div', { class: 'act' }, a.summary, h('small', {}, fmtDate(a.at)))) : 'Nog geen activiteit.'),
      h('div', { class: 'ver' }, `Mijn Spullen ${S.version}`));
  };
  refresh = () => draw().catch(() => {});
  await draw();
}
function tokenDialog() {
  return openDialog((close) => {
    const name = h('input', { required: true, maxlength: 60, placeholder: 'bijv. Home Assistant' });
    const err = h('div', { class: 'error' });
    const box = h('div');
    const form = h('form', { class: 'dlg', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/tokens', { name: name.value });
        const out = h('input', { value: r.token, readonly: true, onfocus: (ev) => ev.target.select() });
        box.replaceChildren(h('p', { class: 'meta' }, 'Kopieer het token nu: het wordt hierna nooit meer getoond.'),
          h('div', { class: 'inline' }, out, h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(r.token); toast('Gekopieerd'); } catch { out.select(); } } }, 'Kopieer')),
          h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => close(true) }, 'Klaar')));
        form.querySelectorAll('.pre').forEach((el) => el.remove());
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('h2', {}, 'Nieuw API-token'), h('div', { class: 'field pre' }, h('label', {}, 'Waarvoor?'), name), h('div', { class: 'pre' }, err), box,
    h('div', { class: 'dlg-actions pre' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary', type: 'submit' }, 'Aanmaken')));
    return form;
  });
}
// Thumbnails maken voor foto's die er nog geen hebben (na een import); draait in de browser.
async function makeMissingThumbs(onProgress) {
  const { ids } = await api('GET', '/api/images-without-thumb');
  let done = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`/api/images/${id}`, { credentials: 'same-origin' });
      if (r.ok) {
        const thumb = await shrinkImage(await r.blob(), 320, 0.7);
        await api('PUT', `/api/images/${id}/thumb`, thumb, { 'Content-Type': 'image/jpeg' });
      }
    } catch { /* volgende */ }
    onProgress(++done, ids.length);
  }
  return ids.length;
}
function fmsDialog() {
  return openDialog((close) => {
    const file = h('input', { type: 'file', accept: '.bckp,.zip,application/zip,application/octet-stream' });
    const attach = h('input', { type: 'checkbox' });
    const out = h('div');
    const err = h('div', { class: 'error' });
    const status = h('p', { class: 'meta', style: 'margin:0' });
    const btn = h('button', { class: 'btn primary', type: 'button' }, 'Uploaden en controleren');
    let busy = false;
    btn.onclick = async () => {
      if (busy) return;
      err.textContent = '';
      const f = file.files[0];
      if (!f) { err.textContent = 'Kies eerst het .bckp-bestand'; return; }
      busy = true; btn.disabled = true;
      status.textContent = `Uploaden (${(f.size / 1048576).toFixed(0)} MB)… dit kan even duren.`;
      try {
        const r = await api('POST', '/api/import/findmystuff', f, { 'Content-Type': 'application/zip' });
        const s = r.summary;
        status.textContent = '';
        out.replaceChildren(
          h('p', { style: 'margin:0' }, `Gevonden: ${s.containers} containers, ${s.items} items, ${s.tags} tags, ${s.images_found} van ${s.images} foto's, ${s.barcodes} barcodes.`),
          h('p', { class: 'meta', style: 'margin:4px 0 0' }, `Bijv. ${r.sample.join(', ')}…`),
          h('p', { class: 'meta', style: 'margin:4px 0 0' }, 'Alles wordt toegevoegd naast wat er al staat; tags met dezelfde naam worden hergebruikt.'),
          r.already_imported && !attach.checked && h('div', { class: 'banner' }, `Deze back-up is al geïmporteerd op ${fmtDate(r.already_imported)}. Nog een keer importeren maakt alles dubbel. Vink hierboven "alleen aanvullen" aan, of wis eerst alles onder Meer.`),
          h('div', { class: 'dlg-actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'),
            h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
              e.currentTarget.disabled = true;
              status.textContent = 'Importeren…';
              try {
                const { stats } = await api('POST', `/api/import/findmystuff/${r.token}`, { attach_only: attach.checked });
                await loadTags();
                status.textContent = 'Thumbnails maken…';
                await makeMissingThumbs((n, t) => { status.textContent = `Thumbnails maken… ${n}/${t}`; });
                toast(attach.checked ? `Aangevuld: ${stats.imported_images} foto's bij ${stats.matched_things} gevonden spullen` : `Geïmporteerd: ${stats.created_things} spullen, ${stats.imported_images} foto's`);
                close(true);
              } catch (ex) { err.textContent = ex.message; status.textContent = ''; }
            } }, 'Importeren')));
        btn.remove();
      } catch (ex) { err.textContent = ex.message; status.textContent = ''; btn.disabled = false; busy = false; }
    };
    return h('div', { class: 'dlg' }, h('h2', {}, 'Find my stuff importeren'),
      h('p', { class: 'meta', style: 'margin:0' }, 'Kies de back-up uit Find my stuff (.bckp, te vinden in Google Drive onder com.miquelcms.homeorganizer.backups). Containers, items, tags, barcodes, prijzen en foto\'s komen mee.'),
      file, h('label', { class: 'check' }, attach, 'Al eerder geïmporteerd: alleen ontbrekende foto\'s en tags aanvullen'), status, err, out,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Sluiten'), btn));
  });
}
function wipeDialog() {
  return openDialog((close) => {
    const conf = h('input', { placeholder: 'WISSEN', autocapitalize: 'characters', 'aria-label': 'Bevestiging' });
    const tags = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'error' });
    return h('form', { class: 'dlg', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/wipe', { confirm: conf.value.trim().toUpperCase(), tags: tags.checked });
        toast(`${r.deleted_things} spullen gewist (back-up: ${r.backup})`);
        if (tags.checked) await loadTags();
        close(true);
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('h2', {}, 'Alle spullen wissen?'),
    h('p', { style: 'margin:0;color:var(--muted)' }, 'Alle containers, items en foto\'s worden verwijderd. Vooraf wordt een back-up van de database gemaakt (foto\'s zitten daar niet in). Typ WISSEN om te bevestigen.'),
    h('div', { class: 'field' }, conf), h('label', { class: 'check' }, tags, 'Ook alle tags wissen'), err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary danger', type: 'submit', style: 'background:var(--danger);border-color:var(--danger);color:#fff' }, 'Wissen')));
  });
}
function importDialog() {
  return openDialog((close) => {
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
    const dups = h('input', { type: 'checkbox', checked: true });
    const out = h('div');
    const err = h('div', { class: 'error' });
    let text = null;
    const go = async (dry) => {
      err.textContent = '';
      if (!text) { if (!file.files[0]) { err.textContent = 'Kies eerst een bestand'; return; } text = await file.files[0].text(); }
      try {
        const r = await api('POST', `/api/import.csv?dry=${dry ? 1 : 0}&skip_duplicates=${dups.checked ? 1 : 0}`, new Blob([text], { type: 'text/csv' }), { 'Content-Type': 'text/csv' });
        const sum = `${r.created_items} items en ${r.created_containers} containers${r.created_tags ? `, ${r.created_tags} nieuwe tags` : ''}${r.skipped ? `; ${r.skipped} overgeslagen (bestaan al)` : ''}.`;
        if (dry) {
          out.replaceChildren(h('p', { class: 'meta' }, `${r.rows} regels gelezen (kolommen: ${r.columns.join(', ')}). Dit wordt aangemaakt: ${sum}`),
            r.errors.length ? h('div', { class: 'error' }, r.errors.slice(0, 5).join(' · ')) : null,
            h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuleren'), h('button', { class: 'btn primary', type: 'button', onclick: () => go(false) }, 'Importeren')));
        } else { toast(`Geïmporteerd: ${sum}`); close(true); }
      } catch (ex) { err.textContent = ex.message; }
    };
    file.addEventListener('change', () => { text = null; out.replaceChildren(); });
    return h('div', { class: 'dlg' }, h('h2', {}, 'CSV importeren'),
      h('p', { class: 'meta', style: 'margin:0' }, 'Kolommen die herkend worden: naam, locatie (bijv. "Huis > Zolder > Doos"), type, aantal, minimum, barcode, prijs, houdbaar_tot, tags (gescheiden door |), omschrijving, notities. Een export uit deze app kan er zo weer in.'),
      file, h('label', { class: 'check' }, dups, 'Items die al op dezelfde plek staan overslaan'), err, out,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Sluiten'), h('button', { class: 'btn primary', type: 'button', onclick: () => go(true) }, 'Controleren')));
  });
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
