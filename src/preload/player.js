const { contextBridge, ipcRenderer } = require('electron')

// 播放視窗只需要三件事：收清單、回報播了什麼、要求離開
contextBridge.exposeInMainWorld('catplayer', {
  onPlaylist: (callback) => {
    ipcRenderer.on('player:playlist', (_e, payload) => callback(payload))
  },
  reportPlayed: (hash) => ipcRenderer.send('player:played', hash),
  reportFirstFrame: () => ipcRenderer.send('player:first-frame'),
  exit: () => ipcRenderer.send('player:exit'),
})
