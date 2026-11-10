const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 轉場清單的單一真相來源，介面選單與播放器都依這份資料
const TRANSITIONS = Object.freeze([
  Object.freeze({ id: 'none', label: '無（直接切換）' }),
  Object.freeze({ id: 'fade', label: '淡入淡出' }),
  Object.freeze({ id: 'slide', label: '水平滑動' }),
  Object.freeze({ id: 'slide-up', label: '向上滑動' }),
  Object.freeze({ id: 'zoom', label: '縮放淡入' }),
  Object.freeze({ id: 'wipe', label: '橫向擦除' }),
])
const TRANSITION_IDS = TRANSITIONS.map((t) => t.id)

const DEFAULTS = Object.freeze({
  mode: 'sender', // sender | receiver
  sender: Object.freeze({
    port: 28480,
    defaultTransition: 'fade', // 見 TRANSITIONS
    defaultImageSeconds: 8,
  }),
  receiver: Object.freeze({
    senderHost: '',
    senderPort: 28480,
    retentionMinutes: 43200, // 30 天
    maxCacheMB: 0, // 素材快取容量上限，0 代表不限制
    minFreeMB: 500, // 下載後磁碟至少要留下的空間，避免把系統碟塞滿
    autoPlayOnBoot: false, // 開機自動啟動並直接進播放
  }),
})

function clampNumber(value, min, max, fallback) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

let cache = null

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function mergeSection(base, patch) {
  return patch && typeof patch === 'object' ? { ...base, ...patch } : { ...base }
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const sender = mergeSection(DEFAULTS.sender, src.sender)
  if (!TRANSITION_IDS.includes(sender.defaultTransition)) {
    sender.defaultTransition = DEFAULTS.sender.defaultTransition
  }
  const receiver = mergeSection(DEFAULTS.receiver, src.receiver)
  receiver.autoPlayOnBoot = receiver.autoPlayOnBoot === true
  receiver.retentionMinutes = clampNumber(receiver.retentionMinutes, 1, 3650 * 1440, DEFAULTS.receiver.retentionMinutes)
  receiver.maxCacheMB = clampNumber(receiver.maxCacheMB, 0, 1024 * 1024 * 16, DEFAULTS.receiver.maxCacheMB)
  receiver.minFreeMB = clampNumber(receiver.minFreeMB, 0, 1024 * 1024, DEFAULTS.receiver.minFreeMB)
  return {
    mode: src.mode === 'receiver' ? 'receiver' : 'sender',
    sender,
    receiver,
  }
}

function load() {
  if (cache) return cache
  try {
    cache = normalize(JSON.parse(fs.readFileSync(configPath(), 'utf8')))
  } catch {
    cache = normalize(null)
    save(cache)
  }
  return cache
}

function save(next) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  cache = next
  return cache
}

// patch 只需帶要改的欄位，例如 { receiver: { senderHost: '100.x.x.x' } }
function update(patch) {
  const current = load()
  return save(normalize({
    mode: patch.mode ?? current.mode,
    sender: mergeSection(current.sender, patch.sender),
    receiver: mergeSection(current.receiver, patch.receiver),
  }))
}

module.exports = { load, update, configPath, DEFAULTS, TRANSITIONS, TRANSITION_IDS }
