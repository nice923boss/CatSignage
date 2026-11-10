const fs = require('node:fs')
const path = require('node:path')
const store = require('../db/receiver')
const client = require('./client')
const { hashFile } = require('../lib/hash')

const MAX_ATTEMPTS = 5
// 第 n 次重試前等待的毫秒數。每次都從 .part 現有大小續傳，斷線多次也不會從頭來
const BACKOFF_MS = [0, 2000, 5000, 10000, 20000]
const MB = 1024 * 1024

let currentRequest = null
let aborted = false

function partPath(item) {
  return path.join(store.incomingDir(), item.hash + '.' + item.ext + '.part')
}

function finalPath(item) {
  return path.join(store.receivedDir(), item.hash + '.' + item.ext)
}

function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function formatMB(bytes) {
  return (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0) + ' MB'
}

// 磁碟可用空間。取不到（例如極舊的系統）回 null，交給後面的寫入錯誤處理
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

// 下載前檢查：剩下要收的量加上保留空間，硬碟要放得下。放不下先請 makeRoom 淘汰孤兒，再不夠就放棄
function ensureSpace(item, options) {
  const remaining = Math.max(0, item.size - sizeOf(partPath(item)))
  const need = remaining + (options.minFreeMB || 0) * MB
  let free = freeBytes(store.incomingDir())
  if (free === null || free >= need) return { ok: true }
  if (typeof options.makeRoom === 'function') {
    options.makeRoom(need - free)
    free = freeBytes(store.incomingDir())
    if (free === null || free >= need) return { ok: true }
  }
  return {
    ok: false,
    error: '磁碟空間不足：需要 ' + formatMB(need) + '（含保留 ' + (options.minFreeMB || 0) + ' MB），剩 ' + formatMB(free),
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve()
    const started = Date.now()
    const timer = setInterval(() => {
      if (aborted || Date.now() - started >= ms) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

function pipeToPart(res, part, startAt, total, onProgress) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const out = fs.createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' })
    let received = startAt

    res.on('data', (chunk) => {
      received += chunk.length
      onProgress(received, total)
    })
    res.on('error', (err) => {
      out.destroy()
      settle({ ok: false, error: client.describe(err) })
    })
    out.on('error', (err) => {
      res.destroy()
      settle({ ok: false, error: '寫入暫存檔失敗（' + err.code + '）' })
    })
    // 用 close 而非 finish：Windows 上檔案描述子還沒關就改名會失敗
    out.on('close', () => {
      settle(out.writableFinished ? { ok: true, received } : { ok: false, error: '下載中斷' })
    })

    res.pipe(out)
  })
}

// 單次嘗試：能續傳就續傳，收完一定驗雜湊，驗過才改名進 cache
async function pull(host, port, item, onProgress) {
  const part = partPath(item)
  let startAt = sizeOf(part)
  if (startAt > item.size) {
    fs.rmSync(part, { force: true }) // 殘檔比預期大，代表對不上內容，整個重來
    startAt = 0
  }

  if (startAt < item.size) {
    const opened = await client.openStream(host, port, item.hash, startAt)
    if (!opened.ok) {
      // 416 代表殘檔跟發送端的檔案對不上，刪掉下一輪從頭收
      if (opened.status === 416) fs.rmSync(part, { force: true })
      return { ok: false, error: opened.error, permanent: opened.status === 404 }
    }
    currentRequest = opened.req
    const written = await pipeToPart(opened.res, part, startAt, item.size, onProgress)
    currentRequest = null
    if (!written.ok) return { ok: false, error: written.error }
  } else {
    onProgress(item.size, item.size)
  }

  const digest = await hashFile(part)
  if (digest !== item.hash) {
    fs.rmSync(part, { force: true })
    return { ok: false, error: '內容驗證失敗，已捨棄暫存檔' }
  }

  fs.mkdirSync(store.receivedDir(), { recursive: true })
  fs.renameSync(part, finalPath(item))
  return { ok: true, resumedFrom: startAt }
}

// options.minFreeMB：下載後磁碟至少要留的空間；options.makeRoom(bytes)：空間不足時的淘汰回呼；
// options.backoffMs：測試用，覆寫重試間隔
async function download(host, port, item, onProgress, options = {}) {
  const backoff = options.backoffMs || BACKOFF_MS
  let lastError = '未知錯誤'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await wait(backoff[Math.min(attempt - 1, backoff.length - 1)])
    if (aborted) return { ok: false, error: '已取消', attempts: attempt - 1 }
    const space = ensureSpace(item, options)
    if (!space.ok) return { ok: false, error: space.error, attempts: attempt - 1, noSpace: true }
    const result = await pull(host, port, item, onProgress || (() => {}))
    if (result.ok) return { ok: true, attempts: attempt, resumedFrom: result.resumedFrom }
    lastError = result.error
    if (result.permanent) return { ok: false, error: lastError, attempts: attempt }
  }
  return { ok: false, error: lastError, attempts: MAX_ATTEMPTS }
}

function begin() {
  aborted = false
}

function abort() {
  aborted = true
  if (currentRequest) {
    currentRequest.destroy(new Error('aborted'))
    currentRequest = null
  }
}

// 啟動時清殘檔：不在目前清單內的 .part 沒有續傳價值，直接刪
function cleanupIncoming(keepHashes) {
  let removed = 0
  let kept = 0
  for (const name of fs.readdirSync(store.incomingDir())) {
    if (!name.endsWith('.part')) continue
    if (keepHashes.has(name.split('.')[0])) {
      kept += 1
      continue
    }
    fs.rmSync(path.join(store.incomingDir(), name), { force: true })
    removed += 1
  }
  return { removed, kept }
}

module.exports = { download, begin, abort, cleanupIncoming, partPath, finalPath, freeBytes, MAX_ATTEMPTS }
