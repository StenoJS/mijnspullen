'use strict';
// Productgegevens bij een barcode opzoeken in de open databases van Open Food Facts (eten, verzorging, overige producten).
// Gaat via de server zodat de strikte CSP van de app (connect-src 'self') intact blijft.

const SOURCES = [
  'https://world.openfoodfacts.org',
  'https://world.openbeautyfacts.org',
  'https://world.openproductsfacts.org',
];
const IMAGE_HOSTS = /^((images|static)\.open(food|beauty|products|petfood)facts\.org|cdn\.rebrickable\.com)$/;
const UA = `MijnSpullen/${require('../package.json').version} (self-hosted inventory; https://github.com/StenoJS/mijnspullen)`;
const cache = new Map();

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) return { status: 0 }; // bestaat niet: geldig 'niet gevonden'
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function lookupBarcode(code) {
  code = String(code).trim();
  if (!/^\d{6,14}$/.test(code)) return null;
  if (cache.has(code)) return cache.get(code);
  const fields = 'product_name,product_name_nl,generic_name_nl,generic_name,brands,quantity,image_front_url,image_url,categories';
  let failed = false;
  for (const base of SOURCES) {
    const j = await getJson(`${base}/api/v2/product/${code}.json?fields=${fields}`, 4000);
    if (!j) failed = true;
    const p = j && j.status === 1 && j.product;
    if (!p) continue;
    const name = (p.product_name_nl || p.product_name || '').trim();
    if (!name) continue;
    const brand = String(p.brands || '').split(',')[0].trim();
    const out = {
      name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name,
      description: [p.generic_name_nl || p.generic_name, p.quantity].filter(Boolean).join(' · '),
      image_url: p.image_front_url || p.image_url || null,
      source: new URL(base).hostname,
    };
    cache.set(code, out);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return out;
  }
  // Alleen 'niet gevonden' onthouden; bij een storing of time-out de volgende keer gewoon opnieuw proberen.
  if (!failed) cache.set(code, null);
  return null;
}

// Echt een foto? Kijk naar de eerste bytes in plaats van alleen het Content-Type te geloven.
function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
async function fetchImage(url, maxBytes) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'error' });
    const mime = String(r.headers.get('content-type') || '').split(';')[0].trim();
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > maxBytes || sniffImage(buf) !== mime) return null;
    return { buf, mime };
  } catch { return null; } finally { clearTimeout(t); }
}

module.exports = { lookupBarcode, fetchImage, sniffImage };
