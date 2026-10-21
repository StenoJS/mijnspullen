'use strict';
// Minimale ZIP-lezer (stored + deflate) voor het importeren van Find my stuff-back-ups, zonder dependencies.
const zlib = require('node:zlib');

function readZip(buf) {
  // End of central directory zoeken (max 64 KB commentaar aan het eind).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Geen geldig zip-bestand');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 wordt niet ondersteund');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Beschadigde zip (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.set(name, { name, method, compSize, size, localOffset });
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOffset;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`Beschadigde zip (${name})`);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
    throw new Error(`Onbekende compressie (${e.method}) voor ${name}`);
  };
  return { entries, read };
}

module.exports = { readZip };
