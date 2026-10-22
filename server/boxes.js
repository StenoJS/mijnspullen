'use strict';
// Dozenlijst importeren: een sheet met per regel een doosnummer en daarnaast wat erin zit (één ding per cel).
// Vergelijkt met wat er al in de app staat, zodat er geen dubbelen ontstaan. Leest .ods (LibreOffice) en .csv.
const { readZip } = require('./zip');
const { parseCsv } = require('./csv');

const decode = (s) => s.replace(/<text:s(?: text:c="(\d+)")?\s*\/>/g, (m, n) => ' '.repeat(Number(n || 1)))
  .replace(/<text:tab\s*\/>/g, ' ').replace(/<text:line-break\s*\/>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function readOds(buf) {
  const xml = readZip(buf).read('content.xml');
  if (!xml) throw new Error('Geen geldig .ods-bestand');
  const s = xml.toString('utf8');
  const table = (s.match(/<table:table [\s\S]*?<\/table:table>/) || [s])[0]; // eerste tabblad
  const rows = [];
  for (const rm of table.matchAll(/<table:table-row\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const cells = [];
    for (const cm of (rm[1] || '').matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const rep = Math.min(Number((cm[1].match(/number-columns-repeated="(\d+)"/) || [])[1] || 1), 60);
      const paras = [...(cm[2] || '').matchAll(/<text:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:p>)/g)].map((p) => decode(p[1] || ''));
      for (let i = 0; i < rep; i++) cells.push(paras.join(' ').trim());
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    rows.push(cells);
  }
  return rows;
}

function readSheet(buf, filename) {
  if (buf.subarray(0, 2).toString() === 'PK') return readOds(buf);
  if (/\.xlsx?$/i.test(filename || '')) throw new Error('Excel-bestanden: sla op als .ods of .csv');
  return parseCsv(buf.toString('utf8'));
}

// Kolom met doosnummers zoeken: de eerste kolom waarin de meeste regels een kort getal hebben.
function toBoxRows(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  let col = -1, best = 0;
  for (let c = 0; c < Math.min(width, 5); c++) {
    const n = rows.filter((r) => /^\s*\d{1,5}\s*$/.test(r[c] || '')).length;
    if (n > best) { best = n; col = c; }
  }
  if (col < 0 || best < 1) throw new Error('Geen kolom met doosnummers gevonden');
  const boxes = new Map();
  for (const r of rows) {
    const num = String(r[col] || '').trim();
    if (!/^\d{1,5}$/.test(num)) continue;
    const box = boxes.get(num) || { number: num, mark: '', cells: [] };
    box.mark = box.mark || r.slice(0, col).filter(Boolean).join(' ');
    box.cells.push(...r.slice(col + 1).map((x) => String(x || '').trim()).filter(Boolean));
    boxes.set(num, box);
  }
  return [...boxes.values()];
}

// Eén cel → één of meer items. "2x 21338 (cabin wood)", "legoboot 60266", "Ninjago 71730+71731", "Harry Potter div (4704/4729)".
const STATUS = /^(?:\d+\s*x\s*)?(?:nieuw(?: in doos)?|halfvol|vol|leeg)$/i;
function cellToItems(cell) {
  const text = cell.replace(/\s+/g, ' ').trim();
  if (STATUS.test(text)) {
    // "2x nieuw" na een setnummer: daarvan zijn er 2 (nieuw in doos).
    const n = text.match(/^(\d+)\s*x/i);
    return { note: text.replace(/^\d+\s*x\s*/i, ''), quantity: n ? Number(n[1]) : null };
  }
  let qty = 1, rest = text;
  const q = rest.match(/^(\d{1,2})\s*x(?:\s+|(?=\d{4}))(.+)$/i); // "2x 21338", niet "1x4 1x2 bricks"
  if (q) { qty = Number(q[1]); rest = q[2].trim(); }
  const nums = [...rest.matchAll(/(?<![\d.,])(\d{4,7})(?:-\d{1,2})?(?![\d.,])/g)].map((m) => m[1]);
  if (nums.length > 1) return { items: nums.map((n) => ({ text, code: n, quantity: 1 })) };
  if (nums.length === 1) {
    const words = rest.replace(nums[0], '').replace(/[()+/]/g, ' ').replace(/\s+/g, ' ').trim();
    return { items: [{ text, code: nums[0], label: words, quantity: qty }] };
  }
  return { items: [{ text, name: rest, quantity: qty }] };
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const hasToken = (name, token) => new RegExp(`(^|[^0-9])0*${token}([^0-9]|$)`).test(name);

// Plan maken: per doos bestaande container zoeken, per item kijken of het er al is (in die doos of elders).
async function plan(rows, { db, pathOf, allNames, lookupSet }) {
  const boxes = toBoxRows(rows);
  const map = allNames();
  const all = db.prepare('SELECT id, parent_id, name, is_container FROM things').all();
  const containers = all.filter((t) => t.is_container);
  const kids = new Map();
  for (const t of all) if (t.parent_id) (kids.get(t.parent_id) || kids.set(t.parent_id, []).get(t.parent_id)).push(t);
  const descendants = (id) => {
    const out = [], stack = [id];
    while (stack.length) for (const k of kids.get(stack.pop()) || []) { out.push(k); stack.push(k.id); }
    return out;
  };
  const where = (id) => pathOf(map, id).map((p) => p.name).join(' › ');
  const parentCount = new Map();
  const result = [];
  for (const b of boxes) {
    // Container met het doosnummer als los getal in de naam ("Box 101", "Doos 101", "101 Lego").
    const cands = containers.filter((c) => hasToken(c.name, b.number) && norm(c.name).split(' ').length <= 4);
    cands.sort((x, y) => (/\b(box|doos|bak|krat)\b/i.test(y.name) - /\b(box|doos|bak|krat)\b/i.test(x.name)) || (x.name.length - y.name.length));
    const existing = cands[0] || null;
    if (existing) parentCount.set(existing.parent_id || 0, (parentCount.get(existing.parent_id || 0) || 0) + 1);
    const inBox = existing ? descendants(existing.id) : [];
    const notes = [], items = [];
    for (const cell of b.cells) {
      const r = cellToItems(cell);
      if (r.note) {
        if (r.quantity && items.length) items[items.length - 1].quantity = r.quantity;
        if (!notes.includes(r.note)) notes.push(r.note);
        continue;
      }
      for (const it of r.items) {
        let set = null;
        if (it.code) set = await lookupSet(it.code);
        const name = set ? `${set.number} ${set.name}` : (it.code ? [it.code, it.label].filter(Boolean).join(' ') : it.name);
        const key = it.code || null;
        // Zelfde set twee keer in dezelfde doos in de lijst → één regel met aantal 2.
        const prev = items.find((x) => (key ? x.code === key : norm(x.name) === norm(name)));
        if (prev) { prev.quantity += it.quantity; continue; }
        const matches = (t) => !t.is_container && (key ? hasToken(t.name, key) : (norm(t.name) === norm(name) || (norm(name).length >= 5 && norm(t.name).includes(norm(name)))));
        const here = inBox.find(matches);
        const elsewhere = here ? null : all.find((t) => matches(t) && !inBox.includes(t));
        items.push({
          text: it.text, code: key, name: name.slice(0, 200), quantity: it.quantity,
          description: set ? set.description + (it.label ? ` · in lijst: ${it.label}` : '') : '',
          lego: !!(set || (key && /^\d{4,7}$/.test(key))), image_url: set ? set.image_url : null,
          status: here ? 'exists' : elsewhere ? 'elsewhere' : 'new',
          match: here || elsewhere ? { id: (here || elsewhere).id, name: (here || elsewhere).name, path: where((here || elsewhere).id) } : null,
        });
      }
    }
    result.push({ number: b.number, mark: b.mark, notes, existing: existing ? { id: existing.id, name: existing.name, path: where(existing.id) } : null, items });
  }
  // Nieuwe dozen standaard naast de bestaande dozen zetten.
  const top = [...parentCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const parentId = top && top[0] ? top[0] : null;
  return { boxes: result, default_parent: parentId ? { id: parentId, path: where(parentId) } : null };
}

module.exports = { readSheet, toBoxRows, cellToItems, plan };
