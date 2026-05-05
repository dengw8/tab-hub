'use strict';

const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;
const TAB_TREE_PENDING_ADD_KEY = 'tabTreePendingAdd';
const TAB_TREE_ALLOWED_PROTOCOLS = ['http:', 'https:', 'chrome:', 'chrome-extension:', 'about:', 'file:'];
const THEME_OPTIONS = ['system', 'light', 'dark'];

let pendingPage = null;
let currentStore = null;
let busy = false;

function getPickerMode() {
  return new URLSearchParams(location.search).get('mode') || '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStashRootName(name) {
  const normalized = String(name || '').trim();
  return normalized && normalized !== ['Tab', 'Tree'].join(' ') ? normalized : 'Tab Stash';
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

function createTreeNodeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'node_' + globalThis.crypto.randomUUID();
  }
  return 'node_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function createUniqueTreeNodeId(nodes, preferredId) {
  if (preferredId && preferredId !== 'root' && !nodes[preferredId]) return preferredId;
  let id = createTreeNodeId();
  while (nodes[id]) id = createTreeNodeId();
  return id;
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

function createDefaultStore() {
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
        favorites: [],
        deferred: [],
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

  const rawNodes = {};
  for (const [id, node] of Object.entries(raw.nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'folder') {
      rawNodes[id] = {
        id,
        type: 'folder',
        name: id === 'root' ? normalizeStashRootName(node.name) : String(node.name || 'Untitled folder'),
        children: Array.isArray(node.children) ? node.children.filter(childId => typeof childId === 'string') : [],
        expanded: typeof node.expanded === 'boolean' ? node.expanded : true,
        createdAt: node.createdAt || nowIso(),
        updatedAt: node.updatedAt || node.createdAt || nowIso(),
      };
    } else if (node.type === 'tab') {
      rawNodes[id] = {
        id,
        type: 'tab',
        name: String(node.name || node.url || 'Untitled tab'),
        url: String(node.url || ''),
        createdAt: node.createdAt || nowIso(),
        updatedAt: node.updatedAt || node.createdAt || nowIso(),
      };
    }
  }

  if (!rawNodes.root || rawNodes.root.type !== 'folder') return fallback;

  const root = rawNodes.root;
  const nodes = {
    root: {
      id: 'root',
      type: 'folder',
      name: normalizeStashRootName(root.name),
      children: [],
      expanded: true,
      createdAt: root.createdAt || nowIso(),
      updatedAt: root.updatedAt || root.createdAt || nowIso(),
    },
  };
  const visitedFolders = new Set(['root']);
  const visitedTabs = new Set();
  const rootTabIds = [];

  function cloneTab(tabId) {
    if (visitedTabs.has(tabId)) return null;
    const tab = rawNodes[tabId];
    if (!tab || tab.type !== 'tab') return null;
    visitedTabs.add(tabId);
    const nextId = createUniqueTreeNodeId(nodes, tabId);
    nodes[nextId] = { ...tab, id: nextId };
    return nextId;
  }

  function addFolderToRoot(folderId, pathParts) {
    if (visitedFolders.has(folderId)) return null;
    const folder = rawNodes[folderId];
    if (!folder || folder.type !== 'folder') return null;
    visitedFolders.add(folderId);

    const nextId = createUniqueTreeNodeId(nodes, folderId);
    const nextFolder = {
      ...folder,
      id: nextId,
      name: pathParts.filter(Boolean).join(' / ') || folder.name || 'Untitled folder',
      children: [],
      expanded: typeof folder.expanded === 'boolean' ? folder.expanded : true,
    };
    nodes[nextId] = nextFolder;
    nodes.root.children.push(nextId);

    for (const childId of folder.children) {
      const child = rawNodes[childId];
      if (!child || childId === folderId) continue;
      if (child.type === 'tab') {
        const nextTabId = cloneTab(childId);
        if (nextTabId) nextFolder.children.push(nextTabId);
      } else if (child.type === 'folder') {
        addFolderToRoot(childId, [...pathParts, child.name]);
      }
    }

    return nextId;
  }

  for (const childId of root.children) {
    const child = rawNodes[childId];
    if (!child || childId === 'root') continue;
    if (child.type === 'folder') addFolderToRoot(childId, [child.name]);
    else if (child.type === 'tab') rootTabIds.push(childId);
  }

  const rootTabChildren = rootTabIds.map(cloneTab).filter(Boolean);
  if (rootTabChildren.length > 0) {
    const timestamp = nowIso();
    const unsortedId = createUniqueTreeNodeId(nodes, 'folder_unsorted');
    nodes[unsortedId] = {
      id: unsortedId,
      type: 'folder',
      name: 'Unsorted',
      children: rootTabChildren,
      expanded: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    nodes.root.children.push(unsortedId);
  }

  for (const folderId of nodes.root.children) {
    const folder = nodes[folderId];
    if (folder && folder.type === 'folder') dedupeTreeFolderTabs({ nodes }, folder);
  }

  return {
    schemaVersion: 2,
    maxDepth: 2,
    rootId: 'root',
    nodes,
  };
}

function normalizeStore(raw) {
  const fallback = createDefaultStore();
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
    favorites: Array.isArray(dashboard.favorites) ? dashboard.favorites : [],
    deferred: Array.isArray(dashboard.deferred) ? dashboard.deferred : [],
  };
  store.data.tabTree = normalizeTabTree(store.data.tabTree);
  store.schemaVersion = TAB_OUT_STORE_VERSION;
  return store;
}

async function getStore() {
  const data = await chrome.storage.local.get(TAB_OUT_STORE_KEY);
  const store = normalizeStore(data[TAB_OUT_STORE_KEY]);
  if (!data[TAB_OUT_STORE_KEY]) await saveStore(store);
  return store;
}

async function saveStore(store) {
  const next = normalizeStore(store);
  next.meta.updatedAt = nowIso();
  await chrome.storage.local.set({ [TAB_OUT_STORE_KEY]: next });
  currentStore = next;
  return next;
}

function normalizeTreeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Missing page URL');

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('This page URL is not supported');
  }

  if (!TAB_TREE_ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error('This page URL type is not supported');
  }

  return parsed.toString();
}

function getComparableTreeUrl(url) {
  try { return normalizeTreeUrl(url); }
  catch { return String(url || '').trim(); }
}

function findTabIdsInFolderByUrl(tree, folder, normalizedUrl) {
  if (!folder || !Array.isArray(folder.children)) return [];
  return folder.children.filter(childId => {
    const node = tree.nodes[childId];
    return node && node.type === 'tab' && getComparableTreeUrl(node.url) === normalizedUrl;
  });
}

function dedupeTreeFolderTabs(tree, folder) {
  if (!folder || !Array.isArray(folder.children)) return;
  const latestIdByUrl = new Map();
  for (const childId of folder.children) {
    const node = tree.nodes[childId];
    if (!node || node.type !== 'tab') continue;
    const key = getComparableTreeUrl(node.url);
    if (key) latestIdByUrl.set(key, childId);
  }

  const nextChildren = [];
  for (const childId of folder.children) {
    const node = tree.nodes[childId];
    if (!node || node.type !== 'tab') continue;
    const key = getComparableTreeUrl(node.url);
    if (latestIdByUrl.get(key) !== childId) {
      delete tree.nodes[childId];
      continue;
    }
    nextChildren.push(childId);
  }
  folder.children = nextChildren;
}

function upsertTreeTabInFolder(tree, folderId, name, normalizedUrl, timestamp = nowIso()) {
  const folder = tree.nodes[folderId];
  if (!folder || folder.type !== 'folder' || folderId === 'root') {
    throw new Error('Choose a valid folder');
  }

  const trimmedName = String(name || '').trim() || displayNameFromTreeUrl(normalizedUrl);
  const existingIds = findTabIdsInFolderByUrl(tree, folder, normalizedUrl);
  const existing = existingIds.length > 0 ? tree.nodes[existingIds[existingIds.length - 1]] : null;
  if (existing) {
    existing.name = trimmedName;
    existing.url = normalizedUrl;
    existing.updatedAt = timestamp;
    folder.children = folder.children.filter(childId => {
      if (childId === existing.id) return false;
      if (existingIds.includes(childId)) {
        delete tree.nodes[childId];
        return false;
      }
      return true;
    });
    folder.children.push(existing.id);
    folder.expanded = true;
    folder.updatedAt = timestamp;
    return existing;
  }

  const tabId = createUniqueTreeNodeId(tree.nodes);
  tree.nodes[tabId] = {
    id: tabId,
    type: 'tab',
    name: trimmedName,
    url: normalizedUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  folder.children.push(tabId);
  folder.expanded = true;
  folder.updatedAt = timestamp;
  return tree.nodes[tabId];
}

function stripTitleNoise(title) {
  if (!title) return '';
  return String(title)
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*\([\d,]+\+?\)\s*/g, ' ')
    .trim();
}

function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function friendlyDomain(hostname) {
  const known = {
    'github.com': 'GitHub',
    'www.github.com': 'GitHub',
    'zhuanlan.zhihu.com': 'Zhihu',
    'zhihu.com': 'Zhihu',
    'www.zhihu.com': 'Zhihu',
    'bytedance.larkoffice.com': 'Bytedance Larkoffice',
    'bytetech.info': 'ByteTech',
  };
  if (known[hostname]) return known[hostname];
  return hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '')
    .split('.')
    .map(part => capitalize(part))
    .join(' ');
}

function displayNameFromTreeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const domain = friendlyDomain(parsed.hostname) || parsed.hostname;
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : '';
      return path ? `${domain}${path}` : domain;
    }
    if (parsed.protocol === 'file:') {
      const parts = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
      return parts[parts.length - 1] || url;
    }
    return url;
  } catch {
    return url;
  }
}

function getPendingDisplayTitle() {
  const url = pendingPage && pendingPage.url ? pendingPage.url : '';
  const title = stripTitleNoise(pendingPage && pendingPage.title ? pendingPage.title : '');
  return title || displayNameFromTreeUrl(url);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setError(message) {
  const error = document.getElementById('pickerError');
  if (!error) return;
  error.textContent = message || '';
  error.style.display = message ? 'block' : 'none';
}

function setBusy(nextBusy) {
  busy = nextBusy;
  document.querySelectorAll('button, input').forEach(el => {
    if (el.id !== 'closePickerButton') el.disabled = busy;
  });
}

function getFolders(tree) {
  const root = tree.nodes.root;
  return root.children
    .map(id => tree.nodes[id])
    .filter(node => node && node.type === 'folder');
}

function renderPendingPage() {
  const title = document.getElementById('pendingTitle');
  const url = document.getElementById('pendingUrl');
  if (!title || !url) return;
  title.textContent = getPendingDisplayTitle();
  url.textContent = pendingPage && pendingPage.url ? pendingPage.url : '';
}

function renderFolders() {
  const list = document.getElementById('folderList');
  const empty = document.getElementById('folderEmpty');
  if (!list || !empty || !currentStore) return;
  const newFolderOnly = getPickerMode() === 'new-folder';

  const enabled = currentStore.features.tabTree.enabled !== false;
  const newFolderButton = document.getElementById('newFolderButton');
  if (newFolderButton) {
    newFolderButton.disabled = !enabled;
    newFolderButton.style.display = newFolderOnly ? 'none' : 'flex';
  }
  if (!enabled) {
    list.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'Tab Stash is turned off in Settings.';
    return;
  }

  if (newFolderOnly) {
    list.innerHTML = '';
    empty.style.display = 'none';
    return;
  }

  const tree = currentStore.data.tabTree;
  const folders = getFolders(tree);
  empty.style.display = folders.length === 0 ? 'block' : 'none';
  empty.textContent = 'Create a folder first, then this page will be added there.';
  list.innerHTML = folders.map(folder => {
    const count = Array.isArray(folder.children) ? folder.children.length : 0;
    return `
      <button class="tree-picker-folder" type="button" data-folder-id="${escapeHtml(folder.id)}">
        <span class="tree-picker-folder-name">${escapeHtml(folder.name)}</span>
        <span class="tree-picker-folder-count">${count}</span>
      </button>`;
  }).join('');
}

async function loadPendingPage() {
  const data = await chrome.storage.session.get(TAB_TREE_PENDING_ADD_KEY);
  pendingPage = data[TAB_TREE_PENDING_ADD_KEY] || null;
  if (!pendingPage || !pendingPage.url) {
    throw new Error('No page is waiting to be added.');
  }
  pendingPage.url = normalizeTreeUrl(pendingPage.url);
}

async function addPendingToFolder(folderId) {
  if (busy) return;
  setBusy(true);
  setError('');

  try {
    const store = normalizeStore(currentStore || await getStore());
    if (store.features.tabTree.enabled === false) {
      throw new Error('Tab Stash is turned off in Settings.');
    }
    const tree = store.data.tabTree;
    upsertTreeTabInFolder(tree, folderId, getPendingDisplayTitle(), pendingPage.url);
    await saveStore(store);
    await chrome.storage.session.remove(TAB_TREE_PENDING_ADD_KEY);
    setTimeout(() => window.close(), 180);
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not add page');
    setBusy(false);
  }
}

async function createFolderAndAdd(name) {
  if (busy) return;
  const trimmed = (name || '').trim();
  if (!trimmed) {
    setError('Enter a folder name');
    return;
  }

  setBusy(true);
  setError('');

  try {
    const store = normalizeStore(currentStore || await getStore());
    if (store.features.tabTree.enabled === false) {
      throw new Error('Tab Stash is turned off in Settings.');
    }
    const tree = store.data.tabTree;
    const timestamp = nowIso();
    const folderId = createUniqueTreeNodeId(tree.nodes);
    const tabId = createUniqueTreeNodeId({ ...tree.nodes, [folderId]: true });
    tree.nodes[folderId] = {
      id: folderId,
      type: 'folder',
      name: trimmed,
      children: [tabId],
      expanded: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    tree.nodes[tabId] = {
      id: tabId,
      type: 'tab',
      name: getPendingDisplayTitle(),
      url: pendingPage.url,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    tree.nodes.root.children.push(folderId);
    tree.nodes.root.updatedAt = timestamp;
    await saveStore(store);
    await chrome.storage.session.remove(TAB_TREE_PENDING_ADD_KEY);
    setTimeout(() => window.close(), 180);
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not create folder');
    setBusy(false);
  }
}

async function initializePicker() {
  try {
    await loadPendingPage();
    currentStore = await getStore();
    applyThemePreference(currentStore.settings && currentStore.settings.theme);
    renderPendingPage();
    renderFolders();
    if (getPickerMode() === 'new-folder') {
      const form = document.getElementById('newFolderForm');
      const input = document.getElementById('newFolderNameInput');
      if (form) form.style.display = 'flex';
      if (input) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    }
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not load page');
  }
}

document.getElementById('closePickerButton')?.addEventListener('click', () => {
  window.close();
});

document.getElementById('newFolderButton')?.addEventListener('click', () => {
  const form = document.getElementById('newFolderForm');
  const input = document.getElementById('newFolderNameInput');
  if (!form || !input) return;
  form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  if (form.style.display !== 'none') {
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
});

document.getElementById('newFolderForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('newFolderNameInput');
  await createFolderAndAdd(input ? input.value : '');
});

document.getElementById('folderList')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-folder-id]');
  if (!button) return;
  await addPendingToFolder(button.dataset.folderId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[TAB_OUT_STORE_KEY]) return;
  currentStore = normalizeStore(changes[TAB_OUT_STORE_KEY].newValue);
  applyThemePreference(currentStore.settings && currentStore.settings.theme);
  renderFolders();
});

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const theme = currentStore && currentStore.settings ? currentStore.settings.theme : 'system';
    if (normalizeThemePreference(theme) === 'system') applyThemePreference('system');
  });
}

initializePicker();
