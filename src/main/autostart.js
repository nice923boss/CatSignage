const { app } = require('electron')
const { execFileSync } = require('node:child_process')

// 開機自動啟動寫在使用者自己的 HKCU\...\Run，不需要系統管理員權限，
// 由 Electron 的 setLoginItemSettings 代勞，這裡只負責組出「每個 profile 各自一筆」的參數。

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function itemName(profile) {
  return profile === 'default' ? 'CatSignage' : 'CatSignage-' + profile
}

// 開發環境的執行檔是 electron.exe，得再告訴它專案在哪；打包後執行檔自己就是程式。
// 參數不自己加引號：Electron 寫登錄檔時已經會替含空白的參數包引號，自己再包會變成雙重引號。
function launchArgs(profile) {
  const args = []
  if (!app.isPackaged) args.push(app.getAppPath())
  if (profile !== 'default') args.push('--profile=' + profile)
  return args
}

function options(profile) {
  return { name: itemName(profile), path: process.execPath, args: launchArgs(profile) }
}

// 狀態一律以登錄檔為準。Electron 的 getLoginItemSettings 在 Windows 上讀不回自己剛寫進去的項目
// （launchItems 恆為空、openAtLogin 恆為 false，四種參數組合實測皆同），
// 拿它當狀態來源會讓設定頁永遠顯示未啟用。寫入與移除則實測可靠，繼續交給 setLoginItemSettings。
function registered(profile) {
  try {
    execFileSync('reg', ['query', RUN_KEY, '/v', itemName(profile)], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false // 值不存在時 reg query 回非零
  }
}

// 查登錄檔要開子行程，而狀態每次廣播都會用到，所以只在第一次、寫入後或明確要求時重查
let cache = null

function status(profile, refresh = false) {
  if (cache === null || refresh) cache = registered(profile)
  return {
    enabled: cache,
    name: itemName(profile),
    executable: process.execPath,
    args: launchArgs(profile),
  }
}

function apply(profile, enabled) {
  app.setLoginItemSettings({ ...options(profile), openAtLogin: enabled === true })
  return status(profile, true)
}

module.exports = { apply, status, itemName }
