const DEFAULT_IMAGE_SECONDS = 8
const VIDEO_GUARD_EXTRA_MS = 5000 // 影片沒觸發 ended 時的保險，避免整個輪播卡死

// 每種轉場由「新層進場動畫」與「舊層退場動畫」兩半組成，
// 滑動與擦除靠新層蓋過舊層，舊層不必動
const TRANSITIONS = {
  none: { enter: null, leave: null, ms: 0 },
  fade: { enter: 'tx-fade-in', leave: 'tx-fade-out', ms: 600 },
  slide: { enter: 'tx-slide-in', leave: null, ms: 600 },
  'slide-up': { enter: 'tx-slide-up-in', leave: null, ms: 600 },
  zoom: { enter: 'tx-zoom-in', leave: 'tx-fade-out', ms: 700 },
  wipe: { enter: 'tx-wipe-in', leave: null, ms: 700 },
}

const stage = document.getElementById('stage')
const notice = document.getElementById('notice')

let items = []
let transition = 'fade'
let cursor = null // 上一個嘗試播放的清單位置（position），null 代表從第一項開始
let currentLayer = null
let advanceTimer = null
let generation = 0
let firstFrameSent = false
let startToken = null // 主行程的開播序號，變了就代表使用者重新按了播放

function clearTimer() {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer)
    advanceTimer = null
  }
}

// video 要先停掉並解開來源，只是移除節點的話解碼器不一定會馬上釋放
function disposeLayer(layer) {
  const video = layer.querySelector('video')
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  layer.remove()
}

function buildElement(item) {
  return new Promise((resolve) => {
    if (item.kind === 'video') {
      const video = document.createElement('video')
      video.src = item.url
      video.preload = 'auto'
      video.playsInline = true
      video.addEventListener('canplay', () => resolve(video), { once: true })
      video.addEventListener('error', () => resolve(null), { once: true })
      return
    }
    const img = document.createElement('img')
    img.decoding = 'async'
    img.addEventListener('load', () => resolve(img), { once: true })
    img.addEventListener('error', () => resolve(null), { once: true })
    img.src = item.url
  })
}

function mount(element, item, gen, instant) {
  const spec = instant ? TRANSITIONS.none : (TRANSITIONS[transition] || TRANSITIONS.fade)
  const layer = document.createElement('div')
  layer.className = 'layer'
  layer.appendChild(element)
  if (spec.enter) layer.classList.add(spec.enter)
  stage.appendChild(layer)

  const previous = currentLayer
  currentLayer = layer
  if (previous) {
    if (spec.leave) previous.classList.add(spec.leave)
    setTimeout(() => disposeLayer(previous), spec.ms)
  }

  notice.classList.add('hidden')
  window.catplayer.reportPlayed(item.hash)
  if (!firstFrameSent) {
    firstFrameSent = true
    window.catplayer.reportFirstFrame()
  }

  if (item.kind === 'video') {
    element.addEventListener('ended', () => { if (gen === generation) advance() }, { once: true })
    element.play().catch(() => { if (gen === generation) advance() })
    const guard = (Number.isFinite(element.duration) ? element.duration * 1000 : 0) + VIDEO_GUARD_EXTRA_MS
    advanceTimer = setTimeout(() => { if (gen === generation) advance() }, guard)
    return
  }

  const seconds = Number.isInteger(item.durationSec) && item.durationSec > 0
    ? item.durationSec
    : DEFAULT_IMAGE_SECONDS
  advanceTimer = setTimeout(() => { if (gen === generation) advance() }, seconds * 1000)
}

function showNotice() {
  clearTimer()
  if (currentLayer) {
    disposeLayer(currentLayer)
    currentLayer = null
  }
  notice.classList.remove('hidden')
}

// 下一項是「位置排在上一項之後的第一個就緒項目」，沒有就繞回第一項。
// 用位置而不是陣列索引，就緒集合在下載期間變大時，順序才會跟清單一致
function nextIndex(list) {
  if (cursor === null) return 0
  const index = list.findIndex((item) => item.position > cursor)
  return index === -1 ? 0 : index
}

async function advance(options = {}) {
  clearTimer()
  const gen = ++generation
  const list = items

  if (list.length === 0) {
    showNotice()
    return
  }

  // 載不起來的項目直接跳過，整份清單都載不起來才回到提示畫面
  const first = nextIndex(list)
  for (let tried = 0; tried < list.length; tried += 1) {
    const item = list[(first + tried) % list.length]
    cursor = item.position

    const element = await buildElement(item)
    if (gen !== generation) return // 期間有人重新開始輪播，這一輪作廢
    if (element) {
      mount(element, item, gen, options.instant === true)
      return
    }
  }
  showNotice()
}

function applyPlaylist(payload) {
  const next = Array.isArray(payload.items) ? payload.items : []
  const wasEmpty = items.length === 0
  // 舊格式沒有 position 時用陣列順序補上
  items = next.map((item, index) => (Number.isInteger(item.position) ? item : { ...item, position: index + 1 }))
  transition = payload.transition || 'fade'

  // 重新開播（按下播放、或播放畫面重新載入）：一律從清單第一項開始。
  // 待命視窗可能早就在背景播到別項，這時直接切換、不跑轉場；
  // 主行程等第一項掛好才顯示視窗，所以看不到切換的過程
  if (payload.token !== startToken) {
    startToken = payload.token
    firstFrameSent = false
    cursor = null
    if (items.length === 0) showNotice()
    else advance({ instant: Boolean(currentLayer) })
    return
  }

  // 正在播的那支不打斷，播完自然會前進到新清單；從空清單變有東西才立刻開播
  if (items.length === 0) showNotice()
  else if (wasEmpty || !currentLayer) advance()
}

window.catplayer.onPlaylist(applyPlaylist)
