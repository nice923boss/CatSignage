const crypto = require('node:crypto')
const fs = require('node:fs')

// 串流計算，避免大影片整包讀進記憶體
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => sha.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(sha.digest('hex')))
  })
}

function hashString(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

module.exports = { hashFile, hashString }
