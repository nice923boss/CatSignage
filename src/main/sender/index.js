const { dialog } = require('electron')
const path = require('node:path')
const store = require('../db/sender')
const server = require('./server')
const library = require('./library')
const thumbs = require('./thumbs')
const config = require('../config')
const { tailnetIPv4 } = require('../lib/tailnet')
const { IMAGE_EXT, VIDEO_EXT } = require('../lib/media-kind')

const IP_WATCH_MS = 30000

let active = false
let watchTimer = null
let notify = () => {}

async function startServer() {
  const tailnet = tailnetIPv4()
  if (!tailnet) {
    await server.stop()
    return { ok: false, error: '未偵測到 Tailscale 連線，服務未啟動' }
  }
  await server.stop()
  return server.start(tailnet.ip, config.load().sender.port)
}

// Tailscale 重連可能換 IP，服務綁的是舊位址就會變成連不上卻看起來正常
function watchAddress() {
  clearInterval(watchTimer)
  watchTimer = setInterval(async () => {
    if (!active) return
    const current = tailnetIPv4()
    const state = server.status()
    const changed = current && state.running && current.ip !== state.ip
    const recoverable = current && !state.running
    if (changed || recoverable) {
      await startServer()
      notify()
    }
  }, IP_WATCH_MS)
}

// 縮圖從發送端自己的素材夾產生，不回頭讀使用者原始路徑（原檔可能已搬走）
function thumbJobs() {
  return library.list().map((i) => ({ hash: i.hash, kind: i.kind, sourcePath: path.join(store.mediaDir(), i.storedName) }))
}

async function activate(notifyFn, onAccess) {
  notify = notifyFn || notify
  store.open()
  library.bumpVersion()
  active = true
  server.setOnAccess(onAccess)
  thumbs.setOnReady(() => { if (active) notify() })
  thumbs.ensure(thumbJobs()) // 舊版本加入的素材沒有縮圖，啟動時補做，不等它完成
  const result = await startServer()
  watchAddress()
  return result
}

async function deactivate() {
  active = false
  server.setOnAccess(null)
  clearInterval(watchTimer)
  watchTimer = null
  await server.stop()
  store.close()
}

async function restartServer() {
  if (!active) return { ok: false, error: '目前不是發送端模式' }
  const result = await startServer()
  notify()
  return result
}

async function pickAndAdd(parentWindow) {
  const picked = await dialog.showOpenDialog(parentWindow, {
    title: '選擇要加入的素材',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '圖片與影片', extensions: [...IMAGE_EXT, 'jpeg', ...VIDEO_EXT] },
      { name: '所有檔案', extensions: ['*'] },
    ],
  })
  if (picked.canceled || picked.filePaths.length === 0) return { added: 0, duplicated: 0, rejected: [] }
  const result = await library.addFiles(picked.filePaths)
  thumbs.ensure(thumbJobs()) // 縮圖在背景產生，產好一張就推一次狀態
  return result
}

function snapshot() {
  if (!active) return null
  return {
    items: library.list().map((i) => ({ ...i, thumb: thumbs.has(i.hash) ? thumbs.urlFor(i.hash) : null })),
    stats: library.stats(),
    server: server.status(),
    access: server.recentAccess(10),
  }
}

module.exports = { activate, deactivate, restartServer, pickAndAdd, snapshot, library, server, thumbs, thumbJobs }
