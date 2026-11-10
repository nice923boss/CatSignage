const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 背景事件寫進 userData/logs/<name>.log，現場出問題時可以直接打開看
function append(name, message) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, name + '.log'), new Date().toISOString() + '\t' + message + '\n')
  } catch {
    // 日誌寫不進去不影響主流程
  }
}

module.exports = { append }
