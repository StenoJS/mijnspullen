'use strict';
// Lego-sets opzoeken op setnummer met de gratis database-download van Rebrickable (geen account of sleutel nodig).
// De bestanden worden in DATA_DIR/lego bewaard en eens per maand ververst.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseCsv } = require('./csv');

const BASE = process.env.LEGO_DATA_URL || 'https://cdn.rebrickable.com/media/downloads';
const MAX_AGE = 30 * 86400e3;
const UA = 'MijnSpullen (self-hosted inventory; https://github.com/StenoJS/mijnspullen)';

function createLego(dataDir) {
  const dir = path.join(dataDir, 'lego');
  fs.mkdirSync(dir, { recursive: true });
  let sets = null, themes = null, loading = null, loadedAt = 0;

  async function download(name) {
    const file = path.join(dir, `${name}.csv.gz`);
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(file).mtimeMs < MAX_AGE; } catch { /* nog niet aanwezig */ }
    if (!fresh) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch(`${BASE}/${name}.csv.gz`, { headers: { 'User-Agent': UA }, signal: ctl.signal }).finally(() => clearTimeout(t));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        zlib.gunzipSync(buf); // controle: echt een gzip-bestand
        fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
      } catch (e) {
        if (!fs.existsSync(file)) throw new Error(`Lego-database (${name}) kon niet worden opgehaald: ${e.message}`);
        console.warn(`Lego-database ${name} niet ververst: ${e.message}`);
      }
    }
    const rows = parseCsv(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }

  async function load() {
    if (sets && Date.now() - loadedAt < MAX_AGE) return;
    if (!loading) {
      loading = (async () => {
        const [s, t] = await Promise.all([download('sets'), download('themes')]);
        themes = new Map(t.map((x) => [String(x.id), x]));
        sets = new Map();
        for (const x of s) if (x.set_num) sets.set(x.set_num.toLowerCase(), x);
        loadedAt = Date.now();
      })().finally(() => { loading = null; });
    }
    await loading;
  }

  const themePath = (id) => {
    const out = [];
    for (let t = themes.get(String(id)), n = 0; t && n < 5; t = themes.get(String(t.parent_id)), n++) out.unshift(t.name);
    return out;
  };

  // "31077", "31077-1", "LEGO 31077" → set; zonder variant wordt -1 genomen.
  const normalize = (code) => {
    const m = String(code || '').trim().match(/^(?:lego\s*)?#?\s*([0-9]{3,7}|[a-z0-9]{2,12})(?:-(\d{1,2}))?$/i);
    return m ? `${m[1].toLowerCase()}-${m[2] || '1'}` : null;
  };

  async function lookup(code) {
    const key = normalize(code);
    if (!key) return null;
    await load();
    const s = sets.get(key);
    if (!s) return null;
    const tp = themePath(s.theme_id);
    const num = key.replace(/-1$/, '');
    return {
      set_num: s.set_num, number: num, name: s.name, year: Number(s.year) || null, pieces: Number(s.num_parts) || null,
      theme: tp.join(' › '),
      description: ['LEGO', tp.join(' › '), s.year, s.num_parts && Number(s.num_parts) > 0 ? `${s.num_parts} onderdelen` : null].filter(Boolean).join(' · '),
      image_url: s.img_url || null,
      url: `https://rebrickable.com/sets/${s.set_num}/`,
    };
  }

  return { lookup, normalize, load };
}

module.exports = { createLego };
