// 產生應用程式圖示：build/icon.ico（多尺寸）與 build/icon.png（256，供人眼檢查）
// 執行：node scripts\make-icon.js
//
// 不依賴任何繪圖套件：在 1024x1024 的畫布上畫圖再降採樣，降採樣本身就是抗鋸齒。
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SS = 1024 // 超取樣畫布邊長
const BLUE = [47, 111, 208, 255] // #2f6fd0，與介面的 --accent 同色
const WHITE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

function canvas(size) {
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) buf.set(CLEAR, i * 4)
  return buf
}

function put(buf, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  buf.set(color, (y * size + x) * 4)
}

function fillRoundedRect(buf, size, x0, y0, w, h, r, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const dx = Math.min(x - x0, x0 + w - 1 - x)
      const dy = Math.min(y - y0, y0 + h - 1 - y)
      if (dx < r && dy < r) {
        const cx = dx < r ? (x < x0 + r ? x0 + r : x0 + w - 1 - r) : x
        const cy = dy < r ? (y < y0 + r ? y0 + r : y0 + h - 1 - r) : y
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
      }
      put(buf, size, x, y, color)
    }
  }
}

// 重心座標判定點在三角形內
function fillTriangle(buf, size, a, b, c, color) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
  if (den === 0) return
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den
      const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den
      const w3 = 1 - w1 - w2
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) put(buf, size, x, y, color)
    }
  }
}

// 有貓耳的螢幕，中間一個播放三角形
function draw() {
  const buf = canvas(SS)
  const s = SS / 1024 // 以 1024 為設計基準
  const ear = (tipX, baseLeftX, baseRightX) => fillTriangle(
    buf, SS,
    [tipX * s, 96 * s], [baseLeftX * s, 360 * s], [baseRightX * s, 360 * s], BLUE
  )
  ear(296, 176, 452)
  ear(728, 572, 848)
  fillRoundedRect(buf, SS, Math.round(96 * s), Math.round(288 * s), Math.round(832 * s), Math.round(640 * s), Math.round(96 * s), BLUE)
  fillTriangle(buf, SS, [420 * s, 440 * s], [420 * s, 776 * s], [688 * s, 608 * s], WHITE)
  return buf
}

// 盒式降採樣：每個目標像素取原圖對應方塊的平均值，含 alpha
function downsample(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let y = 0; y < dstSize; y += 1) {
    for (let x = 0; x < dstSize; x += 1) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = Math.floor(y * ratio); sy < Math.floor((y + 1) * ratio); sy += 1) {
        for (let sx = Math.floor(x * ratio); sx < Math.floor((x + 1) * ratio); sx += 1) {
          const i = (sy * srcSize + sx) * 4
          const alpha = src[i + 3] / 255
          r += src[i] * alpha; g += src[i + 1] * alpha; b += src[i + 2] * alpha; a += src[i + 3]
          n += 1
        }
      }
      const o = (y * dstSize + x) * 4
      const aAvg = a / n
      const cover = aAvg / 255
      dst[o] = cover > 0 ? Math.round(r / n / cover) : 0
      dst[o + 1] = cover > 0 ? Math.round(g / n / cover) : 0
      dst[o + 2] = cover > 0 ? Math.round(b / n / cover) : 0
      dst[o + 3] = Math.round(aAvg)
    }
  }
  return dst
}

/* ---------- PNG 編碼 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------- ICO 容器（每個尺寸都放 PNG） ---------- */

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = 圖示
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size // 256 在 ICO 裡記為 0
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir[at + 2] = 0 // 調色盤數
    dir[at + 3] = 0
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // bit count
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

function main() {
  const outDir = path.join(__dirname, '..', 'build')
  fs.mkdirSync(outDir, { recursive: true })

  const master = draw()
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = sizes.map((size) => ({ size, png: encodePng(downsample(master, SS, size), size) }))

  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(entries))
  fs.writeFileSync(path.join(outDir, 'icon.png'), entries[entries.length - 1].png)

  console.log(JSON.stringify({
    ico: path.join(outDir, 'icon.ico'),
    icoBytes: fs.statSync(path.join(outDir, 'icon.ico')).size,
    png: path.join(outDir, 'icon.png'),
    pngBytes: fs.statSync(path.join(outDir, 'icon.png')).size,
    sizes,
  }, null, 2))
}

main()
