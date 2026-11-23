'use strict';
// Controleer een back-up vóór het terugzetten: node server/check-backup.js /data/backups/mijn-spullen-2026-11-23.db
// Opent het bestand alleen-lezen, doet een integriteitscontrole en toont wat erin zit. Wijzigt niets.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function checkBackup(file) {
  if (!fs.existsSync(file)) throw new Error(`Bestand niet gevonden: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const count = (sql) => db.prepare(sql).get().c;
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok',
      integrity,
      schema_version: meta ? Number(meta.value) : null,
      users: count('SELECT COUNT(*) c FROM users'),
      admins: count("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0"),
      containers: count('SELECT COUNT(*) c FROM things WHERE is_container = 1'),
      items: count('SELECT COUNT(*) c FROM things WHERE is_container = 0'),
      tags: count('SELECT COUNT(*) c FROM tags'),
      tag_links: count('SELECT COUNT(*) c FROM thing_tags'),
      images: count('SELECT COUNT(*) c FROM images'),
      trash: count('SELECT COUNT(*) c FROM trash'),
      last_change: db.prepare('SELECT MAX(updated_at) m FROM things').get().m,
    };
  } finally { db.close(); }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Gebruik: node server/check-backup.js <back-up.db>'); process.exit(2); }
  try {
    const r = checkBackup(file);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok && r.admins > 0 ? 0 : 1);
  } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { checkBackup };
