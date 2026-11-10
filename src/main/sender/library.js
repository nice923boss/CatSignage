const fs = require('node:fs')
const path = require('node:path')
const store = require('../db/sender')
const config = require('../config')
const { hashFile, hashString } = require('../lib/hash')
const { normalizeExt, kindOf } = require('../lib/media-kind')
const thumbs = require('./thumbs')

const SELECT_ITEMS = `
  SELECT p.id, p.position, p.duration_sec AS durationSec,
         m.hash, m.display_name AS displayName, m.ext, m.kind, m.size, m.stored_name AS storedName,
         m.source_path AS sourcePath
  FROM playlist_item p JOIN media m ON m.id = p.media_id
  ORDER BY p.position
`

function list() {
  return store.db.prepare(SELECT_ITEMS).all()
}

// 版本號由清單內容決定，所以增刪、排序、改秒數、改轉場都必然反映在版本號
function computeListVersion(items, transition) {
  const payload = JSON.stringify(items.map((i) => [i.position, i.hash, i.durationSec])) + '|' + transition
  return hashString(payload).slice(0, 16)
}

function bumpVersion() {
  const transition = config.load().sender.defaultTransition
  const version = computeListVersion(list(), transition)
  if (store.getMeta('list_version') !== version) {
    store.setMeta('list_version', version)
    store.setMeta('revision', String(Number(store.getMeta('revision') || 0) + 1))
  }
  store.setMeta('default_transition', transition)
  return version
}

function playlistPayload() {
  const items = list()
  const transition = config.load().sender.defaultTransition
  return {
    app: 'CatSignage',
    listVersion: bumpVersion(),
    revision: Number(store.getMeta('revision') || 0),
    generatedAt: Date.now(),
    defaultTransition: transition,
    items: items.map((i) => ({
      position: i.position,
      hash: i.hash,
      displayName: i.displayName,
      kind: i.kind,
      ext: i.ext,
      size: i.size,
      durationSec: i.durationSec,
    })),
  }
}

function nextPosition() {
  const row = store.db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM playlist_item').get()
  return row.max + 1
}

async function addFiles(filePaths) {
  const defaultSeconds = config.load().sender.defaultImageSeconds
  const result = { added: 0, duplicated: 0, rejected: [] }

  for (const filePath of filePaths) {
    const displayName = path.basename(filePath)
    const ext = normalizeExt(displayName)
    const kind = kindOf(ext)
    if (!kind) {
      result.rejected.push({ name: displayName, reason: '格式不支援' })
      continue
    }

    let size
    try {
      size = fs.statSync(filePath).size
    } catch {
      result.rejected.push({ name: displayName, reason: '無法讀取檔案' })
      continue
    }

    const hash = await hashFile(filePath)
    const storedName = hash + '.' + ext
    const existing = store.db.prepare('SELECT id FROM media WHERE hash = ?').get(hash)

    let mediaId
    if (existing) {
      mediaId = existing.id
      const inList = store.db.prepare('SELECT id FROM playlist_item WHERE media_id = ?').get(mediaId)
      if (inList) {
        result.duplicated += 1
        continue
      }
      // 重新加入時記下這次的位置，「原檔位置」按鈕才會指到使用者剛選的檔案
      store.db.prepare('UPDATE media SET source_path = ? WHERE id = ?').run(filePath, mediaId)
    } else {
      const target = path.join(store.mediaDir(), storedName)
      if (!fs.existsSync(target)) fs.copyFileSync(filePath, target)
      mediaId = store.db.prepare(
        `INSERT INTO media (hash, display_name, ext, kind, size, stored_name, source_path, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(hash, displayName, ext, kind, size, storedName, filePath, Date.now()).lastInsertRowid
    }

    store.db.prepare('INSERT INTO playlist_item (media_id, position, duration_sec) VALUES (?, ?, ?)')
      .run(mediaId, nextPosition(), kind === 'image' ? defaultSeconds : null)
    result.added += 1
  }

  bumpVersion()
  return result
}

function sourcePath(itemId) {
  const row = store.db.prepare(
    'SELECT m.source_path AS sourcePath FROM playlist_item p JOIN media m ON m.id = p.media_id WHERE p.id = ?'
  ).get(itemId)
  return row ? row.sourcePath : null
}

// 整批重寫 position，維持 1 起算且連續
const resequence = () => {
  const rows = store.db.prepare('SELECT id FROM playlist_item ORDER BY position, id').all()
  const update = store.db.prepare('UPDATE playlist_item SET position = ? WHERE id = ?')
  rows.forEach((row, index) => update.run(index + 1, row.id))
}

function remove(itemId) {
  const tx = store.db.transaction(() => {
    const row = store.db.prepare('SELECT media_id FROM playlist_item WHERE id = ?').get(itemId)
    if (!row) return
    store.db.prepare('DELETE FROM playlist_item WHERE id = ?').run(itemId)
    resequence()

    // 沒有任何清單項目引用時連實體檔一起清掉，發送端不留孤兒素材
    const stillUsed = store.db.prepare('SELECT id FROM playlist_item WHERE media_id = ?').get(row.media_id)
    if (!stillUsed) {
      const media = store.db.prepare('SELECT hash, stored_name FROM media WHERE id = ?').get(row.media_id)
      store.db.prepare('DELETE FROM media WHERE id = ?').run(row.media_id)
      if (media) {
        fs.rmSync(path.join(store.mediaDir(), media.stored_name), { force: true })
        thumbs.remove(media.hash)
      }
    }
  })
  tx()
  bumpVersion()
}

function move(itemId, delta) {
  const tx = store.db.transaction(() => {
    const items = store.db.prepare('SELECT id, position FROM playlist_item ORDER BY position, id').all()
    const index = items.findIndex((i) => i.id === itemId)
    const target = index + delta
    if (index < 0 || target < 0 || target >= items.length) return
    const update = store.db.prepare('UPDATE playlist_item SET position = ? WHERE id = ?')
    const reordered = items.slice()
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    reordered.forEach((row, i) => update.run(i + 1, row.id))
  })
  tx()
  bumpVersion()
}

function setDuration(itemId, seconds) {
  const row = store.db.prepare(
    'SELECT m.kind FROM playlist_item p JOIN media m ON m.id = p.media_id WHERE p.id = ?'
  ).get(itemId)
  if (!row || row.kind !== 'image') return // 影片播完整支，不接受秒數
  const value = Math.min(600, Math.max(1, Math.round(Number(seconds) || 0)))
  store.db.prepare('UPDATE playlist_item SET duration_sec = ? WHERE id = ?').run(value, itemId)
  bumpVersion()
}

function findMedia(hash) {
  return store.db.prepare('SELECT hash, ext, size, stored_name AS storedName FROM media WHERE hash = ?').get(hash)
}

function stats() {
  const row = store.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(m.size), 0) AS bytes
     FROM playlist_item p JOIN media m ON m.id = p.media_id`
  ).get()
  return { count: row.count, bytes: row.bytes, listVersion: store.getMeta('list_version') || '' }
}

module.exports = {
  list, addFiles, remove, move, setDuration, playlistPayload,
  findMedia, sourcePath, stats, bumpVersion, computeListVersion,
}
