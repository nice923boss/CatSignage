const api = window.catsignage
const $ = (id) => document.getElementById(id)

let state = null

/* ---------- 共用 ---------- */

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isTailnetAddress(ip) {
  const parts = String(ip).trim().split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false
  const nums = parts.map(Number)
  if (nums.some((n) => n > 255)) return false
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[unit]
}

const RETENTION_UNITS = [1440, 60, 1] // 天、小時、分鐘，顯示時挑能整除的最大單位
const RETENTION_MAX_MINUTES = 3650 * 1440

function retentionDisplay(minutes) {
  const unit = RETENTION_UNITS.find((u) => minutes % u === 0) || 1
  return { value: minutes / unit, unit }
}

function describeMinutes(minutes) {
  const { value, unit } = retentionDisplay(minutes)
  return value + (unit === 1440 ? ' 天' : unit === 60 ? ' 小時' : ' 分鐘')
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* ---------- 導覽 ---------- */

function renderNav(mode) {
  for (const item of document.querySelectorAll('.nav-item')) {
    const only = item.dataset.mode
    item.classList.toggle('hidden', Boolean(only) && only !== mode)
  }
  // 切換模式後若停在已隱藏的分頁，退回設定頁
  const active = document.querySelector('.nav-item.active')
  if (!active || active.classList.contains('hidden')) showPage('settings')
}

function showPage(name) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.page === name)
  }
  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('active', page.id === 'page-' + name)
  }
}

/* ---------- 設定頁 ---------- */

// 選單內容由主行程的 TRANSITIONS 決定，避免介面與播放器各自維護一份清單
function renderTransitionOptions(transitions) {
  const select = $('transition')
  const signature = transitions.map((t) => t.id).join(',')
  if (select.dataset.signature === signature) return
  select.textContent = ''
  for (const t of transitions) {
    const option = document.createElement('option')
    option.value = t.id
    option.textContent = t.label
    select.appendChild(option)
  }
  select.dataset.signature = signature
}

function renderSettings() {
  const { mode, config, tailnet } = state
  renderTransitionOptions(state.transitions || [])

  $('mode-badge').textContent = mode === 'receiver' ? '接收端模式' : '發送端模式'

  const tailBadge = $('tailnet-badge')
  if (tailnet) {
    tailBadge.textContent = 'Tailscale ' + tailnet.ip
    tailBadge.className = 'badge badge-muted'
    $('info-tailnet').textContent = tailnet.ip + '（' + tailnet.iface + '）'
  } else {
    tailBadge.textContent = '未偵測到 Tailscale'
    tailBadge.className = 'badge badge-warn'
    $('info-tailnet').textContent = '未偵測到，請確認 Tailscale 已連線'
  }

  $('pick-sender').classList.toggle('selected', mode === 'sender')
  $('pick-receiver').classList.toggle('selected', mode === 'receiver')
  $('sender-settings').classList.toggle('hidden', mode !== 'sender')
  $('receiver-settings').classList.toggle('hidden', mode !== 'receiver')

  $('sender-port').value = config.sender.port
  $('default-seconds').value = config.sender.defaultImageSeconds
  $('transition').value = config.sender.defaultTransition
  $('serve-address').textContent = tailnet
    ? 'http://' + tailnet.ip + ':' + config.sender.port
    : '未偵測到 Tailscale 介面，服務無法啟動'

  $('sender-host').value = config.receiver.senderHost
  $('sender-port-input').value = config.receiver.senderPort

  const minutes = config.receiver.retentionMinutes
  const shown = retentionDisplay(minutes)
  $('retention-value').value = shown.value
  $('retention-unit').value = String(shown.unit)
  $('retention-value').max = Math.floor(RETENTION_MAX_MINUTES / shown.unit)
  $('retention-note').textContent = '已離開播放清單且超過 ' + describeMinutes(minutes) + '沒播過的檔案會自動清除'

  $('cache-limit').value = Math.round(config.receiver.maxCacheMB / 1024 * 100) / 100
  $('min-free').value = config.receiver.minFreeMB

  const wantsAutoStart = config.receiver.autoPlayOnBoot === true
  const autoStart = state.autoStart || { enabled: false }
  $('autoplay-boot').checked = wantsAutoStart
  // 啟動項可能被使用者從工作管理員或其他工具停用，這時要說實話，不要只顯示勾選框
  $('autoplay-note').textContent = wantsAutoStart === autoStart.enabled
    ? '登入 Windows 後自動啟動 CatSignage 並直接進入全螢幕播放'
    : wantsAutoStart
      ? '設定為開啟，但 Windows 的啟動項目目前不存在，取消勾選再勾一次可重新登記'
      : 'Windows 的啟動項目還在，取消勾選一次即可移除'

  $('info-profile').textContent = state.profile
  $('info-version').textContent = state.version
  $('info-userdata').textContent = state.userDataPath
}

/* ---------- 媒體庫頁 ---------- */

function durationCell(item) {
  const cell = el('td', 'col-dur')
  if (item.kind !== 'image') {
    cell.appendChild(el('span', 'muted', '整支播完'))
    return cell
  }
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.max = '600'
  input.className = 'dur-input'
  input.value = item.durationSec
  input.addEventListener('change', () => {
    api.sender.setDuration(item.id, clampInt(input.value, 1, 600, item.durationSec))
  })
  cell.appendChild(input)
  return cell
}

function actionCell(item, index, total) {
  const cell = el('td', 'col-act')
  const up = el('button', 'btn btn-mini', '上移')
  up.disabled = index === 0
  up.addEventListener('click', () => api.sender.move(item.id, -1))

  const down = el('button', 'btn btn-mini', '下移')
  down.disabled = index === total - 1
  down.addEventListener('click', () => api.sender.move(item.id, 1))

  const reveal = el('button', 'btn btn-mini', '原檔位置')
  reveal.title = item.sourcePath ? '在檔案總管中顯示原始檔：' + item.sourcePath : '沒有記錄原始檔位置'
  reveal.addEventListener('click', async () => {
    const res = await api.sender.revealSource(item.id)
    if (res.ok) return
    showMessage(res.path
      ? '原始檔已不在原位置（可能已移動或刪除）：' + res.path
      : '沒有記錄「' + item.displayName + '」的原始檔位置', true)
  })

  const remove = el('button', 'btn btn-mini btn-danger', '移除')
  remove.addEventListener('click', () => api.sender.remove(item.id))

  cell.append(up, down, reveal, remove)
  return cell
}

function thumbCell(item) {
  const cell = el('td', 'col-thumb')
  if (item.thumb) {
    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = item.thumb
    img.alt = item.displayName
    cell.appendChild(img)
  } else {
    // 縮圖還在產生，或系統認不得這個格式
    cell.appendChild(el('span', 'thumb thumb-none', item.kind === 'image' ? '圖片' : '影片'))
  }
  return cell
}

function renderRows(items) {
  const body = $('lib-rows')
  body.textContent = ''
  items.forEach((item, index) => {
    const row = document.createElement('tr')
    row.append(
      el('td', 'col-pos', String(item.position)),
      thumbCell(item),
      el('td', 'col-name', item.displayName),
      el('td', 'col-kind', item.kind === 'image' ? '圖片' : '影片'),
      el('td', 'col-size', formatBytes(item.size)),
      durationCell(item),
      actionCell(item, index, items.length)
    )
    body.appendChild(row)
  })
  $('lib-empty').classList.toggle('hidden', items.length > 0)
}

function renderServer(server, tailnet) {
  const out = $('server-status')
  if (server.running) {
    out.textContent = '供檔中 http://' + server.ip + ':' + server.port
    out.className = 'readout ok'
  } else if (!tailnet) {
    out.textContent = '未偵測到 Tailscale 連線，服務未啟動'
    out.className = 'readout warn'
  } else {
    out.textContent = server.error || '未啟動'
    out.className = 'readout warn'
  }
}

function renderAccess(entries) {
  const list = $('access-list')
  list.textContent = ''
  if (entries.length === 0) {
    list.appendChild(el('li', 'muted', '尚無存取記錄'))
    return
  }
  for (const entry of entries) {
    const time = new Date(entry.at).toLocaleTimeString('zh-Hant')
    const remote = String(entry.remote).replace('::ffff:', '')
    list.appendChild(el('li', null, time + '  ' + remote + '  ' + entry.pathname + '  ' + entry.status))
  }
}

function renderLibrary() {
  const snapshot = state.sender
  if (!snapshot) return
  const { items, stats, server, access } = snapshot
  $('lib-stats').textContent = stats.count + ' 個項目，共 ' + formatBytes(stats.bytes)
  $('list-version').textContent = stats.listVersion || '-'
  renderServer(server, state.tailnet)
  renderRows(items)
  renderAccess(access)
}

function showMessage(text, isError) {
  const node = $('lib-message')
  node.textContent = text
  node.classList.remove('hidden')
  node.classList.toggle('error', Boolean(isError))
}

function describeAddResult(result) {
  const parts = []
  if (result.added) parts.push('加入 ' + result.added + ' 個')
  if (result.duplicated) parts.push('略過重複 ' + result.duplicated + ' 個')
  if (result.rejected.length) {
    parts.push('無法加入 ' + result.rejected.length + ' 個：' +
      result.rejected.map((r) => r.name + '（' + r.reason + '）').join('、'))
  }
  return parts.length ? parts.join('，') : '沒有選擇任何檔案'
}

/* ---------- 播放頁 ---------- */

const SYNC_CLASS = {
  ready: 'readout ok',
  downloading: 'readout',
  checking: 'readout',
  offline: 'readout warn',
  error: 'readout warn',
  idle: 'readout',
}

function renderProgress(downloading) {
  const box = $('rx-progress')
  if (!downloading) {
    box.classList.add('hidden')
    return
  }
  const percent = downloading.total > 0 ? Math.min(100, (downloading.received / downloading.total) * 100) : 0
  box.classList.remove('hidden')
  $('rx-progress-bar').style.width = percent.toFixed(1) + '%'
  $('rx-progress-text').textContent =
    downloading.index + '/' + downloading.count + '  ' + downloading.name + '  ' +
    formatBytes(downloading.received) + ' / ' + formatBytes(downloading.total) +
    '（' + percent.toFixed(0) + '%）'
}

function renderReceiverRows(items) {
  const body = $('rx-rows')
  body.textContent = ''
  for (const item of items) {
    const row = document.createElement('tr')
    const status = el('td', 'col-kind', item.ready ? '就緒' : '待下載')
    status.classList.add(item.ready ? 'state-ok' : 'state-wait')
    row.append(
      el('td', 'col-pos', String(item.position)),
      el('td', 'col-name', item.displayName),
      el('td', 'col-kind', item.kind === 'image' ? '圖片' : '影片'),
      el('td', 'col-size', formatBytes(item.size)),
      el('td', 'col-dur', item.kind === 'image' ? item.durationSec + ' 秒' : '整支播完'),
      status
    )
    body.appendChild(row)
  }
  $('rx-empty').classList.toggle('hidden', items.length > 0)
}

function renderPlayback() {
  const snapshot = state.receiver
  const cfg = state.config.receiver
  $('rx-endpoint').textContent = cfg.senderHost
    ? 'http://' + cfg.senderHost + ':' + cfg.senderPort
    : '尚未設定發送端 IP，請到設定頁填寫'

  if (!snapshot) {
    $('rx-status').textContent = '接收端未啟用'
    $('rx-stats').textContent = '尚未同步'
    $('rx-retention').textContent = '接收端未啟用'
    renderProgress(null)
    renderReceiverRows([])
    return
  }

  const status = $('rx-status')
  status.textContent = snapshot.message
  status.className = SYNC_CLASS[snapshot.status] || 'readout'

  $('rx-stats').textContent = snapshot.totalCount === 0
    ? '尚未取得清單'
    : '就緒 ' + snapshot.readyCount + '/' + snapshot.totalCount +
      '，已下載 ' + formatBytes(snapshot.readyBytes) + ' / ' + formatBytes(snapshot.totalBytes)

  $('rx-version').textContent = snapshot.listVersion || '-'
  $('rx-lastsync').textContent = snapshot.lastSyncAt
    ? '上次同步 ' + new Date(snapshot.lastSyncAt).toLocaleTimeString('zh-Hant')
    : '尚未成功同步過'

  const recycled = snapshot.lastRetention
  const limitMB = cfg.maxCacheMB
  const usage = recycled && Number.isFinite(recycled.cacheBytes)
    ? '；目前快取 ' + formatBytes(recycled.cacheBytes) + (limitMB > 0 ? ' / 上限 ' + formatBytes(limitMB * 1024 * 1024) : '（不限容量）')
    : ''
  $('rx-retention').textContent = (!recycled || recycled.removed === 0
    ? '沒有需要回收的舊素材'
    : new Date(recycled.at).toLocaleString('zh-Hant') +
      ' 回收 ' + recycled.removed + ' 個，釋出 ' + formatBytes(recycled.bytes)) + usage

  renderProgress(snapshot.downloading)
  renderReceiverRows(snapshot.items)
}

// 上次按下播放到第一幀顯示的耗時，沒開播過就是 null
let lastFirstFrameMs = null

function renderPlayer() {
  const enabled = state.mode === 'receiver'
  const playing = Boolean(state.player && state.player.playing)
  const status = $('pb-status')

  if (!enabled) {
    status.textContent = '接收端未啟用'
    status.className = 'readout'
  } else if (playing) {
    status.textContent = '播放中，輪播 ' + state.player.itemCount + ' 支素材'
    status.className = 'readout ok'
  } else {
    status.textContent = '未播放'
    status.className = 'readout'
  }

  $('pb-start').disabled = !enabled || playing
  $('pb-stop').disabled = !enabled || !playing
  $('pb-elapsed').textContent = lastFirstFrameMs === null
    ? ''
    : '上次開播到第一幀 ' + (lastFirstFrameMs / 1000).toFixed(2) + ' 秒'
}

function showReceiverMessage(text, isError) {
  const node = $('rx-message')
  node.textContent = text
  node.classList.remove('hidden')
  node.classList.toggle('error', Boolean(isError))
}

/* ---------- 主流程 ---------- */

function render() {
  if (!state) return
  renderSettings()
  renderLibrary()
  renderPlayback()
  renderPlayer()
  renderNav(state.mode)
}

async function runSync(options) {
  const buttons = [$('rx-sync'), $('rx-resync')]
  buttons.forEach((b) => { b.disabled = true })
  try {
    const result = await api.receiver.sync(options)
    if (result.ok) {
      showReceiverMessage(result.downloaded > 0
        ? '同步完成，下載 ' + result.downloaded + ' 個素材'
        : '已是最新，沒有需要下載的素材', false)
    } else {
      showReceiverMessage((result.offline ? '離線：' : '同步未完成：') + result.error, true)
    }
  } finally {
    buttons.forEach((b) => { b.disabled = false })
  }
}

async function apply(patch) {
  state = await api.updateConfig(patch)
  render()
}

function bindNumber(id, section, key, min, max) {
  $(id).addEventListener('change', () => {
    const input = $(id)
    const current = state.config[section][key]
    const next = clampInt(input.value, min, max, current)
    apply({ [section]: { [key]: next } })
  })
}

function init() {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => showPage(item.dataset.page))
  }

  $('pick-sender').addEventListener('click', () => apply({ mode: 'sender' }))
  $('pick-receiver').addEventListener('click', () => apply({ mode: 'receiver' }))

  bindNumber('sender-port', 'sender', 'port', 1024, 65535)
  bindNumber('default-seconds', 'sender', 'defaultImageSeconds', 1, 600)
  bindNumber('sender-port-input', 'receiver', 'senderPort', 1024, 65535)

  $('transition').addEventListener('change', () => {
    apply({ sender: { defaultTransition: $('transition').value } })
  })

  $('sender-host').addEventListener('change', () => {
    const input = $('sender-host')
    const value = input.value.trim()
    // 允許留空（尚未設定），有填就必須是 tailnet 位址
    if (value !== '' && !isTailnetAddress(value)) {
      input.classList.add('invalid')
      return
    }
    input.classList.remove('invalid')
    apply({ receiver: { senderHost: value } })
  })

  // 數值與單位任一改動都重算分鐘數，換單位代表把同一個數字改用新單位解讀
  const applyRetention = () => {
    const unit = Number($('retention-unit').value) || 1440
    const value = clampInt($('retention-value').value, 1, Math.floor(RETENTION_MAX_MINUTES / unit), 30)
    apply({ receiver: { retentionMinutes: value * unit } })
  }
  $('retention-value').addEventListener('change', applyRetention)
  $('retention-unit').addEventListener('change', applyRetention)

  $('cache-limit').addEventListener('change', () => {
    const gb = Number($('cache-limit').value)
    const mb = Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024) : 0
    apply({ receiver: { maxCacheMB: Math.min(mb, 1024 * 1024 * 16) } })
  })

  bindNumber('min-free', 'receiver', 'minFreeMB', 0, 1024 * 1024)

  $('autoplay-boot').addEventListener('change', () => {
    apply({ receiver: { autoPlayOnBoot: $('autoplay-boot').checked } })
  })

  $('open-userdata').addEventListener('click', () => api.openUserData())

  $('add-files').addEventListener('click', async () => {
    const button = $('add-files')
    button.disabled = true
    button.textContent = '處理中'
    try {
      const result = await api.sender.addFiles()
      showMessage(describeAddResult(result), result.rejected.length > 0)
    } finally {
      button.disabled = false
      button.textContent = '加入素材'
    }
  })

  $('restart-server').addEventListener('click', async () => {
    const result = await api.sender.restartServer()
    showMessage(result.ok ? '服務已重新啟動' : result.error, !result.ok)
  })

  $('rx-test').addEventListener('click', async () => {
    const button = $('rx-test')
    button.disabled = true
    try {
      const result = await api.receiver.test()
      showReceiverMessage(result.ok
        ? '連線成功，發送端版本 ' + result.version + '，清單版本 ' + result.listVersion
        : '連線失敗：' + result.error, !result.ok)
    } finally {
      button.disabled = false
    }
  })

  $('rx-sync').addEventListener('click', () => runSync({}))
  $('rx-resync').addEventListener('click', () => runSync({ force: true }))

  $('pb-start').addEventListener('click', async () => {
    const button = $('pb-start')
    button.disabled = true
    // 開播是等第一幀真的畫出來才回來，這段期間按鈕保持停用
    const result = await api.player.start()
    if (!result.ok) {
      showReceiverMessage('無法開始播放：' + result.error, true)
      render()
      return
    }
    lastFirstFrameMs = result.firstFrameMs
    if (result.timedOut) {
      showReceiverMessage('播放視窗已開啟，但十秒內沒有畫面回報，請確認素材是否損毀', true)
    } else {
      showReceiverMessage(result.itemCount === 0
        ? '已開啟播放視窗，素材下載完成後會自動開始輪播'
        : '開始播放，共 ' + result.itemCount + ' 支素材', false)
    }
    render()
  })

  $('pb-stop').addEventListener('click', async () => {
    await api.player.stop()
    render()
  })

  api.onStateChanged((next) => {
    state = next
    render()
  })

  api.getState().then((next) => {
    state = next
    render()
  })

  // 存取記錄由主行程在接收端打進來時推送，只重畫記錄清單
  api.onAccess((entries) => {
    if (!state || !state.sender) return
    state = { ...state, sender: { ...state.sender, access: entries } }
    renderAccess(entries)
  })
}

init()
