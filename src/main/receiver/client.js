const http = require('node:http')

const JSON_TIMEOUT_MS = 5000
// 下載用的是閒置逾時：只要還有資料進來就不會觸發，網路慢但沒斷的情況不會被誤殺
const IDLE_TIMEOUT_MS = 20000

function describe(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED': return '發送端拒絕連線（程式未啟動或埠號不符）'
    case 'EHOSTUNREACH': return '無法連線到發送端（Tailscale 可能未連線）'
    case 'ENETUNREACH': return '網路不可達'
    case 'ETIMEDOUT': return '連線逾時'
    case 'ECONNRESET': return '連線被中斷'
    default: return err && err.message === 'timeout' ? '連線逾時' : '連線失敗（' + (err && (err.code || err.message)) + '）'
  }
}

function baseUrl(host, port) {
  return 'http://' + host + ':' + port
}

function getJson(host, port, pathname) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl(host, port) + pathname, { timeout: JSON_TIMEOUT_MS }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: '發送端回應 HTTP ' + res.statusCode })
          return
        }
        try {
          resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          resolve({ ok: false, error: '回應格式無法解析' })
        }
      })
      res.on('error', (err) => resolve({ ok: false, error: describe(err) }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => resolve({ ok: false, error: describe(err) }))
  })
}

// startAt > 0 代表接續先前中斷的 .part，發送端必須回 206 才算續傳成功
function openStream(host, port, hash, startAt) {
  return new Promise((resolve) => {
    const headers = startAt > 0 ? { Range: 'bytes=' + startAt + '-' } : {}
    const req = http.get(baseUrl(host, port) + '/api/file/' + hash, { headers, timeout: IDLE_TIMEOUT_MS }, (res) => {
      const expected = startAt > 0 ? 206 : 200
      if (res.statusCode !== expected) {
        res.resume()
        resolve({ ok: false, status: res.statusCode, error: '下載失敗（HTTP ' + res.statusCode + '）' })
        return
      }
      resolve({ ok: true, status: res.statusCode, res, req })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => resolve({ ok: false, error: describe(err) }))
  })
}

module.exports = { getJson, openStream, baseUrl, describe }
