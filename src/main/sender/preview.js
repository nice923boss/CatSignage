const { BrowserWindow } = require('electron')
const path = require('node:path')
const config = require('../config')
const library = require('./library')
const mediaProtocol = require('../player/protocol')

// 發送端預覽：用接收端同一套播放畫面，在一般視窗裡照目前的清單、秒數與轉場輪播，
// 讓編排的人不必等接收端同步就能看節奏。只讀發送端媒體庫，不碰接收端資料。

let win = null
let ready = false
let token = 0
let onClosed = () => {}

function payload() {
  return {
    transition: config.load().sender.defaultTransition,
    items: library.list().map((item) => ({
      position: item.position,
      hash: item.hash,
      kind: item.kind,
      displayName: item.displayName,
      durationSec: item.durationSec,
      url: mediaProtocol.libraryUrlFor(item.hash, item.ext),
    })),
  }
}

function send() {
  if (win && ready) win.webContents.send('player:playlist', { ...payload(), token })
}

function create() {
  const target = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 480,
    minHeight: 270,
    title: 'CatSignage 預覽播放（Esc 關閉，F11 全螢幕）',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // 預覽是用來看節奏的，被其他視窗蓋住時計時器也不能降頻
      backgroundThrottling: false,
    },
  })
  // 播放畫面的 HTML 標題是「播放中」，預覽視窗要維持操作提示
  target.on('page-title-updated', (event) => event.preventDefault())
  target.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      event.preventDefault()
      stop()
    } else if (input.key === 'F11') {
      event.preventDefault()
      target.setFullScreen(!target.isFullScreen())
    }
  })
  target.webContents.once('did-finish-load', () => {
    if (win !== target) return
    ready = true
    send()
  })
  target.on('closed', () => {
    if (win !== target) return
    win = null
    ready = false
    onClosed()
  })
  target.loadFile(path.join(__dirname, '..', '..', 'renderer', 'player', 'index.html'))
  return target
}

// 已開著就從第一項重新播，方便改完秒數後從頭看一次
function start() {
  if (library.list().length === 0) return { ok: false, error: '播放清單是空的，請先加入素材' }
  token += 1
  if (!win) {
    win = create()
  } else {
    send()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  return { ok: true, itemCount: library.list().length }
}

// 清單有變動就推過去，正在播的那項不打斷，下一項起套用新清單
function push() {
  if (!win) return
  if (library.list().length === 0) {
    stop()
    return
  }
  send()
}

function stop() {
  if (!win) return { ok: true }
  const target = win
  win = null
  ready = false
  target.destroy()
  onClosed()
  return { ok: true }
}

function isOpen() {
  return Boolean(win)
}

function setOnClosed(fn) {
  onClosed = fn || (() => {})
}

module.exports = { start, stop, push, isOpen, setOnClosed, payload }
