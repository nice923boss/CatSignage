// 支援的素材格式，發送端匯入與接收端下載共用同一份判定
const IMAGE_EXT = ['jpg', 'png', 'gif', 'webp']
const VIDEO_EXT = ['mp4', 'webm']

const MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

// jpeg 與 JPG 都正規化成 jpg，實體檔名才不會出現同內容兩種副檔名
function normalizeExt(fileName) {
  const raw = String(fileName).split('.').pop().toLowerCase()
  return raw === 'jpeg' ? 'jpg' : raw
}

function kindOf(ext) {
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (VIDEO_EXT.includes(ext)) return 'video'
  return null
}

function mimeOf(ext) {
  return MIME[ext] || 'application/octet-stream'
}

module.exports = { IMAGE_EXT, VIDEO_EXT, normalizeExt, kindOf, mimeOf }
