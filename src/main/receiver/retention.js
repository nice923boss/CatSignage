const fs = require('node:fs')
const path = require('node:path')
const store = require('../db/receiver')
const config = require('../config')

const NAME_RE = /^[0-9a-f]{64}\.[a-z0-9]+$/

// 淘汰對象只有「已經不在清單裡」的孤兒檔案。仍在清單內的檔案就算很久沒播也留著，
// 否則長清單還沒輪完一圈，排在後面的檔就可能先超過門檻被刪掉，下一次同步又整份重下。
function orphanRows(cutoff) {
  return store.db.prepare(
    `SELECT hash, ext, display_name AS displayName, size,
            COALESCE(last_played_at, downloaded_at) AS idleSince
     FROM cached_media
     WHERE hash NOT IN (SELECT hash FROM cached_playlist)
       AND COALESCE(last_played_at, downloaded_at) < ?
     ORDER BY idleSince`
  ).all(cutoff)
}

// 有檔案卻沒有任何紀錄的情況（例如資料庫被人刪掉重建），用檔案自己的時間判斷，
// 不然這些檔會永遠留在硬碟上沒人回收
function unrecordedFiles(cutoff) {
  const dir = store.receivedDir()
  const known = new Set([
    ...store.db.prepare('SELECT hash FROM cached_media').all().map((r) => r.hash),
    ...store.db.prepare('SELECT hash FROM cached_playlist').all().map((r) => r.hash),
  ])
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!NAME_RE.test(name)) continue
    if (known.has(name.split('.')[0])) continue
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.mtimeMs >= cutoff) continue
    out.push({ hash: name.split('.')[0], ext: name.split('.').pop(), displayName: name, size: stat.size, idleSince: Math.round(stat.mtimeMs) })
  }
  return out
}

function removeFile(hash, ext) {
  try {
    fs.rmSync(path.join(store.receivedDir(), hash + '.' + ext), { force: true })
    return true
  } catch {
    return false // 檔案正被播放器讀著就先留著，下一輪同步再試
  }
}

// received 夾內所有素材檔的總大小，容量上限以實際占用為準，不只看資料庫
function cacheBytes() {
  const dir = store.receivedDir()
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    if (!NAME_RE.test(name)) continue
    try {
      total += fs.statSync(path.join(dir, name)).size
    } catch {
      // 檔案在列舉後被刪掉，不計
    }
  }
  return total
}

function sweep(targets, reason, dropRow, removed, seen) {
  for (const target of targets) {
    if (seen.has(target.hash)) continue
    seen.add(target.hash)
    if (!removeFile(target.hash, target.ext)) continue
    dropRow.run(target.hash)
    removed.push({ hash: target.hash, displayName: target.displayName, size: target.size, idleSince: target.idleSince, reason })
  }
}

// 超過容量時（或下載前空間不夠時），不管保留期，從閒置最久的孤兒開始刪，直到降到目標以下。
// 仍在清單內的檔案永遠不刪，所以清單本身比上限大時只能刪到剩清單內的檔。
function sweepToLimit(limitBytes, dropRow, removed, seen) {
  let total = cacheBytes()
  if (total <= limitBytes) return
  const orphans = [...orphanRows(Number.MAX_SAFE_INTEGER), ...unrecordedFiles(Number.MAX_SAFE_INTEGER)]
    .sort((a, b) => a.idleSince - b.idleSince)
  for (const target of orphans) {
    if (total <= limitBytes) break
    if (seen.has(target.hash)) continue
    seen.add(target.hash)
    if (!removeFile(target.hash, target.ext)) continue
    dropRow.run(target.hash)
    total -= target.size
    removed.push({ hash: target.hash, displayName: target.displayName, size: target.size, idleSince: target.idleSince, reason: 'capacity' })
  }
}

// options.freeUpBytes：下載前發現空間不足時呼叫，要求額外騰出的空間
function run(options = {}) {
  if (!store.db) return { ok: false, error: '接收端資料庫未開啟', removed: 0, bytes: 0, items: [] }

  // 清單是空的代表還沒成功取過清單，這時候每個檔案看起來都是孤兒，一律不淘汰
  const listed = store.db.prepare('SELECT COUNT(*) AS n FROM cached_playlist').get().n
  if (listed === 0) return { ok: true, skipped: '尚未取得清單', removed: 0, bytes: 0, items: [] }

  const cfg = config.load().receiver
  const minutes = cfg.retentionMinutes
  const cutoff = Date.now() - minutes * 60000

  const removed = []
  const seen = new Set()
  const dropRow = store.db.prepare('DELETE FROM cached_media WHERE hash = ?')
  sweep([...orphanRows(cutoff), ...unrecordedFiles(cutoff)], 'retention', dropRow, removed, seen)

  const limitBytes = cfg.maxCacheMB > 0 ? cfg.maxCacheMB * 1024 * 1024 : Infinity
  const freeUp = Number(options.freeUpBytes) > 0 ? Number(options.freeUpBytes) : 0
  const target = freeUp > 0 ? Math.min(limitBytes, Math.max(0, cacheBytes() - freeUp)) : limitBytes
  if (Number.isFinite(target)) sweepToLimit(target, dropRow, removed, seen)

  return {
    ok: true,
    at: Date.now(),
    retentionMinutes: minutes,
    maxCacheMB: cfg.maxCacheMB,
    cacheBytes: cacheBytes(),
    scanned: seen.size,
    removed: removed.length,
    bytes: removed.reduce((sum, r) => sum + r.size, 0),
    items: removed,
  }
}

module.exports = { run, cacheBytes }
