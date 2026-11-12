const { contextBridge, ipcRenderer } = require('electron')

// 白名單式暴露，renderer 拿不到 ipcRenderer 本身
contextBridge.exposeInMainWorld('catsignage', {
  getState: () => ipcRenderer.invoke('app:getState'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  sender: {
    addFiles: () => ipcRenderer.invoke('sender:addFiles'),
    remove: (itemId) => ipcRenderer.invoke('sender:remove', itemId),
    revealSource: (itemId) => ipcRenderer.invoke('sender:revealSource', itemId),
    move: (itemId, delta) => ipcRenderer.invoke('sender:move', itemId, delta),
    setDuration: (itemId, seconds) => ipcRenderer.invoke('sender:setDuration', itemId, seconds),
    restartServer: () => ipcRenderer.invoke('sender:restartServer'),
    preview: () => ipcRenderer.invoke('sender:preview'),
    previewStop: () => ipcRenderer.invoke('sender:previewStop'),
  },
  receiver: {
    test: () => ipcRenderer.invoke('receiver:test'),
    sync: (options) => ipcRenderer.invoke('receiver:sync', options),
  },
  player: {
    start: () => ipcRenderer.invoke('player:start'),
    stop: () => ipcRenderer.invoke('player:stop'),
  },
  onAccess: (callback) => {
    const handler = (_e, entries) => callback(entries)
    ipcRenderer.on('sender:access', handler)
    return () => ipcRenderer.removeListener('sender:access', handler)
  },
  onStateChanged: (callback) => {
    const handler = (_e, state) => callback(state)
    ipcRenderer.on('state:changed', handler)
    return () => ipcRenderer.removeListener('state:changed', handler)
  },
})
