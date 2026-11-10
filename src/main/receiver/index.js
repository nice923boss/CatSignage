const store = require('../db/receiver')
const config = require('../config')
const client = require('./client')
const sync = require('./sync')
const downloader = require('./downloader')
const retention = require('./retention')

const POLL_MS = 60000 // 定時只打 /api/health，版本沒變就不抓清單也不下載

let active = false
let timer = null

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function activate(notifyFn) {
  store.open()
  sync.setNotify(notifyFn)
  active = true

  // 啟動清殘檔：不在清單內的 .part 沒有續傳價值；清單內的保留，下次同步接著傳
  const cleaned = downloader.cleanupIncoming(sync.playlistHashes())
  // 啟動時先回收一次孤兒檔案，接著每次同步完成後還會再跑一次
  const recycled = sync.applyRetention()

  // 這裡不做首次同步，交給呼叫端另外觸發，設定頁按下切換後才不會卡住等下載
  clearInterval(timer)
  timer = setInterval(() => {
    if (active && !sync.isRunning()) sync.run()
  }, POLL_MS)

  return { cleaned, recycled }
}

async function deactivate() {
  if (!active) return
  active = false
  clearInterval(timer)
  timer = null
  downloader.abort()
  // 等下載迴圈自己收尾，避免資料庫在寫入途中被關掉
  for (let i = 0; i < 50 && sync.isRunning(); i += 1) await wait(100)
  store.close()
}

async function syncNow(options) {
  if (!active) return { ok: false, error: '目前不是接收端模式' }
  return sync.run(options || {})
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
  return sync.snapshot()
}

module.exports = { activate, deactivate, syncNow, testConnection, snapshot, sync, downloader, retention }
