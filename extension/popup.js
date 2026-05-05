'use strict';

const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;
const EXPORT_FORMAT = 'tab-hub-backup';
const EXPORT_FORMAT_VERSION = 1;
const THEME_OPTIONS = ['system', 'light', 'dark'];

let pendingImportMode = 'merge';

function nowIso() {
  return new Date().toISOString();
}

function normalizeStashRootName(name) {
  const normalized = String(name || '').trim();
  return normalized && normalized !== ['Tab', 'Tree'].join(' ') ? normalized : 'Tab Stash';
}

function createScopedId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeThemePreference(theme) {
  return THEME_OPTIONS.includes(theme) ? theme : 'system';
}

function resolveThemePreference(theme) {
  const normalized = normalizeThemePreference(theme);
  if (normalized !== 'system') return normalized;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemePreference(theme) {
  const normalized = normalizeThemePreference(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.dataset.resolvedTheme = resolveThemePreference(normalized);
}

function createDefaultTabTree(createdAt = nowIso()) {
  return {
    schemaVersion: 2,
    maxDepth: 2,
    rootId: 'root',
    nodes: {
      root: {
        id: 'root',
        type: 'folder',
        name: 'Tab Stash',
        children: [],
        expanded: true,
        createdAt,
        updatedAt: createdAt,
      },
    },
  };
}

function createDefaultStore(legacy = {}) {
  const createdAt = nowIso();
  return {
    schemaVersion: TAB_OUT_STORE_VERSION,
    appVersion: chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.0.0',
    features: {
      tabTree: { enabled: true },
    },
    settings: {
      theme: 'system',
    },
    data: {
      dashboard: {
        favorites: Array.isArray(legacy.favorites) ? legacy.favorites : [],
        deferred: Array.isArray(legacy.deferred) ? legacy.deferred : [],
      },
      tabTree: createDefaultTabTree(createdAt),
    },
    meta: {
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function normalizeTabTree(raw) {
  const fallback = createDefaultTabTree();
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') return fallback;

  const nodes = {
    root: {
      ...fallback.nodes.root,
      ...(raw.nodes.root && raw.nodes.root.type === 'folder' ? raw.nodes.root : {}),
      id: 'root',
      type: 'folder',
      expanded: true,
    },
  };

  const rootChildren = Array.isArray(nodes.root.children) ? nodes.root.children : [];
  nodes.root.children = [];
  nodes.root.name = normalizeStashRootName(nodes.root.name);

  for (const childId of rootChildren) {
    const folder = raw.nodes[childId];
    if (!folder || folder.type !== 'folder') continue;
    nodes[childId] = {
      id: childId,
      type: 'folder',
      name: String(folder.name || 'Untitled folder'),
      children: Array.isArray(folder.children) ? folder.children.filter(id => {
        const node = raw.nodes[id];
        return node && node.type === 'tab';
      }) : [],
      expanded: typeof folder.expanded === 'boolean' ? folder.expanded : true,
      createdAt: folder.createdAt || nowIso(),
      updatedAt: folder.updatedAt || folder.createdAt || nowIso(),
    };
    nodes.root.children.push(childId);
    for (const tabId of nodes[childId].children) {
      const tab = raw.nodes[tabId];
      nodes[tabId] = {
        id: tabId,
        type: 'tab',
        name: String(tab.name || tab.url || 'Untitled tab'),
        url: String(tab.url || ''),
        createdAt: tab.createdAt || nowIso(),
        updatedAt: tab.updatedAt || tab.createdAt || nowIso(),
      };
    }
  }

  return {
    schemaVersion: 2,
    maxDepth: 2,
    rootId: 'root',
    nodes,
  };
}

function normalizeStore(raw, legacy = {}) {
  const fallback = createDefaultStore(legacy);
  if (!raw || typeof raw !== 'object') return fallback;

  const store = {
    ...fallback,
    ...raw,
    features: {
      ...fallback.features,
      ...(raw.features && typeof raw.features === 'object' ? raw.features : {}),
    },
    settings: {
      ...fallback.settings,
      ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}),
    },
    data: {
      ...fallback.data,
      ...(raw.data && typeof raw.data === 'object' ? raw.data : {}),
    },
    meta: {
      ...fallback.meta,
      ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}),
    },
  };

  if (!store.features.tabTree || typeof store.features.tabTree !== 'object') {
    store.features.tabTree = { enabled: true };
  }
  if (typeof store.features.tabTree.enabled !== 'boolean') {
    store.features.tabTree.enabled = true;
  }
  store.settings.theme = normalizeThemePreference(store.settings.theme);

  const dashboard = store.data.dashboard && typeof store.data.dashboard === 'object' ? store.data.dashboard : {};
  store.data.dashboard = {
    favorites: Array.isArray(dashboard.favorites) ? dashboard.favorites : fallback.data.dashboard.favorites,
    deferred: Array.isArray(dashboard.deferred) ? dashboard.deferred : fallback.data.dashboard.deferred,
  };
  store.data.tabTree = normalizeTabTree(store.data.tabTree);
  store.schemaVersion = TAB_OUT_STORE_VERSION;
  return store;
}

async function getStore() {
  const data = await chrome.storage.local.get([TAB_OUT_STORE_KEY, 'favorites', 'deferred']);
  const store = normalizeStore(data[TAB_OUT_STORE_KEY], {
    favorites: data.favorites,
    deferred: data.deferred,
  });
  if (!data[TAB_OUT_STORE_KEY]) await saveStore(store);
  return store;
}

async function saveStore(store) {
  const next = normalizeStore(store);
  next.meta.updatedAt = nowIso();
  await chrome.storage.local.set({ [TAB_OUT_STORE_KEY]: next });
  return next;
}

function extractImportedStore(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Choose a valid Tab Hub backup file');
  }

  if (payload.format === EXPORT_FORMAT) {
    if (!payload.data || typeof payload.data !== 'object') {
      throw new Error('This backup file is missing Tab Hub data');
    }
    return payload.data;
  }

  if (payload.tabOutStore && typeof payload.tabOutStore === 'object') {
    return payload.tabOutStore;
  }

  if (payload.data && typeof payload.data === 'object' && (payload.features || payload.schemaVersion)) {
    return payload;
  }

  throw new Error('Choose a valid Tab Hub backup file');
}

function countStoreData(store) {
  const normalized = normalizeStore(store);
  const dashboard = normalized.data.dashboard || {};
  const tree = normalized.data.tabTree || createDefaultTabTree();
  const folders = tree.nodes.root.children.filter(id => tree.nodes[id] && tree.nodes[id].type === 'folder');
  const treeTabs = folders.reduce((count, folderId) => {
    const folder = tree.nodes[folderId];
    return count + folder.children.filter(childId => tree.nodes[childId] && tree.nodes[childId].type === 'tab').length;
  }, 0);

  return {
    favorites: dashboard.favorites.length,
    savedTabs: dashboard.deferred.filter(item => item && !item.dismissed).length,
    folders: folders.length,
    treeTabs,
  };
}

function normalizeImportUrlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try { return new URL(raw).toString(); }
  catch { return raw; }
}

function normalizeNameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function createUniqueId(prefix, existingIds, preferredId) {
  if (preferredId && !existingIds.has(preferredId)) {
    existingIds.add(preferredId);
    return preferredId;
  }

  let id = createScopedId(prefix);
  while (existingIds.has(id)) id = createScopedId(prefix);
  existingIds.add(id);
  return id;
}

function createUniqueTreeNodeId(nodes, preferredId) {
  if (preferredId && preferredId !== 'root' && !nodes[preferredId]) return preferredId;
  let id = createScopedId('node');
  while (nodes[id]) id = createScopedId('node');
  return id;
}

function mergeFavorites(targetDashboard, importedDashboard, stats) {
  const target = Array.isArray(targetDashboard.favorites)
    ? targetDashboard.favorites.filter(item => item && typeof item.url === 'string')
    : [];
  const imported = Array.isArray(importedDashboard.favorites) ? importedDashboard.favorites : [];
  const existingIds = new Set(target.map(item => item.id).filter(Boolean));
  const existingUrls = new Set(target.map(item => normalizeImportUrlKey(item.url)).filter(Boolean));

  for (const item of imported) {
    if (!item || typeof item.url !== 'string') continue;
    const urlKey = normalizeImportUrlKey(item.url);
    if (!urlKey || existingUrls.has(urlKey)) continue;

    target.push({
      ...item,
      id: createUniqueId('fav', existingIds, item.id),
      url: String(item.url),
      createdAt: item.createdAt || nowIso(),
    });
    existingUrls.add(urlKey);
    stats.favoritesAdded += 1;
  }

  targetDashboard.favorites = target;
}

function mergeSavedTabs(targetDashboard, importedDashboard, stats) {
  const target = Array.isArray(targetDashboard.deferred)
    ? targetDashboard.deferred.filter(item => item && typeof item.url === 'string')
    : [];
  const imported = Array.isArray(importedDashboard.deferred) ? importedDashboard.deferred : [];
  const existingIds = new Set(target.map(item => item.id).filter(Boolean));
  const existingUrls = new Set(target.map(item => normalizeImportUrlKey(item.url)).filter(Boolean));

  for (const item of imported) {
    if (!item || typeof item.url !== 'string' || item.dismissed) continue;
    const urlKey = normalizeImportUrlKey(item.url);
    if (!urlKey || existingUrls.has(urlKey)) continue;

    target.push({
      ...item,
      id: createUniqueId('saved', existingIds, item.id),
      url: String(item.url),
      title: item.title || item.url,
      savedAt: item.savedAt || nowIso(),
      completed: !!item.completed,
      dismissed: false,
    });
    existingUrls.add(urlKey);
    stats.savedTabsAdded += 1;
  }

  targetDashboard.deferred = target;
}

function upsertImportedTreeTab(tree, folder, importedTab, stats) {
  if (!importedTab || typeof importedTab.url !== 'string') return;
  const urlKey = normalizeImportUrlKey(importedTab.url);
  if (!urlKey) return;

  const sameIds = folder.children.filter(childId => {
    const node = tree.nodes[childId];
    return node && node.type === 'tab' && normalizeImportUrlKey(node.url) === urlKey;
  });

  const timestamp = importedTab.updatedAt || nowIso();
  const name = String(importedTab.name || importedTab.url || 'Untitled tab');

  if (sameIds.length > 0) {
    const keepId = sameIds[sameIds.length - 1];
    const existing = tree.nodes[keepId];
    existing.name = name;
    existing.url = String(importedTab.url);
    existing.updatedAt = timestamp;
    folder.children = folder.children.filter(childId => {
      if (childId === keepId) return false;
      if (sameIds.includes(childId)) {
        delete tree.nodes[childId];
        return false;
      }
      return true;
    });
    folder.children.push(keepId);
    folder.expanded = true;
    folder.updatedAt = timestamp;
    stats.treeTabsUpdated += 1;
    return;
  }

  const id = createUniqueTreeNodeId(tree.nodes, importedTab.id);
  tree.nodes[id] = {
    id,
    type: 'tab',
    name,
    url: String(importedTab.url),
    createdAt: importedTab.createdAt || timestamp,
    updatedAt: timestamp,
  };
  folder.children.push(id);
  folder.expanded = true;
  folder.updatedAt = timestamp;
  stats.treeTabsAdded += 1;
}

function mergeTabTree(targetStore, importedStore, stats) {
  const targetTree = normalizeTabTree(targetStore.data.tabTree);
  const importedTree = normalizeTabTree(importedStore.data.tabTree);
  const targetRoot = targetTree.nodes.root;
  const folderByName = new Map();

  for (const folderId of targetRoot.children) {
    const folder = targetTree.nodes[folderId];
    if (folder && folder.type === 'folder') {
      const key = normalizeNameKey(folder.name);
      if (key && !folderByName.has(key)) folderByName.set(key, folderId);
    }
  }

  for (const importedFolderId of importedTree.nodes.root.children) {
    const importedFolder = importedTree.nodes[importedFolderId];
    if (!importedFolder || importedFolder.type !== 'folder') continue;

    const key = normalizeNameKey(importedFolder.name);
    let targetFolderId = key ? folderByName.get(key) : '';
    if (!targetFolderId) {
      targetFolderId = createUniqueTreeNodeId(targetTree.nodes, importedFolder.id);
      targetTree.nodes[targetFolderId] = {
        id: targetFolderId,
        type: 'folder',
        name: String(importedFolder.name || 'Untitled folder'),
        children: [],
        expanded: typeof importedFolder.expanded === 'boolean' ? importedFolder.expanded : true,
        createdAt: importedFolder.createdAt || nowIso(),
        updatedAt: importedFolder.updatedAt || importedFolder.createdAt || nowIso(),
      };
      targetRoot.children.push(targetFolderId);
      if (key) folderByName.set(key, targetFolderId);
      stats.foldersAdded += 1;
    }

    const targetFolder = targetTree.nodes[targetFolderId];
    for (const importedTabId of importedFolder.children) {
      upsertImportedTreeTab(targetTree, targetFolder, importedTree.nodes[importedTabId], stats);
    }
  }

  targetRoot.updatedAt = nowIso();
  targetStore.data.tabTree = normalizeTabTree(targetTree);
}

function mergeStores(targetStore, importedStore) {
  const importedHadTheme = !!(importedStore && importedStore.settings && THEME_OPTIONS.includes(importedStore.settings.theme));
  const target = normalizeStore(targetStore);
  const imported = normalizeStore(importedStore);
  const stats = {
    favoritesAdded: 0,
    savedTabsAdded: 0,
    foldersAdded: 0,
    treeTabsAdded: 0,
    treeTabsUpdated: 0,
  };

  target.features = {
    ...target.features,
    ...imported.features,
    tabTree: {
      ...(target.features.tabTree || {}),
      ...(imported.features.tabTree || {}),
    },
  };
  target.settings = {
    ...target.settings,
    ...(importedHadTheme ? imported.settings : {}),
    theme: importedHadTheme
      ? normalizeThemePreference(imported.settings && imported.settings.theme)
      : normalizeThemePreference(target.settings && target.settings.theme),
  };

  mergeFavorites(target.data.dashboard, imported.data.dashboard, stats);
  mergeSavedTabs(target.data.dashboard, imported.data.dashboard, stats);
  mergeTabTree(target, imported, stats);
  return { store: target, stats };
}

function formatImportStats(stats, mode) {
  if (mode === 'replace') {
    return `Replaced data: ${stats.favorites} sites, ${stats.savedTabs} saved tabs, ${stats.folders} folders, ${stats.treeTabs} stash links.`;
  }

  return `Merged data: +${stats.favoritesAdded} sites, +${stats.savedTabsAdded} saved tabs, +${stats.foldersAdded} folders, +${stats.treeTabsAdded} stash links, ${stats.treeTabsUpdated} updated.`;
}

function createExportEnvelope(store) {
  const manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : { version: '1.0.0' };
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: nowIso(),
    app: {
      name: 'Tab Hub',
      version: manifest.version || '1.0.0',
    },
    data: normalizeStore(store),
  };
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
  const store = await getStore();
  const envelope = createExportEnvelope(store);
  const date = new Date().toISOString().slice(0, 10);
  downloadJsonFile(`tab-hub-backup-${date}.json`, envelope);
  const counts = countStoreData(store);
  setMessage(`Exported ${counts.favorites} sites, ${counts.savedTabs} saved tabs, ${counts.folders} folders, ${counts.treeTabs} stash links.`);
}

async function importDataFromFile(file, mode) {
  if (!file) return;
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Choose a valid JSON backup file');
  }

  const rawImportedStore = extractImportedStore(payload);
  const importedStore = normalizeStore(rawImportedStore);
  if (mode === 'replace') {
    const ok = window.confirm('Replace all Tab Hub data in this browser with the selected backup?');
    if (!ok) return;
    const saved = await saveStore(importedStore);
    applyThemePreference(saved.settings && saved.settings.theme);
    renderState(saved);
    setMessage(formatImportStats(countStoreData(saved), 'replace'));
    return;
  }

  const currentStore = await getStore();
  const { store, stats } = mergeStores(currentStore, rawImportedStore);
  const saved = await saveStore(store);
  applyThemePreference(saved.settings && saved.settings.theme);
  renderState(saved);
  setMessage(formatImportStats(stats, 'merge'));
}

async function setTabTreeEnabled(enabled) {
  const store = await getStore();
  store.features.tabTree = {
    ...(store.features.tabTree || {}),
    enabled: !!enabled,
  };
  await saveStore(store);
  renderState(store);
}

async function setThemePreference(theme) {
  const store = await getStore();
  store.settings = {
    ...(store.settings || {}),
    theme: normalizeThemePreference(theme),
  };
  const saved = await saveStore(store);
  applyThemePreference(saved.settings.theme);
  renderState(saved);
}

function setError(message) {
  const error = document.getElementById('popupError');
  const notice = document.getElementById('popupMessage');
  if (message && notice) notice.style.display = 'none';
  if (!error) return;
  error.textContent = message || '';
  error.style.display = message ? 'block' : 'none';
}

function setMessage(message) {
  const notice = document.getElementById('popupMessage');
  const error = document.getElementById('popupError');
  if (message && error) error.style.display = 'none';
  if (!notice) return;
  notice.textContent = message || '';
  notice.style.display = message ? 'block' : 'none';
}

function renderState(store) {
  const enabled = !!(store.features && store.features.tabTree && store.features.tabTree.enabled);
  const toggle = document.getElementById('tabTreeToggle');
  const openButton = document.getElementById('openTabTreeButton');
  const dot = document.getElementById('statusDot');
  const theme = normalizeThemePreference(store.settings && store.settings.theme);
  if (toggle) toggle.checked = enabled;
  if (openButton) openButton.disabled = !enabled;
  if (dot) dot.classList.toggle('off', !enabled);
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.classList.toggle('active', button.dataset.themeChoice === theme);
  });
}

function markPopupReady() {
  requestAnimationFrame(() => {
    document.body.classList.add('popup-ready');
  });
}

function isTabOutPage(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' &&
      parsed.hostname === chrome.runtime.id &&
      parsed.pathname.endsWith('/index.html');
  } catch {
    return false;
  }
}

async function openTabTree() {
  const store = await getStore();
  if (!store.features.tabTree.enabled) return;

  const tabTreeUrl = chrome.runtime.getURL('index.html#tab-tree');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => isTabOutPage(tab.url));

  if (existing && existing.id) {
    await chrome.tabs.update(existing.id, { active: true, url: tabTreeUrl });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: tabTreeUrl, active: true });
  }

  window.close();
}

async function initializePopup() {
  try {
    const store = await getStore();
    applyThemePreference(store.settings && store.settings.theme);
    renderState(store);
    markPopupReady();
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not load settings');
    markPopupReady();
  }
}

document.getElementById('tabTreeToggle')?.addEventListener('change', async event => {
  try {
    setError('');
    setMessage('');
    await setTabTreeEnabled(event.target.checked);
  } catch (err) {
    event.target.checked = !event.target.checked;
    setError(err && err.message ? err.message : 'Could not update Tab Stash');
  }
});

document.getElementById('openTabTreeButton')?.addEventListener('click', async () => {
  try {
    setError('');
    setMessage('');
    await openTabTree();
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not open Tab Stash');
  }
});

document.getElementById('exportDataButton')?.addEventListener('click', async () => {
  try {
    setError('');
    setMessage('');
    await exportData();
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not export data');
  }
});

document.querySelectorAll('[data-import-mode]').forEach(button => {
  button.addEventListener('click', event => {
    pendingImportMode = event.currentTarget.dataset.importMode || 'merge';
    setError('');
    setMessage('');
    const input = document.getElementById('importFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  });
});

document.querySelectorAll('[data-theme-choice]').forEach(button => {
  button.addEventListener('click', async event => {
    try {
      setError('');
      setMessage('');
      await setThemePreference(event.currentTarget.dataset.themeChoice || 'system');
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not update theme');
    }
  });
});

document.getElementById('importFileInput')?.addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    setError('');
    setMessage('');
    await importDataFromFile(file, pendingImportMode);
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not import data');
  } finally {
    event.target.value = '';
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[TAB_OUT_STORE_KEY]) return;
  const store = normalizeStore(changes[TAB_OUT_STORE_KEY].newValue);
  applyThemePreference(store.settings && store.settings.theme);
  renderState(store);
});

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    const store = await getStore();
    if (normalizeThemePreference(store.settings && store.settings.theme) === 'system') {
      applyThemePreference('system');
    }
  });
}

initializePopup();
