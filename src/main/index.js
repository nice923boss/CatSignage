const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const config = require('./config')
const sender = require('./sender')
const receiver = require('./receiver')
const player = require('./player')
const autostart = require('./autostart')
const mediaProtocol = require('./player/protocol')
const { tailnetIPv4 } = require('./lib/tailnet')
const tailscaleGuide = require('./lib/tailscale-guide')

// --profile=<名稱> 讓同一台電腦跑多個獨立實例（雙實例驗收與一機多用途）
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
const PROFILE = profileArg ? profileArg.slice('--profile='.length).replace(/[^\w-]/g, '') || 'default' : 'default'
app.setPath('userData', path.join(app.getPath('appData'), 'CatSignage', PROFILE))

// 自訂協定必須趕在 app ready 之前註冊，晚了就沒有效力
mediaProtocol.register()

if (!app.requestSingleInstanceLock()) {
  // 同 profile 已有實例在跑，交給既有視窗處理後直接結束
  app.exit(0)
}

let mainWindow = null
let mainWindowCreated = false

function createMainWindow() {
  mainWindowCreated = true
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    title: 'CatSignage 電子看板',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'main', 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 待命中的播放視窗是隱藏的，不收掉的話所有視窗都關了程式也不會結束
    if (!player.isPlaying()) player.stop()
  })
}

function buildState() {
  const cfg = config.load()
  const tailnet = tailnetIPv4()
  return {
    profile: PROFILE,
    version: app.getVersion(),
    mode: cfg.mode,
    config: cfg,
    tailnet,
    transitions: config.TRANSITIONS,
    sender: sender.snapshot(),
    receiver: receiver.snapshot(),
    player: player.snapshot(),
    autoStart: autostart.status(PROFILE),
    userDataPath: app.getPath('userData'),
  }
}

// 開機自啟只在「接收端 + 有勾自動播放」時掛著，切回發送端就把啟動項收掉，
// 否則使用者換模式後電腦還是會自己開一個看板出來
function syncAutoStart(cfg) {
  const want = cfg.mode === 'receiver' && cfg.receiver.autoPlayOnBoot === true
  if (autostart.status(PROFILE).enabled !== want) autostart.apply(PROFILE, want)
}

// 存取記錄只更新媒體庫頁的那一塊，不重畫整頁，使用者正在改秒數也不會被打斷
function broadcastAccess(entries) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sender:access', entries)
}

function broadcastState() {
  // 每完成一支下載都會走到這裡，順手把新的就緒集合推給播放視窗
  player.push(receiver.snapshot())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', buildState())
  }
}

// 設定變更後同步調整服務狀態，使用者不必自己重開程式
async function applyMode(before, after) {
  if (before.mode !== after.mode) {
    if (before.mode === 'sender') await sender.deactivate()
    if (before.mode === 'receiver') {
      player.stop()
      await receiver.deactivate()
    }
    if (after.mode === 'sender') await sender.activate(broadcastState, broadcastAccess)
    if (after.mode === 'receiver') {
      await receiver.activate(broadcastState)
      player.prepare() // 先把播放視窗建起來藏著，按下播放時只剩顯示與全螢幕
      receiver.syncNow() // 不等它跑完，進度由 broadcastState 陸續送到介面
    }
    return
  }
  if (after.mode === 'sender') {
    if (before.sender.port !== after.sender.port) {
      await sender.restartServer()
    } else if (before.sender.defaultTransition !== after.sender.defaultTransition) {
      sender.library.bumpVersion() // 轉場屬於清單內容，改了就要換版本號
    }
    return
  }
  // 接收端改了發送端位址，立刻重新同步，使用者不必自己按按鈕
  if (before.receiver.senderHost !== after.receiver.senderHost ||
      before.receiver.senderPort !== after.receiver.senderPort) {
    receiver.syncNow({ force: true })
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  mediaProtocol.handle()

  ipcMain.handle('app:getState', () => buildState())

  ipcMain.handle('config:update', async (_e, patch) => {
    const before = config.load()
    const after = config.update(patch || {})
    await applyMode(before, after)
    syncAutoStart(after)
    broadcastState()
    return buildState()
  })

  ipcMain.handle('app:openUserData', () => shell.openPath(app.getPath('userData')))

  ipcMain.handle('sender:addFiles', async () => {
    const result = await sender.pickAndAdd(mainWindow)
    broadcastState()
    return result
  })
  ipcMain.handle('sender:remove', (_e, itemId) => {
    sender.library.remove(itemId)
    broadcastState()
  })
  // 發送端加入時已複製一份到 userData，這裡指的是使用者當初選的原始檔，讓使用者自行刪除或搬走
  ipcMain.handle('sender:revealSource', (_e, itemId) => {
    const source = sender.library.sourcePath(itemId)
    if (!source || !fs.existsSync(source)) return { ok: false, path: source || '' }
    shell.showItemInFolder(source)
    return { ok: true, path: source }
  })
  ipcMain.handle('sender:move', (_e, itemId, delta) => {
    sender.library.move(itemId, delta)
    broadcastState()
  })
  ipcMain.handle('sender:setDuration', (_e, itemId, seconds) => {
    sender.library.setDuration(itemId, seconds)
    broadcastState()
  })
  ipcMain.handle('sender:restartServer', async () => {
    const result = await sender.restartServer()
    broadcastState()
    return result
  })

  player.registerIpc()
  player.setOnClosed(broadcastState)

  ipcMain.handle('player:start', async () => {
    if (config.load().mode !== 'receiver') return { ok: false, error: '目前不是接收端模式' }
    const result = await player.start(receiver.snapshot())
    broadcastState()
    return result
  })
  ipcMain.handle('player:stop', () => {
    const result = player.stop()
    broadcastState()
    return result
  })

  ipcMain.handle('receiver:test', () => receiver.testConnection())
  ipcMain.handle('receiver:sync', async (_e, options) => {
    const result = await receiver.syncNow(options)
    broadcastState()
    return result
  })

  const startCfg = config.load()
  if (startCfg.mode === 'sender') await sender.activate(broadcastState, broadcastAccess)
  if (startCfg.mode === 'receiver') {
    await receiver.activate(broadcastState)
    player.prepare()
    receiver.syncNow()
  }

  syncAutoStart(startCfg) // 登錄檔可能被使用者或別的工具動過，開機時以設定為準對齊一次

  createMainWindow()

  // 沒有 Tailscale 就傳不了素材，開程式時先講清楚，並讓使用者直接看安裝說明
  tailscaleGuide.checkOnStartup(mainWindow)

  // 開機自動進播放：不等同步跑完，先用手邊已下載的素材開播，
  // 新下載的檔案會經由 broadcastState 陸續補進輪播
  if (startCfg.mode === 'receiver' && startCfg.receiver.autoPlayOnBoot) {
    await player.start(receiver.snapshot())
    broadcastState()
  }
})

app.on('before-quit', async () => {
  player.stop()
  await sender.deactivate()
  await receiver.deactivate()
})

// 發送端擷取影片縮圖的離屏視窗收掉時也會觸發；主視窗還沒建好（啟動中）就不是使用者要關程式
app.on('window-all-closed', () => {
  if (mainWindowCreated) app.quit()
})

module.exports = { buildState, broadcastState }
