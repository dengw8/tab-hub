'use strict';

const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
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
        name: 'Tab Tree',
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

async function setTabTreeEnabled(enabled) {
  const store = await getStore();
  store.features.tabTree = {
    ...(store.features.tabTree || {}),
    enabled: !!enabled,
  };
  await saveStore(store);
  renderState(store);
}

function setError(message) {
  const error = document.getElementById('popupError');
  if (!error) return;
  error.textContent = message || '';
  error.style.display = message ? 'block' : 'none';
}

function renderState(store) {
  const enabled = !!(store.features && store.features.tabTree && store.features.tabTree.enabled);
  const toggle = document.getElementById('tabTreeToggle');
  const openButton = document.getElementById('openTabTreeButton');
  const dot = document.getElementById('statusDot');
  if (toggle) toggle.checked = enabled;
  if (openButton) openButton.disabled = !enabled;
  if (dot) dot.classList.toggle('off', !enabled);
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
    await setTabTreeEnabled(event.target.checked);
  } catch (err) {
    event.target.checked = !event.target.checked;
    setError(err && err.message ? err.message : 'Could not update Tab Tree');
  }
});

document.getElementById('openTabTreeButton')?.addEventListener('click', async () => {
  try {
    setError('');
    await openTabTree();
  } catch (err) {
    setError(err && err.message ? err.message : 'Could not open Tab Tree');
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[TAB_OUT_STORE_KEY]) return;
  renderState(normalizeStore(changes[TAB_OUT_STORE_KEY].newValue));
});

initializePopup();
