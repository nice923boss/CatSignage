const { dialog, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { tailnetIPv4, simulatedAbsence } = require('./tailnet')

const GUIDE_NAME = 'Tailscale-安裝指引.html'

// 打包後說明檔放在 resources 底下，開發時直接讀專案的 docs
function guidePath() {
  const packed = path.join(process.resourcesPath || '', GUIDE_NAME)
  if (fs.existsSync(packed)) return packed
  return path.join(__dirname, '..', '..', '..', 'docs', GUIDE_NAME)
}

// 沒有 tailnet 位址時再看程式在不在，才分得出「沒安裝」與「裝了沒連上」
function exeInstalled() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']
  return roots.filter(Boolean).some((root) => fs.existsSync(path.join(root, 'Tailscale', 'tailscale.exe')))
}

function inspect() {
  const fake = simulatedAbsence()
  if (fake) return { ok: false, ip: '', reason: fake }

  const tailnet = tailnetIPv4()
  if (tailnet) return { ok: true, ip: tailnet.ip, reason: 'ready' }
  return { ok: false, ip: '', reason: exeInstalled() ? 'not-connected' : 'not-installed' }
}

// 啟動時檢查一次。沒有 tailnet 位址就跳提示，讓使用者直接打開安裝說明。
// 不 await 對話框，避免擋住開機自動播放。
function checkOnStartup(parentWindow) {
  const state = inspect()
  if (state.ok) return state

  const notInstalled = state.reason === 'not-installed'
  const options = {
    type: 'warning',
    title: 'CatSignage 需要 Tailscale',
    message: notInstalled ? '這台電腦還沒有安裝 Tailscale' : 'Tailscale 已安裝，但目前沒有連線位址',
    detail: notInstalled
      ? 'CatSignage 靠 Tailscale 讓辦公室電腦與門市電腦直接連線傳素材，沒有它就無法取得新素材。\n\n已經下載好的素材仍然可以繼續播放。'
      : '找不到 100 開頭的連線位址，通常是還沒登入或目前是中斷狀態。\n\n點工作列的 Tailscale 圖示登入或連線，再重新開啟 CatSignage。\n\n已經下載好的素材仍然可以繼續播放。',
    buttons: ['開啟安裝說明', '稍後再說'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }

  const shown = parentWindow && !parentWindow.isDestroyed()
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options)

  shown.then((res) => {
    if (res.response === 0) shell.openPath(guidePath())
  }).catch(() => { /* 使用者關掉對話框就算了 */ })

  return state
}

module.exports = { inspect, checkOnStartup, guidePath }
