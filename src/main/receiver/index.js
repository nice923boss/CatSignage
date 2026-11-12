const store = require('../db/receiver')
const config = require('../config')
const client = require('./client')
const sync = require('./sync')
const downloader = require('./downloader')
const retention = require('./retention')

// 定時只打 /api/health，版本沒變就不抓清單也不下載；間隔由設定的 checkIntervalMinutes 決定。
// 連不上或下載沒完成時改用較短的間隔重試，開機時網路還沒好也不必等滿一個小時
const RETRY_MS = 5 * 60000

let active = false
let timer = null
let nextCheckAt = null
let notify = () => {}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function intervalMs() {
  return config.load().receiver.checkIntervalMinutes * 60000
}

function schedule(ms) {
  clearTimeout(timer)
  timer = null
  nextCheckAt = null
  if (!active) return
  nextCheckAt = Date.now() + ms
  timer = setTimeout(() => {
    timer = null
    runAndSchedule({})
  }, ms)
  notify()
}

// 每次同步（定時或手動）結束後從那一刻重新起算下次檢查
async function runAndSchedule(options) {
  if (sync.isRunning()) return { ok: false, error: '同步進行中' } // 進行中的那一次收尾時會排下一次
  const result = await sync.run(options)
  if (active) schedule(result.ok ? intervalMs() : Math.min(intervalMs(), RETRY_MS))
  return result
}

// 使用者改了檢查間隔：從現在起重新計算，不必等舊的計時到期
function reschedule() {
  if (active && !sync.isRunning()) schedule(intervalMs())
}

async function activate(notifyFn) {
  store.open()
  notify = notifyFn || (() => {})
  sync.setNotify(notifyFn)
  active = true

  // 啟動清殘檔：不在清單內的 .part 沒有續傳價值；清單內的保留，下次同步接著傳
  const cleaned = downloader.cleanupIncoming(sync.playlistHashes())
  // 啟動時先回收一次孤兒檔案，接著每次同步完成後還會再跑一次
  const recycled = sync.applyRetention()

  // 這裡不做首次同步，交給呼叫端另外觸發，設定頁按下切換後才不會卡住等下載；
  // 首次同步結束後由 runAndSchedule 排下一次檢查
  clearTimeout(timer)
  timer = null

  return { cleaned, recycled }
}

async function deactivate() {
  if (!active) return
  active = false
  clearTimeout(timer)
  timer = null
  nextCheckAt = null
  downloader.abort()
  // 等下載迴圈自己收尾，避免資料庫在寫入途中被關掉
  for (let i = 0; i < 50 && sync.isRunning(); i += 1) await wait(100)
  store.close()
}

async function syncNow(options) {
  if (!active) return { ok: false, error: '目前不是接收端模式' }
  return runAndSchedule(options || {})
}

// 設定頁的「測試連線」：只打 health，不改動任何本機資料
async function testConnection() {
  const cfg = config.load().receiver
  if (!cfg.senderHost) return { ok: false, error: '尚未設定發送端 IP' }
  const health = await client.getJson(cfg.senderHost, cfg.senderPort, '/api/health')
  if (!health.ok) return { ok: false, error: health.error }
  if (health.data.app !== 'CatSignage' || health.data.role !== 'sender') {
    return { ok: false, error: '對方不是 CatSignage 發送端' }
  }
  return { ok: true, version: health.data.version, listVersion: health.data.listVersion }
}

function snapshot() {
  if (!active) return null
  const base = sync.snapshot()
  return base && { ...base, nextCheckAt, checkIntervalMinutes: config.load().receiver.checkIntervalMinutes }
}

module.exports = {
  activate, deactivate, syncNow, reschedule, testConnection, snapshot, sync, downloader, retention, RETRY_MS,
}
