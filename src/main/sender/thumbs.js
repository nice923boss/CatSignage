const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const log = require('../lib/log')

// 媒體庫縮圖：加入素材時由主行程產生，存成 userData/thumbs/<hash>.png，
// 介面經由 catmedia://thumb/ 讀取，不必放寬 CSP 讓渲染程序碰 userData
const SIZE = Object.freeze({ width: 160, height: 90 })
const HASH_RE = /^[0-9a-f]{64}$/
const FRAME_PAGE = path.join(__dirname, '..', '..', 'renderer', 'thumb', 'index.html')
const FRAME_TIMEOUT_MS = 15000

const queue = []
const failed = new Set() // 產不出縮圖的檔案不重試，介面改顯示類型文字
let busy = false
let onReady = () => {}

function dir() {
  return path.join(app.getPath('userData'), 'thumbs')
}

function thumbPath(hash) {
  return path.join(dir(), hash + '.png')
}

function has(hash) {
  return HASH_RE.test(hash) && fs.existsSync(thumbPath(hash))
}

function urlFor(hash) {
  return 'catmedia://thumb/' + hash + '.png'
}

// 殼層的影片縮圖只會從 Windows 縮圖快取拿，剛複製進媒體庫的檔案沒有快取一律失敗，
// 所以影片改用離屏視窗實際解碼：跳到代表畫格後截圖
async function videoFrame(sourcePath) {
  const win = new BrowserWindow({
    show: false,
    width: SIZE.width,
    height: SIZE.height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  let timer = null
  try {
    await win.loadFile(FRAME_PAGE, { query: { src: pathToFileURL(sourcePath).href } })
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), FRAME_TIMEOUT_MS) })
    const ready = await Promise.race([win.webContents.executeJavaScript('window.frameReady'), timeout])
    if (ready !== true) return null
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    return width === SIZE.width && height === SIZE.height ? image : image.resize(SIZE)
  } finally {
    clearTimeout(timer)
    win.destroy()
  }
}

// 圖片走殼層縮圖，失敗時再用 nativeImage 直接縮一次；影片先解碼擷取畫格，不行才退回殼層
async function render(sourcePath, kind) {
  if (kind === 'video') {
    try {
      const frame = await videoFrame(sourcePath)
      if (frame) return frame
    } catch (err) {
      log.append('thumbs', '影片畫格擷取失敗 ' + sourcePath + ' ' + (err && err.message))
    }
  }
  try {
    const image = await nativeImage.createThumbnailFromPath(sourcePath, SIZE)
    if (!image.isEmpty()) return image
  } catch {
    // 改走下面的備援
  }
  if (kind !== 'image') return null
  const image = nativeImage.createFromPath(sourcePath)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const scale = Math.min(SIZE.width / width, SIZE.height / height, 1)
  return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
}

async function generate(job) {
  const image = await render(job.sourcePath, job.kind)
  if (!image) {
    failed.add(job.hash)
    log.append('thumbs', '系統無法替這個檔案產生縮圖 ' + job.sourcePath)
    return false
  }
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(thumbPath(job.hash), image.toPNG())
  return true
}

async function drain() {
  if (busy) return
  busy = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (has(job.hash) || failed.has(job.hash)) continue
      try {
        if (await generate(job)) onReady(job.hash)
      } catch (err) {
        failed.add(job.hash)
        log.append('thumbs', '產生縮圖失敗 ' + job.sourcePath + ' ' + (err && err.message))
      }
    }
  } finally {
    busy = false
  }
}

// items：[{ hash, kind, sourcePath }]，已有縮圖或排隊中的會略過
function ensure(items) {
  for (const item of items) {
    if (!HASH_RE.test(item.hash) || has(item.hash) || failed.has(item.hash)) continue
    if (queue.some((job) => job.hash === item.hash)) continue
    queue.push({ hash: item.hash, kind: item.kind, sourcePath: item.sourcePath })
  }
  return drain()
}

function remove(hash) {
  if (!HASH_RE.test(hash)) return
  fs.rmSync(thumbPath(hash), { force: true })
  failed.delete(hash)
}

function setOnReady(fn) {
  onReady = fn || (() => {})
}

module.exports = { ensure, remove, has, urlFor, thumbPath, setOnReady, dir }
