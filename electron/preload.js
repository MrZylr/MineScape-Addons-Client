const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('app:state'),
  blog: () => ipcRenderer.invoke('app:blog'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  selectAccount: username => ipcRenderer.invoke('accounts:select', username),
  prepare: () => ipcRenderer.invoke('prepare:start'),
  saveSettings: settings => ipcRenderer.invoke('mods:settings', settings),
  checkModVersion: (modId, offset) => ipcRenderer.invoke('mods:check-version', modId, offset),
  launch: () => ipcRenderer.invoke('launch:start'),
  openExternal: url => ipcRenderer.invoke('shell:open', url),
  onStatus: callback => ipcRenderer.on('status', (_event, value) => callback(value)),
  onProgress: callback => ipcRenderer.on('prepare-progress', (_event, value) => callback(value)),
  onAccounts: callback => ipcRenderer.on('accounts', (_event, value) => callback(value))
});
