const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Library management
  openFolder:       () => ipcRenderer.invoke('dialog:openFolder'),
  getFolders:       () => ipcRenderer.invoke('library:getFolders'),
  removeFolder:     (p) => ipcRenderer.invoke('library:removeFolder', p),
  getWorkspaces:    () => ipcRenderer.invoke('library:getWorkspaces'),
  createWorkspace:  (name) => ipcRenderer.invoke('library:createWorkspace', name),
  switchWorkspace:  (id) => ipcRenderer.invoke('library:switchWorkspace', id),

  // File system
  scanFolder:     (p) => ipcRenderer.invoke('folder:scan', p),
  readFile:       (p) => ipcRenderer.invoke('file:read', p),
  saveFile:       (p, c) => ipcRenderer.invoke('file:save', p, c),
  saveFileAs:     (n, c) => ipcRenderer.invoke('file:saveAs', n, c),
  createFile:     (p) => ipcRenderer.invoke('file:create', p),
  deleteFile:     (p) => ipcRenderer.invoke('file:delete', p),

  // Shell
  showInFolder:   (p) => ipcRenderer.invoke('shell:showItemInFolder', p),

  // Settings
  getSettings:    () => ipcRenderer.invoke('settings:get'),
  setSettings:    (s) => ipcRenderer.invoke('settings:set', s),
  pickFolder:     () => ipcRenderer.invoke('settings:pickFolder'),

  // App info
  getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),

  // Terminal
  termRun:         (data) => ipcRenderer.send('terminal:run', data),
  termKill:        (id)   => ipcRenderer.send('terminal:kill', id),
  termResolvePath: (c, t) => ipcRenderer.invoke('terminal:resolvePath', c, t),
  termGetShell:    ()     => ipcRenderer.invoke('terminal:getShell'),
  onTermOut:  (cb) => ipcRenderer.on('terminal:out',  (_, d) => cb(d)),
  onTermErr:  (cb) => ipcRenderer.on('terminal:err',  (_, d) => cb(d)),
  onTermDone: (cb) => ipcRenderer.on('terminal:done', (_, d) => cb(d)),
  offTermAll: () => {
    ipcRenderer.removeAllListeners('terminal:out');
    ipcRenderer.removeAllListeners('terminal:err');
    ipcRenderer.removeAllListeners('terminal:done');
  },
});
