const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const SCHEMA_VERSION = '1'

// cached_playlist 存的是「發送端要求的清單」，cached_media 存的是「本機真的有的檔案」。
// 兩者分開，才能做到下載完第一支就開播，而不是等整份清單到齊。
const DDL = `
CREATE TABLE IF NOT EXISTS cached_media (
  hash           TEXT PRIMARY KEY,
  display_name   TEXT    NOT NULL,
  ext            TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('image','video')),
  size           INTEGER NOT NULL,
  stored_name    TEXT    NOT NULL,
  downloaded_at  INTEGER NOT NULL,
  last_played_at INTEGER
);

CREATE TABLE IF NOT EXISTS cached_playlist (
  position     INTEGER PRIMARY KEY,
  hash         TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  ext          TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  duration_sec INTEGER
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

let db = null

// 已收與收取中分兩個資料夾：沒改名進 received 的檔案結構上就不可能被播放器看到
// 名稱不能用 cache（Windows 不分大小寫，會和 Chromium 的 Cache 撞成同一個資料夾），
// 也不能用 media（那是發送端媒體庫，同一台機器切換過模式就會兩邊混庫）
function receivedDir() {
  return path.join(app.getPath('userData'), 'received')
}

function incomingDir() {
  return path.join(app.getPath('userData'), 'incoming')
}

function open() {
  if (db) return db
  fs.mkdirSync(receivedDir(), { recursive: true })
  fs.mkdirSync(incomingDir(), { recursive: true })
  db = new Database(path.join(app.getPath('userData'), 'receiver.db'))
  db.pragma('journal_mode = WAL')
  db.exec(DDL)
  if (!getMeta('schema_version')) setMeta('schema_version', SCHEMA_VERSION)
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

module.exports = { open, close, getMeta, setMeta, receivedDir, incomingDir, get db() { return db } }
