// Kleine hulpfuncties: DOM-bouwer, API-client, iconen, formattering, afbeeldingen.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export const flat = (...kids) => kids.flat(Infinity).filter((k) => k != null && k !== false);

const ICONS = {
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  home: 'M3 11 12 3l9 8M5 10v10h14V10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  x: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h11',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.box);
  svg.append(p);
  return svg;
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
let onUnauthorized = () => {};
export const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body, extraHeaders) {
  const isRaw = body instanceof Blob;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'mijn-spullen', 'X-Client-Id': CLIENT_ID, ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Geen verbinding met de server');
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/login') && !url.endsWith('/setup')) onUnauthorized();
    throw new ApiError(res.status, (data && data.error) || `Fout ${res.status}`, data);
  }
  return data;
}

// ---------- formattering ----------
const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
export const money = (n) => eur.format(n);
export const num = (n) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 }).format(n);
export function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function expiryText(iso) {
  const d = daysUntil(iso);
  if (d == null) return null;
  if (d < 0) return `Verlopen (${-d} d geleden)`;
  if (d === 0) return 'Verloopt vandaag';
  return `Nog ${d} d houdbaar`;
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- toasts & dialogs ----------
export function toast(msg, isErr) {
  const el = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2500);
}
export function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(build(close));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(undefined); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
export const confirmDialog = (title, text, okLabel = 'Verwijderen', danger = true) =>
  openDialog((close) => h('div', { class: 'dlg' },
    h('h2', {}, title), h('p', { style: 'margin:0;color:var(--muted)' }, text),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Annuleren'),
      h('button', { class: 'btn primary' + (danger ? ' danger' : ''), style: danger ? 'background:var(--danger);border-color:var(--danger);color:#fff' : '', onclick: () => close(true) }, okLabel)))).then(Boolean);

// ---------- afbeeldingen verkleinen in de browser ----------
export async function shrinkImage(file, maxSide, quality) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('Kan deze afbeelding niet lezen');
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Verkleinen mislukt'))), 'image/jpeg', quality));
}
export async function uploadPhoto(thingId, file) {
  const main = await shrinkImage(file, 1600, 0.82);
  const thumb = await shrinkImage(file, 320, 0.7);
  const { image } = await api('POST', `/api/things/${thingId}/images`, main, { 'Content-Type': 'image/jpeg' });
  await api('PUT', `/api/images/${image.id}/thumb`, thumb, { 'Content-Type': 'image/jpeg' });
  return image;
}
