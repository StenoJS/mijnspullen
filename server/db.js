'use strict';
// SQLite via de ingebouwde node:sqlite (Node >= 22.13) — geen npm-dependencies nodig.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'mijn-spullen.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  const current = row ? Number(row.value) : 0;
  if (current < 1) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      -- Eén tabel voor containers (huis, kamer, doos…) én items: alles kan genest worden.
      CREATE TABLE things (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES things(id) ON DELETE CASCADE,
        is_container INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL DEFAULT 1,
        min_quantity REAL,
        barcode TEXT,
        price REAL,
        expires_on TEXT,
        favourite INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_things_parent ON things(parent_id);
      CREATE INDEX idx_things_barcode ON things(barcode);
      CREATE INDEX idx_things_expires ON things(expires_on);
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#64748b'
      );
      CREATE TABLE thing_tags (
        thing_id INTEGER NOT NULL REFERENCES things(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (thing_id, tag_id)
      );
      CREATE TABLE images (
        id INTEGER PRIMARY KEY,
        thing_id INTEGER NOT NULL REFERENCES things(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        ext TEXT NOT NULL,
        has_thumb INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_images_thing ON images(thing_id);
      CREATE TABLE activity (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        thing_id INTEGER,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_activity_at ON activity(at);
    `);
  }
  if (current < 2) {
    db.exec(`
      -- NFC: serienummer van een gekoppelde tag (een tag kan ook alleen een URL bevatten).
      ALTER TABLE things ADD COLUMN nfc_id TEXT;
      CREATE INDEX idx_things_nfc ON things(nfc_id);
      -- API-tokens voor Home Assistant, scripts en een eventuele native app.
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      -- Meldingen die al verstuurd zijn (zodat Home Assistant niet elke dag hetzelfde krijgt).
      CREATE TABLE notified (
        thing_id INTEGER NOT NULL REFERENCES things(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (thing_id, kind)
      );
    `);
  }
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(SCHEMA_VERSION));
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx, SCHEMA_VERSION };
