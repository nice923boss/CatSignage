const { protocol, net } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const store = require('../db/receiver')
const thumbs = require('../sender/thumbs')
const { kindOf } = require('../lib/media-kind')

// 播放視窗的 CSP 是 default-src 'self'，讀不到 userData 底下的檔案。
// 開放 file:// 等於讓渲染程序能讀整顆磁碟，所以改用只認得素材夾的自訂協定。
const SCHEME = 'catmedia'
const NAME_RE = /^[0-9a-f]{64}\.[a-z0-9]+$/
const THUMB_RE = /^[0-9a-f]{64}\.png$/

function register() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

// 檔名就是內容雜湊，格式固定，任何不合格式的請求都不必再往下查
// catmedia://media/<hash>.<ext> 是接收端素材，catmedia://thumb/<hash>.png 是發送端媒體庫縮圖
function resolve(urlString) {
  const url = new URL(urlString)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (url.host === 'thumb') {
    if (!THUMB_RE.test(name)) return null
    const full = path.join(thumbs.dir(), name)
    return fs.existsSync(full) ? full : null
  }
  if (url.host !== 'media') return null
  if (!NAME_RE.test(name)) return null
  if (!kindOf(name.split('.').pop())) return null
  const full = path.join(store.receivedDir(), name)
  return fs.existsSync(full) ? full : null
}

function handle() {
  protocol.handle(SCHEME, (request) => {
    const full = resolve(request.url)
    if (!full) return new Response('找不到素材', { status: 404 })
    return net.fetch(pathToFileURL(full).toString(), { headers: request.headers })
  })
}

function urlFor(hash, ext) {
  return SCHEME + '://media/' + hash + '.' + ext
}

module.exports = { register, handle, urlFor, resolve, SCHEME }
