'use strict';
// CSV lezen zonder dependencies: aanhalingstekens, "" als escape, regeleinden binnen velden, ; of , als scheidingsteken.

function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  return count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ',';
}

function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const d = detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

// Kolomnamen die we herkennen (eigen export, Engelse varianten, Find my stuff-achtige namen).
const ALIASES = {
  name: ['naam', 'name', 'item', 'titel', 'title'],
  type: ['type', 'soort', 'kind'],
  location: ['locatie', 'location', 'container', 'plek', 'pad', 'path', 'parent'],
  quantity: ['aantal', 'quantity', 'qty', 'hoeveelheid', 'amount'],
  min_quantity: ['minimum', 'min', 'min_quantity', 'drempel', 'threshold', 'minimum quantity'],
  barcode: ['barcode', 'ean', 'code', 'qr'],
  price: ['prijs', 'price', 'waarde', 'value'],
  expires_on: ['houdbaar_tot', 'houdbaar tot', 'expires', 'expiry', 'expiration', 'expiration date', 'tht', 'vervaldatum'],
  tags: ['tags', 'tag', 'labels', 'categorie', 'category'],
  description: ['omschrijving', 'description', 'beschrijving'],
  notes: ['notities', 'notes', 'opmerkingen', 'notitie'],
};

function mapHeader(header) {
  const map = {};
  header.forEach((raw, i) => {
    const h = String(raw).trim().toLowerCase();
    for (const [key, names] of Object.entries(ALIASES)) if (!(key in map) && names.includes(h)) map[key] = i;
  });
  return map;
}

// Onze eigen export zet een ' voor waarden die met = + - @ beginnen (CSV-injectie); bij import weer weghalen.
const unguard = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

function toDate(v) {
  v = String(v || '').trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(v); // dd-mm-jjjj
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function toNum(v) {
  v = String(v || '').trim().replace(/[€\s]/g, '');
  if (!v) return null;
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else v = v.replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowsToRecords(rows) {
  if (rows.length < 2) return { records: [], columns: [] };
  const map = mapHeader(rows[0]);
  if (!('name' in map)) throw new Error('Kolom "naam" (of "name") niet gevonden in de eerste regel');
  const get = (r, k) => (k in map ? unguard(String(r[map[k]] ?? '').trim()) : '');
  const records = rows.slice(1).map((r, i) => ({
    line: i + 2,
    name: get(r, 'name'),
    is_container: /^(container|locatie|location|map|folder)$/i.test(get(r, 'type')),
    location: get(r, 'location').split(/\s*[>›]\s*/).filter(Boolean),
    quantity: toNum(get(r, 'quantity')),
    min_quantity: toNum(get(r, 'min_quantity')),
    barcode: get(r, 'barcode') || null,
    price: toNum(get(r, 'price')),
    expires_on: toDate(get(r, 'expires_on')),
    tags: get(r, 'tags').split(/\s*[|,]\s*/).filter(Boolean),
    description: get(r, 'description'),
    notes: get(r, 'notes'),
  })).filter((r) => r.name);
  return { records, columns: Object.keys(map) };
}

module.exports = { parseCsv, rowsToRecords };
