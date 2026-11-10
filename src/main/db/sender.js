const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const SCHEMA_VERSION = '1'

// DDL 直接放在程式碼裡，不讀外部 .sql，避免打包成 asar 後的路徑問題
const DDL = `
CREATE TABLE IF NOT EXISTS media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  hash         TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  ext          TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('image','video')),
  size         INTEGER NOT NULL,
  stored_name  TEXT    NOT NULL,
  source_path  TEXT,
  added_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  duration_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playlist_position ON playlist_item(position);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

let db = null

function mediaDir() {
  return path.join(app.getPath('userData'), 'media')
}

function open() {
  if (db) return db
  const dir = app.getPath('userData')
  fs.mkdirSync(mediaDir(), { recursive: true })
  db = new Database(path.join(dir, 'sender.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(DDL)
  if (!getMeta('schema_version')) setMeta('schema_version', SCHEMA_VERSION)
  if (!getMeta('revision')) setMeta('revision', '0')
  return db
}

function close() {
  if (db) {
    db.close()
    db = null
  }
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)
  return row ? row.value : null
}

function setMeta(key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value))
}

module.exports = { open, close, getMeta, setMeta, mediaDir, get db() { return db } }
