const os = require('node:os')
const { app } = require('electron')

// 驗收時要模擬「這台電腦沒有 Tailscale」，又不能真的關掉開發機的 Tailscale，所以留一個環境變數。
// 只在開發模式生效，打包後的正式版一律忽略，現場不會被殘留的環境變數誤導
function simulatedAbsence() {
  if (!app || app.isPackaged) return null
  const fake = process.env.CATSIGNAGE_FAKE_TAILSCALE
  return fake === 'not-installed' || fake === 'not-connected' ? fake : null
}

// Tailscale 位址範圍 100.64.0.0/10，即 100.64.x.x 到 100.127.x.x
function tailnetIPv4() {
  if (simulatedAbsence()) return null // 主視窗的位址標示與啟動提示看到的是同一個狀態
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [o1, o2] = a.address.split('.').map(Number)
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return { ip: a.address, iface }
    }
  }
  return null
}

function isTailnetAddress(ip) {
  const parts = String(ip).trim().split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false
  const [o1, o2, o3, o4] = parts.map(Number)
  if ([o1, o2, o3, o4].some((n) => n > 255)) return false
  return o1 === 100 && o2 >= 64 && o2 <= 127
}

module.exports = { tailnetIPv4, isTailnetAddress, simulatedAbsence }
