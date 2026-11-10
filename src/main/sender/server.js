const { app } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { pipeline } = require('node:stream')
const store = require('../db/sender')
const library = require('./library')
const { mimeOf } = require('../lib/media-kind')
const { isTailnetAddress } = require('../lib/tailnet')
const log = require('../lib/log')

const HASH_RE = /^[0-9a-f]{64}$/
const LOG_KEEP = 200

let server = null
let bound = null
let lastError = null
const recentLog = []
const ACCESS_PUSH_MS = 500 // 接收端一次同步會打好幾個請求，合併成一次推送

let onAccess = null
let pushTimer = null

function setOnAccess(fn) {
  onAccess = typeof fn === 'function' ? fn : null
  if (!onAccess) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

function schedulePush() {
  if (!onAccess || pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (onAccess) onAccess(recentAccess(10))
  }, ACCESS_PUSH_MS)
}

function logLine(entry) {
  recentLog.unshift(entry)
  if (recentLog.length > LOG_KEEP) recentLog.length = LOG_KEEP
  schedulePush()
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'access.log'),
      `${new Date(entry.at).toISOString()}\t${entry.remote}\t${entry.method} ${entry.pathname}\t${entry.status}\n`
    )
  } catch {
    // 日誌寫入失敗不影響供檔
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

// pipeline 會在接收端中途斷線時一併關掉讀檔串流；只用 pipe 的話檔案控制代碼會留著，
// Windows 上之後刪檔會卡在待刪除狀態，同名檔案再加入時複製失敗
function streamFile(res, filePath, options, displayName) {
  pipeline(fs.createReadStream(filePath, options), res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.append('server', '送檔失敗 ' + displayName + '：' + err.message)
  })
}

function serveFile(req, res, hash) {
  const media = library.findMedia(hash)
  if (!media) {
    sendJson(res, 404, { error: 'not_found' })
    return 404
  }

  const filePath = path.join(store.mediaDir(), media.storedName)
  let size
  try {
    size = fs.statSync(filePath).size
  } catch {
    sendJson(res, 500, { error: 'read_failed' })
    return 500
  }

  const headers = {
    'Content-Type': mimeOf(media.ext),
    ETag: '"' + media.hash + '"',
    'Accept-Ranges': 'bytes',
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
    if (!Number.isFinite(start) || start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return 416
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = end - start + 1
    res.writeHead(206, headers)
    streamFile(res, filePath, { start, end }, media.displayName)
    return 206
  }

  headers['Content-Length'] = size
  res.writeHead(200, headers)
  streamFile(res, filePath, {}, media.displayName)
  return 200
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const remote = req.socket.remoteAddress || ''
  let status

  if (url.pathname === '/api/health') {
    status = 200
    sendJson(res, 200, {
      app: 'CatSignage',
      role: 'sender',
      version: app.getVersion(),
      listVersion: store.getMeta('list_version') || '',
    })
  } else if (url.pathname === '/api/playlist') {
    status = 200
    sendJson(res, 200, library.playlistPayload())
  } else if (url.pathname.startsWith('/api/file/')) {
    const hash = url.pathname.slice('/api/file/'.length)
    if (!HASH_RE.test(hash)) {
      status = 400
      sendJson(res, 400, { error: 'bad_hash' })
    } else {
      status = serveFile(req, res, hash)
    }
  } else {
    status = 404
    sendJson(res, 404, { error: 'not_found' })
  }

  logLine({ at: Date.now(), remote, method: req.method, pathname: url.pathname, status })
}

// 只綁 tailnet 介面位址，不接受 0.0.0.0 與 127.0.0.1
function start(ip, port) {
  return new Promise((resolve) => {
    if (server) return resolve({ ok: true, ip: bound.ip, port: bound.port })
    if (!isTailnetAddress(ip)) {
      lastError = '拒絕綁定非 Tailscale 位址：' + ip
      return resolve({ ok: false, error: lastError })
    }
    lastError = null
    const s = http.createServer(handle)
    s.on('error', (err) => {
      lastError = err.code === 'EADDRINUSE'
        ? `埠號 ${port} 已被其他程式占用`
        : `無法綁定 ${ip}:${port}（${err.code}）`
      server = null
      bound = null
      resolve({ ok: false, error: lastError })
    })
    s.listen(port, ip, () => {
      server = s
      bound = { ip, port }
      resolve({ ok: true, ip, port })
    })
  })
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.close(() => {
      server = null
      bound = null
      resolve()
    })
    server.closeAllConnections?.()
  })
}

function status() {
  return { running: Boolean(server), ip: bound?.ip || null, port: bound?.port || null, error: lastError }
}

function recentAccess(limit = 20) {
  return recentLog.slice(0, limit)
}

module.exports = { start, stop, status, recentAccess, setOnAccess }
