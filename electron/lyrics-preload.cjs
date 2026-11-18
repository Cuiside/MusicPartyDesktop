'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('desktopLyrics', {
  onState: (callback) => ipcRenderer.on('mp:lyrics:state', (_event, state) => callback(state)),
  onSpectrum: (callback) => ipcRenderer.on('mp:lyrics:spectrum', (_event, bins) => callback(bins)),
  onLike: (callback) => ipcRenderer.on('mp:lyrics:like-event', (_event, data) => callback(data)),
  command: (action) => ipcRenderer.send('mp:lyrics:command', action),
  resizeStart: (x, y) => ipcRenderer.send('mp:lyrics:resize-start', { x, y }),
  resize: (x, y) => ipcRenderer.send('mp:lyrics:resize', { x, y }),
  resizeEnd: () => ipcRenderer.send('mp:lyrics:resize-end'),
  close: () => ipcRenderer.send('mp:lyrics:close')
})
