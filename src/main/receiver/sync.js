const fs = require('node:fs')
const path = require('node:path')
const store = require('../db/receiver')
const config = require('../config')
const client = require('./client')
const downloader = require('./downloader')
const retention = require('./retention')
const { kindOf } = require('../lib/media-kind')

const HASH_RE = /^[0-9a-f]{64}$/
const PROGRESS_THROTTLE_MS = 400

// status：idle 尚未同步｜checking 連線中｜downloading 下載中｜ready 可播放｜offline 連不上｜error 有錯
let state = {
  status: 'idle',
  message: '尚未同步',
  online: false,
  lastSyncAt: null,
  lastError: null,
  downloading: null,
  lastRetention: null,
}
let running = false
let notify = () => {}
let lastEmitAt = 0

function setNotify(fn) {
  notify = fn || (() => {})
}

function emit(force) {
  const now = Date.now()
  if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return
  lastEmitAt = now
  notify()
}

function set(status, message, extra) {
  state = { ...state, status, message, ...(extra || {}) }
  emit(true)
}

/* ---------- 本機清單 ---------- */

function playlist() {
  return store.db.prepare(
    `SELECT position, hash, display_name AS displayName, ext, kind, size, duration_sec AS durationSec
     FROM cached_playlist ORDER BY position`
  ).all()
}

function playlistHashes() {
  return new Set(playlist().map((row) => row.hash))
}

// 只用「檔案存在且大小相符」判定就緒，不每次重算雜湊（下載當下已經驗過）
function cachedFileOk(row) {
  try {
    return fs.statSync(path.join(store.receivedDir(), row.hash + '.' + row.ext)).size === row.size
  } catch {
    return false
  }
}

function missingItems() {
  return playlist().filter((row) => !cachedFileOk(row))
}

// 檔案被手動刪掉時，紀錄要跟著失效，否則清單版本沒變就永遠不會重下
function pruneMissingRecords() {
  const rows = store.db.prepare('SELECT hash, ext, size FROM cached_media').all()
  const remove = store.db.prepare('DELETE FROM cached_media WHERE hash = ?')
  let pruned = 0
  for (const row of rows) {
    if (!cachedFileOk(row)) {
      remove.run(row.hash)
      pruned += 1
    }
  }
  return pruned
}

function recordMedia(item) {
  store.db.prepare(
    `INSERT INTO cached_media (hash, display_name, ext, kind, size, stored_name, downloaded_at, last_played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(hash) DO UPDATE SET display_name = excluded.display_name, downloaded_at = excluded.downloaded_at`
  ).run(item.hash, item.displayName, item.ext, item.kind, item.size, item.hash + '.' + item.ext, Date.now())
}

/* ---------- 遠端清單 ---------- */

// 清單來自網路，是系統邊界，逐欄檢查後才寫進資料庫
function validatePayload(data) {
  if (!data || data.app !== 'CatSignage') return '回應不是 CatSignage 播放清單'
  if (typeof data.listVersion !== 'string' || data.listVersion === '') return '清單版本缺漏'
  if (!Array.isArray(data.items)) return '清單格式錯誤'
  for (const item of data.items) {
    if (!Number.isInteger(item.position) || item.position < 1) return '項目順序不合法'
    if (!HASH_RE.test(String(item.hash))) return '項目雜湊不合法'
    if (kindOf(item.ext) !== item.kind) return '項目格式與類型不符：' + item.ext
    if (!Number.isInteger(item.size) || item.size <= 0) return '項目大小不合法'
    if (item.durationSec !== null && !Number.isInteger(item.durationSec)) return '項目秒數不合法'
    if (typeof item.displayName !== 'string' || item.displayName === '') return '項目名稱缺漏'
  }
  return null
}

function storePlaylist(data) {
  const tx = store.db.transaction(() => {
    store.db.prepare('DELETE FROM cached_playlist').run()
    const insert = store.db.prepare(
      `INSERT INTO cached_playlist (position, hash, display_name, ext, kind, size, duration_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    data.items.forEach((item, index) => {
      insert.run(index + 1, item.hash, item.displayName, item.ext, item.kind, item.size, item.durationSec)
    })
    store.setMeta('list_version', data.listVersion)
    store.setMeta('default_transition', data.defaultTransition || 'fade')
    store.setMeta('revision', String(data.revision || 0))
  })
  tx()
}

/* ---------- 主流程 ---------- */

async function execute(options) {
  const cfg = config.load().receiver
  if (!cfg.senderHost) {
    set('error', '尚未設定發送端 IP', { online: false, lastError: '尚未設定發送端 IP' })
    return { ok: false, error: '尚未設定發送端 IP' }
  }

  set('checking', '正在連線發送端…', { downloading: null })

  const health = await client.getJson(cfg.senderHost, cfg.senderPort, '/api/health')
  if (!health.ok) {
    // 連不上不清快取，改走離線播放，這是現場網路不穩時最重要的行為
    const ready = playlist().filter(cachedFileOk).length
    set('offline', '離線：' + health.error + (ready ? '，改用本機快取 ' + ready + ' 個素材' : ''),
      { online: false, lastError: health.error })
    return { ok: false, offline: true, error: health.error }
  }
  if (health.data.app !== 'CatSignage' || health.data.role !== 'sender') {
    set('error', '對方不是 CatSignage 發送端', { online: false, lastError: '對方不是 CatSignage 發送端' })
    return { ok: false, error: '對方不是 CatSignage 發送端' }
  }

  let fetched = false
  if (options.force || health.data.listVersion !== store.getMeta('list_version')) {
    const payload = await client.getJson(cfg.senderHost, cfg.senderPort, '/api/playlist')
    if (!payload.ok) {
      set('offline', '離線：' + payload.error, { online: false, lastError: payload.error })
      return { ok: false, offline: true, error: payload.error }
    }
    const invalid = validatePayload(payload.data)
    if (invalid) {
      set('error', '清單內容不合法：' + invalid, { online: true, lastError: invalid })
      return { ok: false, error: invalid }
    }
    storePlaylist(payload.data)
    fetched = true
  }

  pruneMissingRecords()
  const missing = missingItems()

  if (missing.length === 0) {
    set('ready', '已是最新，' + playlist().length + ' 個素材就緒',
      { online: true, lastError: null, lastSyncAt: Date.now(), downloading: null })
    return { ok: true, fetched, downloaded: 0, failed: 0 }
  }

  let downloaded = 0
  const failed = []
  for (let i = 0; i < missing.length; i += 1) {
    const item = missing[i]
    state.downloading = { name: item.displayName, received: 0, total: item.size, index: i + 1, count: missing.length }
    set('downloading', '下載中 ' + (i + 1) + '/' + missing.length + '：' + item.displayName, { online: true })

    const result = await downloader.download(cfg.senderHost, cfg.senderPort, item, (received, total) => {
      state.downloading = { ...state.downloading, received, total }
      emit(false)
    }, {
      minFreeMB: cfg.minFreeMB,
      // 空間不夠時先刪孤兒檔騰位置，清單內的檔不動
      makeRoom: (bytes) => applyRetention({ freeUpBytes: bytes }),
    })

    if (result.ok) {
      recordMedia(item)
      downloaded += 1
      emit(true) // 每完成一支就通知，播放器拿到第一支就能開播
    } else {
      failed.push({ name: item.displayName, error: result.error })
    }
  }

  state.downloading = null
  const readyCount = playlist().filter(cachedFileOk).length
  if (failed.length > 0) {
    const first = failed[0]
    set('error', '完成 ' + downloaded + ' 個，' + failed.length + ' 個失敗（' + first.name + '：' + first.error + '）',
      { online: true, lastError: first.error, lastSyncAt: Date.now() })
  } else {
    set('ready', '同步完成，' + readyCount + ' 個素材就緒',
      { online: true, lastError: null, lastSyncAt: Date.now() })
  }
  return { ok: failed.length === 0, fetched, downloaded, failed: failed.length, failures: failed }
}

async function run(options = {}) {
  if (running) return { ok: false, error: '同步進行中' }
  running = true
  downloader.begin()
  try {
    const result = await execute(options)
    // 淘汰放在同步之後：這時候本機清單剛更新過，孤兒判定用的才是最新的清單
    applyRetention()
    return result
  } catch (err) {
    set('error', '同步發生例外：' + err.message, { lastError: err.message })
    return { ok: false, error: err.message }
  } finally {
    running = false
  }
}

// 淘汰結果留在同步狀態裡，介面才看得到上次回收了什麼
function applyRetention(options) {
  const result = retention.run(options)
  const prev = state.lastRetention
  // 沒回收東西時保留上一次回收的紀錄，只更新目前快取大小
  const next = result.removed === 0 && prev
    ? { ...prev, cacheBytes: result.cacheBytes }
    : { at: result.at || Date.now(), removed: result.removed, bytes: result.bytes, cacheBytes: result.cacheBytes }
  if (!prev || result.removed > 0 || prev.cacheBytes !== next.cacheBytes) {
    state = { ...state, lastRetention: next }
    emit(true)
  }
  return result
}

function isRunning() {
  return running
}

function snapshot() {
  if (!store.db) return null
  const items = playlist().map((row) => ({ ...row, ready: cachedFileOk(row) }))
  const ready = items.filter((i) => i.ready)
  return {
    ...state,
    listVersion: store.getMeta('list_version') || '',
    transition: store.getMeta('default_transition') || 'fade',
    items,
    readyCount: ready.length,
    totalCount: items.length,
    readyBytes: ready.reduce((sum, i) => sum + i.size, 0),
    totalBytes: items.reduce((sum, i) => sum + i.size, 0),
  }
}

module.exports = {
  run, isRunning, snapshot, setNotify, playlist, playlistHashes,
  missingItems, cachedFileOk, validatePayload, pruneMissingRecords, applyRetention,
}
