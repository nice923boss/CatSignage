const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('node:path')
const store = require('../db/receiver')
const mediaProtocol = require('./protocol')
const log = require('../lib/log')

const FIRST_FRAME_TIMEOUT_MS = 10000 // 等不到第一幀也要把控制權還給介面，不能讓按鈕永遠停用
const SHOW_WAIT_MS = 1500 // 等第一項畫面在背景掛好再顯示視窗；等太久就先顯示，免得按了像沒反應
const UNRESPONSIVE_GRACE_MS = 10000 // 畫面卡住超過這麼久就強制重啟渲染程序
const RECOVER_LIMIT = 5 // 一分鐘內最多自動復原幾次，避免壞掉的素材讓視窗無限重開
const RECOVER_WINDOW_MS = 60000

let win = null
let ready = false // renderer 載入完成，可以收訊息了
let lastPayload = { transition: 'fade', items: [] }
let startToken = 0 // 每按一次播放加一，renderer 靠它分辨「重新開播」和「清單更新」
let firstFrameResolve = null
let onClosed = () => {}
let wantPlaying = false // 使用者要求播放中；只有 Esc 與「停止播放」會把它關掉
let quitting = false
let recoverTimes = []
let unresponsiveTimer = null

function toPayload(snapshot) {
  if (!snapshot) return { transition: 'fade', items: [] }
  return {
    transition: snapshot.transition || 'fade',
    // 只送就緒的項目：沒下載完的東西連進輪播的機會都不該有
    items: snapshot.items.filter((item) => item.ready).map((item) => ({
      position: item.position, // renderer 依位置找「下一項」，就緒集合變動時順序才不會亂
      hash: item.hash,
      kind: item.kind,
      displayName: item.displayName,
      durationSec: item.durationSec,
      url: mediaProtocol.urlFor(item.hash, item.ext),
    })),
  }
}

// 待命視窗可能已經掛好畫面了，所以每次送出都附上目前的開播序號
function sendPayload(target) {
  target.webContents.send('player:playlist', { ...lastPayload, token: startToken })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, ms)))
}

function allowRecover() {
  const now = Date.now()
  const recent = recoverTimes.filter((t) => now - t < RECOVER_WINDOW_MS)
  if (recent.length >= RECOVER_LIMIT) {
    recoverTimes = recent
    return false
  }
  recoverTimes = [...recent, now]
  return true
}

function clearUnresponsive() {
  if (unresponsiveTimer !== null) {
    clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  }
}

// 渲染程序掛掉或卡死時，視窗本身還在，重新載入頁面即可；載入完成後 renderer 會從第一項重新開播
function reloadRenderer(target, reason) {
  if (!allowRecover()) {
    log.append('player', reason + '；一分鐘內已自動復原 ' + RECOVER_LIMIT + ' 次，停止播放')
    stop()
    return
  }
  log.append('player', reason + '；重新載入播放畫面')
  ready = false
  target.webContents.once('did-finish-load', () => {
    if (win !== target) return
    ready = true
    sendPayload(target)
  })
  target.webContents.reload()
}

// 視窗被關掉或摧毀但使用者沒有要求停止：重新開一個全螢幕視窗接著播
function recoverWindow(reason) {
  if (!allowRecover()) {
    log.append('player', reason + '；一分鐘內已自動復原 ' + RECOVER_LIMIT + ' 次，停止播放')
    wantPlaying = false
    onClosed()
    return
  }
  log.append('player', reason + '；重新開啟播放視窗')
  play().catch((err) => {
    log.append('player', '重新開啟播放視窗失敗 ' + (err && err.message))
    wantPlaying = false
    onClosed()
  })
}

function create() {
  const win2 = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    title: 'CatSignage 播放中',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 看板影片必須自己開始播，不能等使用者點擊
      autoplayPolicy: 'no-user-gesture-required',
      // 全螢幕被其他視窗蓋住時不降頻，否則輪播會卡住
      backgroundThrottling: false,
    },
  })

  // 播放中只認 Esc 與「停止播放」，Alt+F4 或其他程式送來的關閉要求一律擋下並記錄
  win2.on('close', (event) => {
    if (win !== win2 || !wantPlaying || quitting) return
    event.preventDefault()
    log.append('player', '播放中收到視窗關閉要求，已擋下（結束播放請按 Esc）')
  })

  win2.on('closed', () => {
    if (win !== win2) return // stop() 已經收掉，或已換成新視窗
    win = null
    ready = false
    firstFrameResolve = null
    clearUnresponsive()
    if (wantPlaying && !quitting) {
      recoverWindow('播放視窗意外關閉')
      return
    }
    onClosed()
  })

  // 系統或其他程式讓視窗離開全螢幕、縮到工作列時拉回來
  win2.on('leave-full-screen', () => {
    if (win !== win2 || !wantPlaying || quitting) return
    log.append('player', '播放視窗離開全螢幕，重新進入全螢幕')
    setTimeout(() => { if (win === win2 && wantPlaying) win2.setFullScreen(true) }, 200)
  })
  // 隱藏視窗切進全螢幕時 Windows 會送出短暫的縮小事件，稍等確認真的縮小了才還原
  win2.on('minimize', () => {
    if (win !== win2 || !wantPlaying || quitting) return
    setTimeout(() => {
      if (win !== win2 || !wantPlaying || win2.isDestroyed() || !win2.isMinimized()) return
      log.append('player', '播放視窗被縮小，已還原（焦點 ' + win2.isFocused() + '，全螢幕 ' + win2.isFullScreen() + '）')
      win2.restore()
    }, 100)
  })

  win2.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsive()
    if (win !== win2 || quitting) return
    reloadRenderer(win2, '播放畫面的渲染程序結束（' + details.reason + '，exitCode ' + details.exitCode + '）')
  })
  win2.on('unresponsive', () => {
    if (win !== win2 || quitting) return
    log.append('player', '播放畫面沒有回應')
    clearUnresponsive()
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      if (win !== win2 || win2.isDestroyed()) return
      log.append('player', '播放畫面持續 ' + UNRESPONSIVE_GRACE_MS / 1000 + ' 秒沒有回應，強制重啟渲染程序')
      win2.webContents.forcefullyCrashRenderer() // 會觸發 render-process-gone，由上面接手重新載入
    }, UNRESPONSIVE_GRACE_MS)
  })
  win2.on('responsive', () => {
    if (unresponsiveTimer === null) return
    clearUnresponsive()
    log.append('player', '播放畫面恢復回應')
  })

  // 系統登出或關機時不要擋關閉
  win2.on('session-end', () => { quitting = true })

  // Esc 一律離開播放，攔在主行程比較不受渲染程序焦點影響
  win2.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') stop()
  })

  win2.loadFile(path.join(__dirname, '..', '..', 'renderer', 'player', 'index.html'))
  return win2
}

function waitReady(target) {
  if (ready) return Promise.resolve()
  return new Promise((resolve) => {
    target.webContents.once('did-finish-load', () => {
      ready = true
      resolve()
    })
  })
}

// 開播前先把視窗與 renderer 準備好，按下播放時只剩顯示與全螢幕
async function prepare() {
  if (win) return
  win = create()
  await waitReady(win)
  sendPayload(win)
}

function showFullScreen(target) {
  const display = screen.getPrimaryDisplay()
  target.setBounds(display.bounds)
  target.setFullScreen(true)
  target.show()
  target.focus()
}

// 依 lastPayload 開播。新的開播序號會讓 renderer 從清單第一項開始，
// 先在隱藏的視窗裡把第一項掛好再顯示，按下播放看到的第一個畫面就是清單第 1 項
async function play() {
  const startedAt = Date.now()
  startToken += 1
  wantPlaying = true

  if (!win) {
    win = create()
    await waitReady(win)
  }
  const target = win
  const firstFrame = new Promise((resolve) => { firstFrameResolve = () => resolve(Date.now()) })
  sendPayload(target)

  const hasItems = lastPayload.items.length > 0
  let frameAt = hasItems ? await Promise.race([firstFrame, delay(SHOW_WAIT_MS)]) : null
  if (win !== target) return { ok: true, playing: isPlaying(), itemCount: lastPayload.items.length, firstFrameMs: null, timedOut: false }

  showFullScreen(target)
  const shownAt = Date.now()

  // 清單全空時不會有第一幀，直接回報，介面顯示的是「下載中，請稍候」
  if (!hasItems) {
    return { ok: true, playing: true, itemCount: 0, firstFrameMs: shownAt - startedAt, timedOut: false }
  }
  if (frameAt === null) {
    frameAt = await Promise.race([firstFrame, delay(FIRST_FRAME_TIMEOUT_MS - (shownAt - startedAt))])
  }
  const timedOut = frameAt === null
  return {
    ok: true,
    playing: true,
    itemCount: lastPayload.items.length,
    firstFrameMs: timedOut ? null : Math.max(frameAt, shownAt) - startedAt,
    timedOut,
  }
}

// 使用者親自按播放，代表已經處理過問題，自動復原的次數重新計算
function start(snapshot) {
  lastPayload = toPayload(snapshot)
  recoverTimes = []
  return play()
}

function stop() {
  wantPlaying = false
  clearUnresponsive()
  if (!win) return { ok: true, playing: false }
  const target = win
  win = null
  ready = false
  firstFrameResolve = null
  target.destroy()
  onClosed()
  return { ok: true, playing: false }
}

// 每完成一支下載就推一次，下一圈輪到時自然播出
function push(snapshot) {
  lastPayload = toPayload(snapshot)
  if (win && ready) sendPayload(win)
}

function isPlaying() {
  return Boolean(win) && win.isVisible()
}

function snapshot() {
  return { playing: isPlaying(), itemCount: lastPayload.items.length }
}

function setOnClosed(fn) {
  onClosed = fn || (() => {})
}

function registerIpc() {
  app.on('before-quit', () => { quitting = true })

  ipcMain.on('player:first-frame', () => {
    if (firstFrameResolve) {
      firstFrameResolve()
      firstFrameResolve = null
    }
  })

  ipcMain.on('player:played', (_event, hash) => {
    if (!store.db || typeof hash !== 'string') return
    store.db.prepare('UPDATE cached_media SET last_played_at = ? WHERE hash = ?').run(Date.now(), hash)
  })

  ipcMain.on('player:exit', () => stop())
}

module.exports = { prepare, start, stop, push, isPlaying, snapshot, setOnClosed, registerIpc, toPayload }
