const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ollamaModels: (url) => ipcRenderer.invoke('ollama:models', url),
  checkClaudeCode: (cmdPath) => ipcRenderer.invoke('claudecode:check', cmdPath),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  newSessionId: () => ipcRenderer.invoke('sessions:newId'),

  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  onChunk: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('chat:chunk', fn);
    return () => ipcRenderer.removeListener('chat:chunk', fn);
  },
});
