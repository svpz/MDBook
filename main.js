const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'renderer', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());

// ── Library path helpers ─────────────────────────────────────────────────────
const LIBRARY_META_PATH = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_PATH     = path.join(app.getPath('userData'), 'settings.json');

function loadLibraryMeta() {
  let meta = { activeWorkspace: 'default', workspaces: [{ id: 'default', name: 'Default Workspace', folders: [] }] };
  try {
    if (fs.existsSync(LIBRARY_META_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LIBRARY_META_PATH, 'utf8'));
      if (parsed.folders && !parsed.workspaces) {
        // Migrate old format
        meta.workspaces[0].folders = parsed.folders;
      } else {
        meta = { ...meta, ...parsed };
      }
    }
  } catch (_) {}
  if (!meta.workspaces || meta.workspaces.length === 0) {
    meta.workspaces = [{ id: 'default', name: 'Default Workspace', folders: [] }];
    meta.activeWorkspace = 'default';
  }
  return meta;
}

function saveLibraryMeta(meta) {
  fs.writeFileSync(LIBRARY_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

// ── Settings helpers ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  defaultSaveFolder: '',   // empty = ask every time
  autoSave: false,
  autoSaveDelay: 2000,
  fontSize: 14,
  lineNumbers: false,
  wordWrap: true,
  scrollSync: true,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

// ── IPC: Open folder dialog ──────────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Add Folder to Library',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  const meta = loadLibraryMeta();
  const ws = meta.workspaces.find(w => w.id === meta.activeWorkspace);
  if (ws && !ws.folders.includes(folderPath)) {
    ws.folders.push(folderPath);
    saveLibraryMeta(meta);
  }
  return folderPath;
});

// ── IPC: Workspaces ──────────────────────────────────────────────────────────
ipcMain.handle('library:getWorkspaces', () => {
  const meta = loadLibraryMeta();
  return {
    activeWorkspace: meta.activeWorkspace,
    workspaces: meta.workspaces.map(w => ({ id: w.id, name: w.name }))
  };
});

ipcMain.handle('library:createWorkspace', (_, name) => {
  const meta = loadLibraryMeta();
  const id = 'ws_' + Date.now();
  meta.workspaces.push({ id, name, folders: [] });
  meta.activeWorkspace = id;
  saveLibraryMeta(meta);
  return {
    activeWorkspace: meta.activeWorkspace,
    workspaces: meta.workspaces.map(w => ({ id: w.id, name: w.name }))
  };
});

ipcMain.handle('library:switchWorkspace', (_, id) => {
  const meta = loadLibraryMeta();
  if (meta.workspaces.find(w => w.id === id)) {
    meta.activeWorkspace = id;
    saveLibraryMeta(meta);
  }
  return true;
});

// ── IPC: Get all library folders ─────────────────────────────────────────────
ipcMain.handle('library:getFolders', () => {
  const meta = loadLibraryMeta();
  const ws = meta.workspaces.find(w => w.id === meta.activeWorkspace) || meta.workspaces[0];
  return ws.folders.filter((f) => fs.existsSync(f));
});

// ── IPC: Remove folder from library ─────────────────────────────────────────
ipcMain.handle('library:removeFolder', (_, folderPath) => {
  const meta = loadLibraryMeta();
  const ws = meta.workspaces.find(w => w.id === meta.activeWorkspace);
  if (ws) {
    ws.folders = ws.folders.filter((f) => f !== folderPath);
    saveLibraryMeta(meta);
  }
  return true;
});

// ── IPC: Scan folder for .md files ───────────────────────────────────────────
ipcMain.handle('folder:scan', (_, folderPath) => {
  function scanDir(dir, depth = 0) {
    if (depth > 5) return [];
    let entries = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          const children = scanDir(fullPath, depth + 1);
          if (children.length > 0) {
            entries.push({ type: 'folder', name: item.name, path: fullPath, children });
          }
        } else if (item.name.endsWith('.md') || item.name.endsWith('.markdown')) {
          const stat = fs.statSync(fullPath);
          entries.push({
            type: 'file',
            name: item.name,
            path: fullPath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      }
    } catch (_) {}
    return entries;
  }
  return scanDir(folderPath);
});

// ── IPC: Read a markdown file ────────────────────────────────────────────────
ipcMain.handle('file:read', (_, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    return { content, modified: stat.mtime.toISOString(), size: stat.size };
  } catch (e) {
    return { error: e.message };
  }
});

// ── IPC: Save a markdown file ────────────────────────────────────────────────
ipcMain.handle('file:save', (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ── IPC: Save As (new file dialog) ───────────────────────────────────────────
ipcMain.handle('file:saveAs', async (_, defaultName, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    title: 'Save Markdown File',
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

// ── IPC: Create new file ──────────────────────────────────────────────────────
ipcMain.handle('file:create', async (_, folderPath) => {
  const settings = loadSettings();
  // Priority: explicit folderPath arg → defaultSaveFolder setting → first library folder → home
  const defaultDir = folderPath || settings.defaultSaveFolder || os.homedir();
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(defaultDir, 'untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    title: 'Create New Markdown File',
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, '# New Note\n\n', 'utf8');
  return result.filePath;
});

// ── IPC: Settings ────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (_, partial) => {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  saveSettings(merged);
  return merged;
});

// Pick a folder for the defaultSaveFolder setting
ipcMain.handle('settings:pickFolder', async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose Default Save Folder',
    defaultPath: settings.defaultSaveFolder || os.homedir(),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Return the userData directory path so the UI can display it
ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));

// ── IPC: Delete file ─────────────────────────────────────────────────────────
ipcMain.handle('file:delete', async (_, filePath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Delete File',
    message: `Delete "${path.basename(filePath)}"?`,
    detail: 'This action cannot be undone.',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    return false;
  }
});

// ── IPC: Rename file ─────────────────────────────────────────────────────────
ipcMain.handle('file:rename', async (_, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    // Ensure extension
    let targetName = newName;
    if (!targetName.toLowerCase().endsWith('.md') && !targetName.toLowerCase().endsWith('.markdown')) {
      targetName += ext || '.md';
    }
    const newPath = path.join(dir, targetName);
    if (fs.existsSync(newPath)) {
      throw new Error('File already exists');
    }
    fs.renameSync(oldPath, newPath);
    return { success: true, newPath };
  } catch (e) {
    return { error: e.message };
  }
});

// ── IPC: Open in OS file explorer ────────────────────────────────────────────
ipcMain.handle('shell:showItemInFolder', (_, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

// ── IPC: Export to PDF ────────────────────────────────────────────────────────
ipcMain.handle('app:exportPDF', async (_, title) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: title ? `${title}.pdf` : 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    title: 'Export to PDF',
  });
  if (result.canceled || !result.filePath) return null;

  const options = {
    marginsType: 0,
    pageSize: 'A4',
    printBackground: true,
    printSelectionOnly: false,
    landscape: false,
  };

  try {
    const data = await mainWindow.webContents.printToPDF(options);
    fs.writeFileSync(result.filePath, data);
    return result.filePath;
  } catch (e) {
    throw new Error('PDF export failed: ' + e.message);
  }
});

// ── IPC: Copy image to assets ────────────────────────────────────────────────
ipcMain.handle('file:copyImage', async (_, sourcePath, notePath) => {
  try {
    const noteDir = path.dirname(notePath);
    const assetsDir = path.join(noteDir, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    let targetName = base + ext;
    let targetPath = path.join(assetsDir, targetName);
    
    // Avoid overwrite
    let i = 1;
    while (fs.existsSync(targetPath)) {
      targetName = `${base}_${i++}${ext}`;
      targetPath = path.join(assetsDir, targetName);
    }

    fs.copyFileSync(sourcePath, targetPath);
    return { relPath: path.join('assets', targetName) };
  } catch (e) {
    return { error: e.message };
  }
});

// ── IPC: Terminal ─────────────────────────────────────────────────────────────
const activeProcs = new Map();

ipcMain.on('terminal:run', (_, { id, command, cwd }) => {
  if (activeProcs.has(id)) {
    try { activeProcs.get(id).kill(); } catch (_e) {}
    activeProcs.delete(id);
  }
  const isWin = process.platform === 'win32';
  const sh   = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const args = isWin
    ? ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-c', command];

  const proc = spawn(sh, args, {
    cwd: (cwd && fs.existsSync(cwd)) ? cwd : os.homedir(),
    env: process.env,
    windowsHide: true,
  });
  activeProcs.set(id, proc);
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:out', { id, text: d });
  });
  proc.stderr.on('data', (d) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:err', { id, text: d });
  });
  proc.on('exit', (code) => {
    activeProcs.delete(id);
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:done', { id, code: code ?? 0 });
  });
  proc.on('error', (err) => {
    activeProcs.delete(id);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:err', { id, text: err.message + '\n' });
      mainWindow.webContents.send('terminal:done', { id, code: 1 });
    }
  });
});

ipcMain.on('terminal:kill', (_, id) => {
  if (activeProcs.has(id)) {
    try { activeProcs.get(id).kill(); } catch (_e) {}
    activeProcs.delete(id);
  }
});

ipcMain.handle('terminal:resolvePath', (_, current, target) => {
  try { return path.resolve(current, target); } catch (_e) { return current; }
});

ipcMain.handle('terminal:getShell', () =>
  process.platform === 'win32' ? 'PowerShell' : (process.env.SHELL || 'bash')
);
