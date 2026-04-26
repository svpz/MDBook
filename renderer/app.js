/* ── Folio App Logic ─────────────────────────────────────────── */
'use strict';

const API = window.electronAPI;

// ── State ─────────────────────────────────────────────────────
const state = {
  folders: [],         // [{ path, name, tree }]
  activeFile: null,    // { path, name, folderPath }
  unsaved: false,
  mode: 'split',       // 'split' | 'edit' | 'preview'
  searchQuery: '',
  settings: {},        // loaded from main process
  termOpen: false,
  termCwd: null,
  termHistory: [],
  termHistoryIdx: -1,
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  fileTree:      $('file-tree'),
  emptyState:    $('empty-state'),
  editorArea:    $('editor-area'),
  editor:        $('md-editor'),
  preview:       $('md-preview'),
  editorPanel:   $('editor-panel'),
  previewPanel:  $('preview-panel'),
  breadcrumb:    $('file-breadcrumb'),
  statusWords:   $('status-words'),
  statusChars:   $('status-chars'),
  statusMod:     $('status-modified'),
  statusSaved:   $('status-saved'),
  searchInput:   $('search-input'),
  modeLabel:     $('mode-label'),
  iconEdit:      $('icon-edit'),
  iconView:      $('icon-view'),
};

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // Load settings first so editor can respect them
  state.settings = await API.getSettings();
  applySettingsToEditor();

  await loadWorkspaces();
}

async function loadWorkspaces() {
  const wsData = await API.getWorkspaces();
  const select = $('workspace-select');
  select.innerHTML = '';
  wsData.workspaces.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    select.appendChild(opt);
  });
  select.value = wsData.activeWorkspace;
  await reloadFolders();
}

async function reloadFolders() {
  state.folders = [];
  const folders = await API.getFolders();
  for (const fp of folders) await addFolderToState(fp);
  renderTree();
  if (state.folders.length === 0) showEmpty();
  else hideEmpty();
}

$('workspace-select').addEventListener('change', async (e) => {
  await API.switchWorkspace(e.target.value);
  await reloadFolders();
});

function customPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = $('prompt-overlay');
    const modal = $('prompt-modal');
    const title = $('prompt-title');
    const input = $('prompt-input');
    const btnCancel = $('btn-prompt-cancel');
    const btnOk = $('btn-prompt-ok');

    title.textContent = message;
    input.value = defaultValue;
    
    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');
    input.focus();

    function close(value) {
      overlay.classList.add('hidden');
      modal.classList.add('hidden');
      cleanup();
      resolve(value);
    }

    function onOk() { close(input.value.trim()); }
    function onCancel() { close(null); }
    function onKey(e) {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    }

    function cleanup() {
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }

    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

$('btn-new-workspace').addEventListener('click', async () => {
  const name = await customPrompt('Enter workspace name:');
  if (name) {
    await API.createWorkspace(name);
    await loadWorkspaces();
  }
});

function applySettingsToEditor() {
  const s = state.settings;
  el.editor.style.fontSize = (s.fontSize || 14) + 'px';
  el.editor.style.whiteSpace = s.wordWrap !== false ? 'pre-wrap' : 'pre';
  el.editor.style.overflowWrap = s.wordWrap !== false ? 'break-word' : 'normal';

  // Apply theme
  const theme = s.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  let customStyle = $('custom-theme-style');
  if (!customStyle) {
    customStyle = document.createElement('style');
    customStyle.id = 'custom-theme-style';
    document.head.appendChild(customStyle);
  }
  if (theme === 'custom' && s.customCss) {
    customStyle.textContent = s.customCss;
  } else {
    customStyle.textContent = '';
  }
}

// ── Folder management ─────────────────────────────────────────
async function addFolderToState(folderPath) {
  const tree = await API.scanFolder(folderPath);
  const name = folderPath.split(/[\\/]/).pop();
  // avoid duplicates
  if (!state.folders.find((f) => f.path === folderPath)) {
    state.folders.push({ path: folderPath, name, tree });
  }
}

async function openFolderDialog() {
  const folderPath = await API.openFolder();
  if (!folderPath) return;
  await addFolderToState(folderPath);
  renderTree();
  hideEmpty();
  toast('Folder added to library', 'success');
}

async function removeFolder(folderPath) {
  await API.removeFolder(folderPath);
  state.folders = state.folders.filter((f) => f.path !== folderPath);
  if (state.activeFile && state.activeFile.folderPath === folderPath) {
    state.activeFile = null;
    showEmpty();
  }
  renderTree();
  if (state.folders.length === 0) showEmpty();
  toast('Folder removed', 'info');
}

async function refreshFolder(folderPath) {
  const idx = state.folders.findIndex((f) => f.path === folderPath);
  if (idx === -1) return;
  const tree = await API.scanFolder(folderPath);
  state.folders[idx].tree = tree;
  renderTree();
}

// ── Tree rendering ────────────────────────────────────────────
const collapsedSet = new Set(); // track collapsed folder paths

function countFiles(tree) {
  let n = 0;
  for (const item of tree) {
    if (item.type === 'file') n++;
    else if (item.type === 'folder') n += countFiles(item.children);
  }
  return n;
}

function matchesSearch(name) {
  if (!state.searchQuery) return true;
  return name.toLowerCase().includes(state.searchQuery.toLowerCase());
}

function fileTreeMatches(tree) {
  for (const item of tree) {
    if (item.type === 'file' && matchesSearch(item.name)) return true;
    if (item.type === 'folder' && fileTreeMatches(item.children)) return true;
  }
  return false;
}

function renderTree() {
  el.fileTree.innerHTML = '';
  const query = state.searchQuery;

  for (const folder of state.folders) {
    if (query && !fileTreeMatches(folder.tree)) continue;

    const folderEl = document.createElement('div');
    folderEl.className = 'tree-folder';

    const count = countFiles(folder.tree);
    const isCollapsed = collapsedSet.has(folder.path);

    const header = document.createElement('div');
    header.className = 'tree-folder-header' + (isCollapsed ? ' collapsed' : '');
    header.innerHTML = `
      <svg class="folder-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      <span class="folder-icon">📁</span>
      <span class="folder-name" title="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</span>
      <span class="folder-count">${count}</span>
      <button class="folder-remove" title="Remove from library" data-path="${escapeHtml(folder.path)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;

    // toggle collapse
    header.addEventListener('click', (e) => {
      if (e.target.closest('.folder-remove')) return;
      if (collapsedSet.has(folder.path)) collapsedSet.delete(folder.path);
      else collapsedSet.add(folder.path);
      header.classList.toggle('collapsed');
      children.classList.toggle('collapsed');
    });

    // remove folder
    header.querySelector('.folder-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFolder(folder.path);
    });

    const children = document.createElement('div');
    children.className = 'tree-children' + (isCollapsed ? ' collapsed' : '');
    renderChildren(children, folder.tree, folder.path, 1);

    // set maxHeight for transition
    requestAnimationFrame(() => {
      if (!isCollapsed) children.style.maxHeight = children.scrollHeight + 'px';
      else children.style.maxHeight = '0px';
    });

    header.addEventListener('click', () => {
      setTimeout(() => {
        if (!collapsedSet.has(folder.path)) children.style.maxHeight = children.scrollHeight + 'px';
        else children.style.maxHeight = '0px';
      }, 10);
    });

    folderEl.appendChild(header);
    folderEl.appendChild(children);
    el.fileTree.appendChild(folderEl);
  }

  if (el.fileTree.innerHTML === '' && query) {
    el.fileTree.innerHTML = '<div class="tree-empty">No results found</div>';
  } else if (el.fileTree.innerHTML === '' && state.folders.length === 0) {
    el.fileTree.innerHTML = '<div class="tree-empty">No folders added yet</div>';
  }
}

function renderChildren(container, tree, folderPath, depth) {
  const filtered = state.searchQuery
    ? tree.filter((item) => {
        if (item.type === 'file') return matchesSearch(item.name);
        return fileTreeMatches(item.children);
      })
    : tree;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No markdown files found';
    container.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    if (item.type === 'folder') {
      const isCollapsed = collapsedSet.has(item.path);
      const subHeader = document.createElement('div');
      subHeader.className = 'tree-subfolder-header' + (isCollapsed ? ' collapsed' : '');
      subHeader.style.paddingLeft = `${8 + depth * 16}px`;
      subHeader.innerHTML = `
        <svg class="folder-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        <span class="folder-icon" style="font-size:12px">📂</span>
        <span class="folder-name">${escapeHtml(item.name)}</span>`;

      const subChildren = document.createElement('div');
      subChildren.className = 'tree-children' + (isCollapsed ? ' collapsed' : '');
      renderChildren(subChildren, item.children, folderPath, depth + 1);

      requestAnimationFrame(() => {
        if (!isCollapsed) subChildren.style.maxHeight = subChildren.scrollHeight + 'px';
        else subChildren.style.maxHeight = '0px';
      });

      subHeader.addEventListener('click', () => {
        if (collapsedSet.has(item.path)) collapsedSet.delete(item.path);
        else collapsedSet.add(item.path);
        subHeader.classList.toggle('collapsed');
        subChildren.classList.toggle('collapsed');
        setTimeout(() => {
          if (!collapsedSet.has(item.path)) subChildren.style.maxHeight = subChildren.scrollHeight + 'px';
          else subChildren.style.maxHeight = '0px';
        }, 10);
      });

      container.appendChild(subHeader);
      container.appendChild(subChildren);
    } else {
      const fileEl = document.createElement('div');
      fileEl.className = 'tree-file' + (state.activeFile?.path === item.path ? ' active' : '');
      fileEl.style.paddingLeft = `${36 + (depth - 1) * 16}px`;
      fileEl.dataset.path = item.path;

      const nameNoExt = item.name.replace(/\.(md|markdown)$/i, '');
      fileEl.innerHTML = `
        <span class="file-icon">📄</span>
        <span class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(nameNoExt)}</span>
        <span class="file-ext">.md</span>`;
      fileEl.addEventListener('click', () => openFile(item.path, folderPath));
      container.appendChild(fileEl);
    }
  }
}

// ── File open / read ──────────────────────────────────────────
async function openFile(filePath, folderPath) {
  if (state.unsaved) {
    const confirmed = confirm('You have unsaved changes. Open new file anyway?');
    if (!confirmed) return;
  }

  const result = await API.readFile(filePath);
  if (result.error) { toast('Cannot read file: ' + result.error, 'error'); return; }

  state.activeFile = { path: filePath, folderPath };
  state.unsaved = false;

  el.editor.value = result.content;
  renderPreview(result.content);
  updateBreadcrumb(filePath);
  updateStatus(result.content, result.modified);
  el.statusSaved.classList.add('hidden');

  showEditorArea();
  highlightActiveFile(filePath);
}

function renderPreview(md) {
  if (typeof marked !== 'undefined') {
    el.preview.innerHTML = marked.parse(md || '');
  } else {
    el.preview.innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
  }
}

// ── Save ──────────────────────────────────────────────────────
async function saveFile() {
  if (!state.activeFile) return;
  const content = el.editor.value;
  const result = await API.saveFile(state.activeFile.path, content);
  if (result.error) { toast('Save failed: ' + result.error, 'error'); return; }
  state.unsaved = false;
  el.statusSaved.classList.remove('hidden');
  updateBreadcrumb(state.activeFile.path);
  setTimeout(() => el.statusSaved.classList.add('hidden'), 2500);
  toast('Saved', 'success');
  // Refresh folder tree (file may have changed size/date)
  if (state.activeFile.folderPath) refreshFolder(state.activeFile.folderPath);
}

async function newFile() {
  const folderPath = state.folders[0]?.path || null;
  const filePath = await API.createFile(folderPath);
  if (!filePath) return;
  // figure out which library folder this belongs to
  const folder = state.folders.find((f) => filePath.startsWith(f.path));
  if (folder) {
    await refreshFolder(folder.path);
    await openFile(filePath, folder.path);
  } else {
    // Add parent folder to library automatically
    const parent = filePath.split(/[\\/]/).slice(0, -1).join('\\');
    const newFolderPath = await API.openFolder();
    if (newFolderPath) { await addFolderToState(newFolderPath); renderTree(); }
  }
}

// ── Mode switching (split / edit / preview) ───────────────────
function toggleMode() {
  const modes = ['split', 'edit', 'preview'];
  const idx = modes.indexOf(state.mode);
  state.mode = modes[(idx + 1) % modes.length];
  applyMode();
}

function applyMode() {
  el.editorPanel.classList.remove('hidden', 'full-width');
  el.previewPanel.classList.remove('hidden');

  if (state.mode === 'split') {
    el.modeLabel.textContent = 'Preview';
    el.iconEdit.classList.remove('hidden');
    el.iconView.classList.add('hidden');
  } else if (state.mode === 'edit') {
    el.previewPanel.classList.add('hidden');
    el.editorPanel.classList.add('full-width');
    el.modeLabel.textContent = 'Split';
    el.iconEdit.classList.remove('hidden');
    el.iconView.classList.add('hidden');
  } else {
    el.editorPanel.classList.add('hidden');
    el.modeLabel.textContent = 'Edit';
    el.iconEdit.classList.add('hidden');
    el.iconView.classList.remove('hidden');
  }
}

// ── UI helpers ────────────────────────────────────────────────
function showEmpty() {
  el.emptyState.classList.remove('hidden');
  el.editorArea.classList.add('hidden');
}
function hideEmpty() {
  el.emptyState.classList.add('hidden');
}
function showEditorArea() {
  el.emptyState.classList.add('hidden');
  el.editorArea.classList.remove('hidden');
  applyMode();
}

function updateBreadcrumb(filePath) {
  const parts = filePath.split(/[\\/]/);
  const fileName = parts.pop();
  const nameNoExt = fileName.replace(/\.(md|markdown)$/i, '');
  // show up to 2 parent segments
  const parents = parts.slice(-2);
  el.breadcrumb.innerHTML = parents
    .map((p) => `<span class="crumb">${escapeHtml(p)}</span><span class="crumb-sep">/</span>`)
    .join('')
    + `<span class="crumb crumb-name${state.unsaved ? ' unsaved' : ''}">${escapeHtml(nameNoExt)}</span>`;
}

function updateStatus(content, modified) {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const chars = content.length;
  el.statusWords.textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
  el.statusChars.textContent = `${chars.toLocaleString()} chars`;
  if (modified) {
    const d = new Date(modified);
    el.statusMod.textContent = `Last saved ${d.toLocaleString()}`;
  }
}

function highlightActiveFile(filePath) {
  document.querySelectorAll('.tree-file').forEach((f) => {
    f.classList.toggle('active', f.dataset.path === filePath);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Toast ─────────────────────────────────────────────────────
function toast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;
  $('toast-container').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove());
  }, 3000);
}

// ── Event listeners ───────────────────────────────────────────

// Window controls
$('btn-minimize').addEventListener('click', () => API.minimize());
$('btn-maximize').addEventListener('click', () => API.maximize());
$('btn-close').addEventListener('click', () => API.close());

// Sidebar
$('btn-add-folder').addEventListener('click', openFolderDialog);
$('btn-empty-add').addEventListener('click', openFolderDialog);
$('btn-new-file').addEventListener('click', newFile);

// Editor actions
$('btn-toggle-mode').addEventListener('click', toggleMode);
$('btn-save').addEventListener('click', saveFile);
$('btn-show-in-folder').addEventListener('click', () => {
  if (state.activeFile) API.showInFolder(state.activeFile.path);
});
$('btn-delete-file').addEventListener('click', async () => {
  if (!state.activeFile) return;
  const deleted = await API.deleteFile(state.activeFile.path);
  if (deleted) {
    const fp = state.activeFile.folderPath;
    state.activeFile = null;
    state.unsaved = false;
    if (fp) await refreshFolder(fp);
    showEmpty();
    toast('File deleted', 'info');
  }
});

// Editor input — live preview + status + auto-save
let previewTimer;
let autoSaveTimer;
el.editor.addEventListener('input', () => {
  state.unsaved = true;
  updateBreadcrumb(state.activeFile?.path || '');
  updateStatus(el.editor.value, null);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderPreview(el.editor.value), 150);

  // Auto-save
  if (state.settings.autoSave && state.activeFile) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(saveFile, state.settings.autoSaveDelay || 2000);
  }
});

// Search
el.searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderTree();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    toggleMode();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
  if (e.key === 'Escape') {
    closeSettings();
  }
});

// Sidebar resize
const resizer = $('sidebar-resizer');
const sidebar = $('sidebar');
let isResizing = false, startX, startW;

resizer.addEventListener('mousedown', (e) => {
  isResizing = true;
  startX = e.clientX;
  startW = sidebar.offsetWidth;
  resizer.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const w = Math.min(500, Math.max(200, startW + e.clientX - startX));
  sidebar.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// ── Configure marked ──────────────────────────────────────────
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: function(code, lang) {
      if (typeof hljs !== 'undefined') {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      }
      return code;
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────
init();

// ── Settings gear button ─────────────────────────────────────────────
$('btn-settings').addEventListener('click', openSettings);

// ── Settings modal logic ─────────────────────────────────────────────
const settingsOverlay = $('settings-overlay');
const settingsModal   = $('settings-modal');

let pendingSettings = {}; // holds in-progress edits

async function openSettings() {
  // Load fresh settings from disk
  state.settings = await API.getSettings();
  pendingSettings = { ...state.settings };

  // Populate form fields
  $('setting-theme').value          = pendingSettings.theme || 'dark';
  $('setting-custom-css').value     = pendingSettings.customCss || '';
  updateThemeDisplay();
  $('setting-fontsize').value       = pendingSettings.fontSize ?? 14;
  $('setting-wordwrap').checked     = pendingSettings.wordWrap !== false;
  $('setting-autosave').checked     = !!pendingSettings.autoSave;
  $('setting-autosave-delay').value = pendingSettings.autoSaveDelay ?? 2000;
  updateAutoSaveDelayRow();
  updateFolderDisplay(pendingSettings.defaultSaveFolder || '');

  // Show userData path
  const udp = await API.getUserDataPath();
  const udEl = $('userData-path-display');
  udEl.textContent = udp;
  udEl.classList.add('set');

  // Show modal
  settingsOverlay.classList.remove('hidden');
  settingsModal.classList.remove('hidden');
  settingsModal.classList.remove('closing');
}

function closeSettings() {
  if (settingsModal.classList.contains('hidden')) return;
  settingsModal.classList.add('closing');
  settingsModal.addEventListener('animationend', () => {
    settingsModal.classList.add('hidden');
    settingsOverlay.classList.add('hidden');
    settingsModal.classList.remove('closing');
  }, { once: true });
}

function updateFolderDisplay(folderPath) {
  const textEl = $('default-folder-text');
  const box    = $('default-folder-display');
  if (folderPath) {
    textEl.textContent = folderPath;
    box.classList.add('set');
  } else {
    textEl.textContent = 'Not set — will prompt each time';
    box.classList.remove('set');
  }
}

function updateAutoSaveDelayRow() {
  const row = $('row-autosave-delay');
  if ($('setting-autosave').checked) row.classList.remove('dimmed');
  else row.classList.add('dimmed');
}

function updateThemeDisplay() {
  if ($('setting-theme').value === 'custom') {
    $('row-custom-css').classList.remove('hidden');
  } else {
    $('row-custom-css').classList.add('hidden');
  }
}
$('setting-theme').addEventListener('change', updateThemeDisplay);

// Close via overlay click or X button
settingsOverlay.addEventListener('click', closeSettings);
$('btn-settings-close').addEventListener('click', closeSettings);

// Browse for default save folder
$('btn-pick-folder').addEventListener('click', async () => {
  const picked = await API.pickFolder();
  if (picked) {
    pendingSettings.defaultSaveFolder = picked;
    updateFolderDisplay(picked);
  }
});

// Clear default save folder
$('btn-clear-folder').addEventListener('click', () => {
  pendingSettings.defaultSaveFolder = '';
  updateFolderDisplay('');
});

// Auto-save toggle dims the delay row
$('setting-autosave').addEventListener('change', updateAutoSaveDelayRow);

// Show userData folder in Explorer
$('btn-open-userdata').addEventListener('click', async () => {
  const udp = await API.getUserDataPath();
  API.showInFolder(udp);
});

// Save settings
$('btn-settings-save').addEventListener('click', async () => {
  // Read form values into pendingSettings
  pendingSettings.theme          = $('setting-theme').value;
  pendingSettings.customCss      = $('setting-custom-css').value;
  pendingSettings.fontSize       = parseInt($('setting-fontsize').value, 10) || 14;
  pendingSettings.wordWrap       = $('setting-wordwrap').checked;
  pendingSettings.autoSave       = $('setting-autosave').checked;
  pendingSettings.autoSaveDelay  = parseInt($('setting-autosave-delay').value, 10) || 2000;
  // defaultSaveFolder already updated by Browse/Clear buttons

  state.settings = await API.setSettings(pendingSettings);
  applySettingsToEditor();

  // Flash save status
  const statusEl = $('settings-save-status');
  statusEl.textContent = '✓ Settings saved';
  statusEl.classList.add('visible');
  setTimeout(() => statusEl.classList.remove('visible'), 2500);

  toast('Settings saved', 'success');
});

// Sidebar toggle sections
document.querySelectorAll('.sidebar-section-header').forEach((el) => {
  el.addEventListener('click', (e) => {
    // ignore if clicked on add button
    if (e.target.closest('#btn-add-folder')) return;
    const body = $(el.dataset.target);
    if (!body) return;
    const isCollapsed = el.classList.contains('collapsed');
    
    if (isCollapsed) {
      el.classList.remove('collapsed');
      body.classList.remove('collapsed');
      body.style.maxHeight = body.scrollHeight + 'px';
      setTimeout(() => body.style.maxHeight = 'none', 250);
    } else {
      body.style.maxHeight = body.scrollHeight + 'px';
      el.classList.add('collapsed');
      body.classList.add('collapsed');
      requestAnimationFrame(() => body.style.maxHeight = '0px');
    }
  });
});

// ── Terminal Logic ──────────────────────────────────────────────────
const termPanel = $('terminal-panel');
const termResizer = $('terminal-resizer');
const termOut = $('terminal-output');
const termInput = $('terminal-input');
const btnTermToggle = $('btn-terminal-toggle');

async function toggleTerminal(force) {
  if (typeof force === 'boolean') state.termOpen = force;
  else state.termOpen = !state.termOpen;

  if (state.termOpen) {
    if (!state.termCwd) {
      state.termCwd = state.activeFile ? state.activeFile.folderPath : (state.folders[0]?.path || null);
    }
    termPanel.classList.remove('hidden');
    termResizer.classList.remove('hidden');
    btnTermToggle.classList.add('active');
    $('terminal-cwd-label').textContent = state.termCwd || 'Terminal';
    
    // Write welcome message if empty
    if (termOut.innerHTML === '') {
      const shellName = await API.termGetShell();
      appendTerm(`MDBook Terminal (${shellName})`, 'sys');
      if (state.termCwd) appendTerm(`Working directory: ${state.termCwd}`, 'sys');
    }
    
    termInput.focus();
  } else {
    termPanel.classList.add('hidden');
    termResizer.classList.add('hidden');
    btnTermToggle.classList.remove('active');
  }
}

function appendTerm(text, type = 'out') {
  if (!text) return;
  const d = document.createElement('div');
  d.className = `term-line term-${type}`;
  d.textContent = text;
  termOut.appendChild(d);
  termOut.scrollTop = termOut.scrollHeight;
}

$('btn-terminal-toggle').addEventListener('click', toggleTerminal);
$('btn-terminal-close').addEventListener('click', () => toggleTerminal(false));
$('btn-terminal-clear').addEventListener('click', () => { termOut.innerHTML = ''; });

// Run command
termInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = termInput.value.trim();
    if (!cmd) return;
    
    // Add to history
    state.termHistory.push(cmd);
    state.termHistoryIdx = state.termHistory.length;
    
    // Check built-in commands
    if (cmd === 'clear') { termOut.innerHTML = ''; termInput.value = ''; return; }
    if (cmd.startsWith('cd ')) {
      const target = cmd.slice(3).trim();
      const resolved = await API.termResolvePath(state.termCwd || '', target);
      state.termCwd = resolved;
      $('terminal-cwd-label').textContent = state.termCwd;
      appendTerm(`$ ${cmd}`, 'cmd');
      termInput.value = '';
      return;
    }
    
    appendTerm(`$ ${cmd}`, 'cmd');
    termInput.value = '';
    
    API.termRun({ id: 'main', command: cmd, cwd: state.termCwd });
  } else if (e.key === 'ArrowUp') {
    if (state.termHistoryIdx > 0) {
      state.termHistoryIdx--;
      termInput.value = state.termHistory[state.termHistoryIdx];
    }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (state.termHistoryIdx < state.termHistory.length - 1) {
      state.termHistoryIdx++;
      termInput.value = state.termHistory[state.termHistoryIdx];
    } else {
      state.termHistoryIdx = state.termHistory.length;
      termInput.value = '';
    }
    e.preventDefault();
  }
});

// IPC events for terminal
API.onTermOut((d) => appendTerm(d.text, 'out'));
API.onTermErr((d) => appendTerm(d.text, 'err'));
API.onTermDone((d) => {
  if (d.code !== 0) appendTerm(`Process exited with code ${d.code}`, 'sys');
});

// Terminal resize
let isTermResizing = false, termStartH, termStartY;
termResizer.addEventListener('mousedown', (e) => {
  isTermResizing = true;
  termStartY = e.clientY;
  termStartH = termPanel.offsetHeight;
  termResizer.classList.add('dragging');
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!isTermResizing) return;
  const h = Math.min(window.innerHeight - 100, Math.max(100, termStartH - (e.clientY - termStartY)));
  termPanel.style.height = h + 'px';
});
document.addEventListener('mouseup', () => {
  if (isTermResizing) {
    isTermResizing = false;
    termResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// Hook ctrl+` to toggle
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '`') {
    e.preventDefault();
    toggleTerminal();
  }
});

// Auto-update terminal CWD when opening files
const _openFile = openFile;
openFile = async function(fp, folderPath) {
  await _openFile(fp, folderPath);
  if (folderPath && state.termHistory.length === 0) {
    state.termCwd = folderPath;
    if (state.termOpen) $('terminal-cwd-label').textContent = folderPath;
  }
};
