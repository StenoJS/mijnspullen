'use strict';
// Minimale tar-schrijver (ustar) voor de volledige back-up: database + foto's in één download, zonder dependencies.
const fs = require('node:fs');

function header(name, size, mtime) {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 100), 0, 'utf8');
  b.write('0000644\0', 100);
  b.write('0001750\0', 108);
  b.write('0001750\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  b.write('        ', 148); // checksum-veld telt als spaties
  b.write('0', 156);
  b.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

// entries: [{ name, file }] (bestand op schijf) of [{ name, data: Buffer }]
async function writeTar(stream, entries) {
  const write = (chunk) => new Promise((res) => { if (stream.write(chunk)) res(); else stream.once('drain', res); });
  for (const e of entries) {
    let data = e.data, mtime = Date.now();
    if (e.file) {
      try { data = fs.readFileSync(e.file); mtime = fs.statSync(e.file).mtimeMs; } catch { continue; }
    }
    await write(header(e.name, data.length, mtime));
    await write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024));
  stream.end();
}

module.exports = { writeTar };
