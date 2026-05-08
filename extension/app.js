/* ================================================================
   Tab Hub — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let favoriteDragId = null;
let treeDragId = null;
let treeDragType = null;
let atlasDragId = null;
let atlasDragType = null;
let atlasDragSubtreeHeight = 1;
let overflowChipSeq = 0;
let dashboardRenderRun = 0;
let currentView = 'dashboard';
let tabTreeSearchQuery = '';
let tabAtlasHomeSearchQuery = '';
let tabAtlasDetailSearchQuery = '';
let currentAtlasTopicId = '';
const overflowChipCache = new Map();
const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;
const TAB_ATLAS_MAX_DEPTH = 3;
const THEME_OPTIONS = ['system', 'light', 'dark'];

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

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Hub's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      favIconUrl: t.favIconUrl || '',
      // Flag Tab Hub's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Hub new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Hub tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function normalizeStashRootName(name) {
  const normalized = String(name || '').trim();
  return normalized && normalized !== ['Tab', 'Tree'].join(' ') ? normalized : 'Tab Stash';
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

function createDefaultTabAtlas() {
  return {
    schemaVersion: 1,
    maxDepth: TAB_ATLAS_MAX_DEPTH,
    rootTopicIds: [],
    topics: {},
    tabs: {},
    recentTopicIds: [],
  };
}

function createDefaultStore(legacy = {}) {
  const createdAt = nowIso();
  return {
    schemaVersion: TAB_OUT_STORE_VERSION,
    appVersion: chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.0.0',
    features: {
      tabTree: { enabled: true },
      tabAtlas: { enabled: true },
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
      tabAtlas: createDefaultTabAtlas(),
    },
    meta: {
      createdAt,
      updatedAt: createdAt,
    },
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
  if (!store.features.tabAtlas || typeof store.features.tabAtlas !== 'object') {
    store.features.tabAtlas = { enabled: true };
  }
  if (typeof store.features.tabAtlas.enabled !== 'boolean') {
    store.features.tabAtlas.enabled = true;
  }
  store.settings.theme = normalizeThemePreference(store.settings.theme);

  const dashboard = store.data.dashboard && typeof store.data.dashboard === 'object' ? store.data.dashboard : {};
  store.data.dashboard = {
    favorites: Array.isArray(dashboard.favorites) ? dashboard.favorites : fallback.data.dashboard.favorites,
    deferred: Array.isArray(dashboard.deferred) ? dashboard.deferred : fallback.data.dashboard.deferred,
  };

  store.data.tabTree = normalizeTabTree(store.data.tabTree);
  store.data.tabAtlas = normalizeTabAtlas(store.data.tabAtlas);
  store.schemaVersion = TAB_OUT_STORE_VERSION;
  return store;
}

async function getTabOutStore() {
  const data = await chrome.storage.local.get([TAB_OUT_STORE_KEY, 'favorites', 'deferred']);
  const store = normalizeStore(data[TAB_OUT_STORE_KEY], {
    favorites: data.favorites,
    deferred: data.deferred,
  });

  if (!data[TAB_OUT_STORE_KEY]) {
    await saveTabOutStore(store);
  }

  return store;
}

async function saveTabOutStore(store) {
  const next = normalizeStore(store);
  next.meta.updatedAt = nowIso();
  await chrome.storage.local.set({ [TAB_OUT_STORE_KEY]: next });
  return next;
}

async function updateTabOutStore(mutator) {
  const store = await getTabOutStore();
  await mutator(store);
  return saveTabOutStore(store);
}

function getDashboardData(store) {
  return store.data && store.data.dashboard ? store.data.dashboard : { favorites: [], deferred: [] };
}

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string, favIconUrl?: string }} tab
 */
async function saveTabForLater(tab) {
  await updateTabOutStore(store => {
    const dashboard = getDashboardData(store);
    dashboard.deferred.push({
      id:        Date.now().toString(),
      url:       tab.url,
      title:     tab.title,
      favIconUrl: tab.favIconUrl || '',
      savedAt:   nowIso(),
      completed: false,
      dismissed: false,
    });
  });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const store = await getTabOutStore();
  const dashboard = getDashboardData(store);
  const deferred = Array.isArray(dashboard.deferred) ? dashboard.deferred : [];
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  await updateTabOutStore(store => {
    const tab = getDashboardData(store).deferred.find(t => t.id === id);
    if (tab) {
      tab.completed = true;
      tab.completedAt = nowIso();
    }
  });
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  await updateTabOutStore(store => {
    const tab = getDashboardData(store).deferred.find(t => t.id === id);
    if (tab) tab.dismissed = true;
  });
}


/* ----------------------------------------------------------------
   COMMON SITES — chrome.storage.local

   Stores user-configured shortcuts shown near the top of the new tab
   page. Each favorite is URL-only; display names are derived at render time.
   ---------------------------------------------------------------- */

function createFavoriteId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'fav_' + globalThis.crypto.randomUUID();
  }
  return 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function getFavorites() {
  const store = await getTabOutStore();
  const { favorites = [] } = getDashboardData(store);
  if (!Array.isArray(favorites)) return [];

  return favorites
    .filter(item => item && typeof item.url === 'string')
    .map(item => ({
      id: item.id || createFavoriteId(),
      url: item.url,
      favIconUrl: item.favIconUrl || '',
      createdAt: item.createdAt || new Date().toISOString(),
    }));
}

async function saveFavorites(favorites) {
  await updateTabOutStore(store => {
    getDashboardData(store).favorites = favorites;
  });
}

function normalizeFavoriteUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Enter a URL');

  const lower = trimmed.toLowerCase();
  const blockedPrefixes = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];
  const candidate = /^https?:\/\//i.test(trimmed) || blockedPrefixes.some(prefix => lower.startsWith(prefix))
    ? trimmed
    : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Enter a valid URL');
  }

  if (isBlockedFavoriteUrl(parsed)) throw new Error('That URL cannot be added');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use a regular website URL');

  return parsed.toString();
}

function isBlockedFavoriteUrl(parsedUrl) {
  const protocol = typeof parsedUrl === 'string' ? new URL(parsedUrl).protocol : parsedUrl.protocol;
  return ['chrome:', 'chrome-extension:', 'about:', 'edge:', 'brave:'].includes(protocol);
}

async function addFavorite(urlInput) {
  const favorites = await getFavorites();
  const url = normalizeFavoriteUrl(urlInput);
  if (favorites.some(item => item.url === url)) throw new Error('Site already exists');

  favorites.push({
    id: createFavoriteId(),
    url,
    createdAt: new Date().toISOString(),
  });

  await saveFavorites(favorites);
}

async function updateFavorite(id, urlInput) {
  const favorites = await getFavorites();
  const favorite = favorites.find(item => item.id === id);
  if (!favorite) throw new Error('Site not found');

  const url = normalizeFavoriteUrl(urlInput);
  if (favorites.some(item => item.id !== id && item.url === url)) throw new Error('Site already exists');

  favorite.url = url;
  favorite.favIconUrl = '';
  await saveFavorites(favorites);
}

async function removeFavorite(id) {
  const favorites = await getFavorites();
  const next = favorites.filter(item => item.id !== id);
  await saveFavorites(next);
}

async function moveFavorite(draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return false;

  const favorites = await getFavorites();
  const fromIndex = favorites.findIndex(item => item.id === draggedId);
  const toIndex = favorites.findIndex(item => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return false;

  const [moved] = favorites.splice(fromIndex, 1);
  favorites.splice(toIndex, 0, moved);
  await saveFavorites(favorites);
  return true;
}


/* ----------------------------------------------------------------
   TAB Stash — Data model, storage, URL handling
   ---------------------------------------------------------------- */

const TAB_TREE_ALLOWED_PROTOCOLS = ['http:', 'https:', 'chrome:', 'chrome-extension:', 'about:', 'file:'];

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
    const folderName = pathParts.filter(Boolean).join(' / ') || folder.name || 'Untitled folder';
    const nextFolder = {
      ...folder,
      id: nextId,
      name: folderName,
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
    if (child.type === 'folder') {
      addFolderToRoot(childId, [child.name]);
    } else if (child.type === 'tab') {
      rootTabIds.push(childId);
    }
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

/* ----------------------------------------------------------------
   TAB Atlas — Knowledge topics and source tabs
   ---------------------------------------------------------------- */

function createAtlasTopicId() {
  return createScopedNodeId('topic');
}

function createAtlasSourceId() {
  return createScopedNodeId('source');
}

function createScopedNodeId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createUniqueAtlasId(collection, preferredId, fallbackFactory) {
  if (preferredId && !collection[preferredId]) return preferredId;
  let id = fallbackFactory();
  while (collection[id]) id = fallbackFactory();
  return id;
}

function normalizeAtlasNameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function makeUniqueAtlasTopicName(name, usedNames) {
  const base = String(name || 'Untitled topic').trim() || 'Untitled topic';
  let candidate = base;
  let index = 2;
  while (usedNames.has(normalizeAtlasNameKey(candidate))) {
    candidate = `${base} (${index})`;
    index += 1;
  }
  usedNames.add(normalizeAtlasNameKey(candidate));
  return candidate;
}

function createAtlasItem(type, id) {
  return { type, id };
}

function getRawAtlasTopicItems(topic) {
  const items = [];
  const seen = new Set();
  const add = (type, id) => {
    if ((type !== 'tab' && type !== 'topic') || typeof id !== 'string' || !id) return;
    items.push(createAtlasItem(type, id));
    seen.add(`${type}:${id}`);
  };

  if (Array.isArray(topic.items) && topic.items.length > 0) {
    topic.items.forEach(item => {
      if (!item || typeof item !== 'object') return;
      add(item.type, item.id);
    });
  }

  const tabIds = Array.isArray(topic.tabIds) ? topic.tabIds.filter(tabId => typeof tabId === 'string') : [];
  const childIds = Array.isArray(topic.children) ? topic.children.filter(childId => typeof childId === 'string') : [];
  if (items.length === 0) {
    tabIds.forEach(tabId => add('tab', tabId));
    childIds.forEach(childId => add('topic', childId));
  } else {
    tabIds.forEach(tabId => {
      if (!seen.has(`tab:${tabId}`)) add('tab', tabId);
    });
    childIds.forEach(childId => {
      if (!seen.has(`topic:${childId}`)) add('topic', childId);
    });
  }
  return items;
}

function syncAtlasTopicItemIndexes(topic) {
  const items = Array.isArray(topic.items) ? topic.items : [];
  topic.items = items.filter(item =>
    item && (item.type === 'tab' || item.type === 'topic') && typeof item.id === 'string' && item.id
  );
  topic.tabIds = topic.items.filter(item => item.type === 'tab').map(item => item.id);
  topic.children = topic.items.filter(item => item.type === 'topic').map(item => item.id);
}

function removeAtlasTopicItem(topic, type, id) {
  if (!topic || !Array.isArray(topic.items)) return;
  topic.items = topic.items.filter(item => item.type !== type || item.id !== id);
  syncAtlasTopicItemIndexes(topic);
}

function insertAtlasTopicItem(topic, type, id, index = -1) {
  if (!topic) return;
  if (!Array.isArray(topic.items)) topic.items = [];
  topic.items = topic.items.filter(item => item.type !== type || item.id !== id);
  const item = createAtlasItem(type, id);
  const safeIndex = index < 0 ? topic.items.length : Math.max(0, Math.min(index, topic.items.length));
  topic.items.splice(safeIndex, 0, item);
  syncAtlasTopicItemIndexes(topic);
}

function findAtlasTopicItemIndex(topic, type, id) {
  if (!topic || !Array.isArray(topic.items)) return -1;
  return topic.items.findIndex(item => item.type === type && item.id === id);
}

function normalizeTabAtlas(raw) {
  const fallback = createDefaultTabAtlas();
  if (!raw || typeof raw !== 'object') return fallback;

  const rawTopics = raw.topics && typeof raw.topics === 'object' ? raw.topics : {};
  const rawTabs = raw.tabs && typeof raw.tabs === 'object' ? raw.tabs : {};
  const topics = {};
  const tabs = {};
  const visitedTopics = new Set();
  const topicIdByRawId = new Map();
  const maxDepth = TAB_ATLAS_MAX_DEPTH;

  function cloneTab(rawTabId) {
    const tab = rawTabs[rawTabId];
    if (!tab || typeof tab !== 'object' || typeof tab.url !== 'string') return '';
    const id = createUniqueAtlasId(tabs, rawTabId, createAtlasSourceId);
    const timestamp = tab.updatedAt || tab.createdAt || nowIso();
    tabs[id] = {
      id,
      title: String(tab.title || tab.name || tab.url || 'Untitled tab'),
      url: String(tab.url || ''),
      note: String(tab.note || ''),
      createdAt: tab.createdAt || timestamp,
      updatedAt: timestamp,
    };
    return id;
  }

  function cloneTopic(rawTopicId, depth, usedSiblingNames) {
    if (visitedTopics.has(rawTopicId) || depth > maxDepth) return '';
    const topic = rawTopics[rawTopicId];
    if (!topic || typeof topic !== 'object') return '';
    visitedTopics.add(rawTopicId);

    const id = createUniqueAtlasId(topics, rawTopicId, createAtlasTopicId);
    topicIdByRawId.set(rawTopicId, id);
    const timestamp = topic.updatedAt || topic.createdAt || nowIso();
    const nextTopic = {
      id,
      name: makeUniqueAtlasTopicName(topic.name, usedSiblingNames),
      note: String(topic.note || ''),
      children: [],
      tabIds: [],
      items: [],
      expanded: typeof topic.expanded === 'boolean' ? topic.expanded : true,
      createdAt: topic.createdAt || timestamp,
      updatedAt: timestamp,
    };
    topics[id] = nextTopic;

    const rawItems = getRawAtlasTopicItems(topic);
    const rawTabIds = rawItems.filter(item => item.type === 'tab').map(item => item.id);
    const latestTabIdByUrl = new Map();
    for (const rawTabId of rawTabIds) {
      const tab = rawTabs[rawTabId];
      if (!tab || typeof tab.url !== 'string') continue;
      const key = getComparableAtlasUrl(tab.url);
      if (key) latestTabIdByUrl.set(key, rawTabId);
    }
    const addedTabKeys = new Set();

    const usedChildNames = new Set();
    for (const item of rawItems) {
      if (item.type === 'tab') {
        const tab = rawTabs[item.id];
        if (!tab || typeof tab.url !== 'string') continue;
        const key = getComparableAtlasUrl(tab.url);
        if (!key || addedTabKeys.has(key) || latestTabIdByUrl.get(key) !== item.id) continue;
        const tabId = cloneTab(item.id);
        if (tabId) {
          nextTopic.items.push(createAtlasItem('tab', tabId));
          addedTabKeys.add(key);
        }
      } else if (depth < maxDepth) {
        const clonedChildId = cloneTopic(item.id, depth + 1, usedChildNames);
        if (clonedChildId) nextTopic.items.push(createAtlasItem('topic', clonedChildId));
      }
    }
    syncAtlasTopicItemIndexes(nextTopic);

    return id;
  }

  const rootTopicIds = [];
  const rawRootIds = Array.isArray(raw.rootTopicIds) ? raw.rootTopicIds.filter(id => typeof id === 'string') : [];
  const usedRootNames = new Set();
  for (const rawTopicId of rawRootIds) {
    const topicId = cloneTopic(rawTopicId, 1, usedRootNames);
    if (topicId) rootTopicIds.push(topicId);
  }

  return {
    schemaVersion: 1,
    maxDepth,
    rootTopicIds,
    topics,
    tabs,
    recentTopicIds: Array.isArray(raw.recentTopicIds)
      ? raw.recentTopicIds
          .map(topicId => topicIdByRawId.get(topicId) || topicId)
          .filter((topicId, index, ids) => topics[topicId] && ids.indexOf(topicId) === index)
          .slice(0, 5)
      : [],
  };
}

async function getTabAtlas() {
  const store = await getTabOutStore();
  return normalizeTabAtlas(store.data.tabAtlas);
}

async function saveTabAtlas(atlas) {
  await updateTabOutStore(store => {
    store.data.tabAtlas = normalizeTabAtlas(atlas);
  });
}

async function isTabAtlasEnabled() {
  const store = await getTabOutStore();
  return !!(store.features && store.features.tabAtlas && store.features.tabAtlas.enabled);
}

async function setTabAtlasEnabled(enabled) {
  await updateTabOutStore(store => {
    store.features.tabAtlas = { ...(store.features.tabAtlas || {}), enabled: !!enabled };
  });
}

function getComparableAtlasUrl(url) {
  try { return normalizeTreeUrl(url); }
  catch { return String(url || '').trim(); }
}

function findAtlasParentInfo(atlas, topicId) {
  if (atlas.rootTopicIds.includes(topicId)) {
    return { parentId: '', list: atlas.rootTopicIds };
  }
  for (const topic of Object.values(atlas.topics)) {
    if (topic.children.includes(topicId)) {
      return { parentId: topic.id, list: topic.children };
    }
  }
  return null;
}

function findAtlasTabParent(atlas, tabId) {
  return Object.values(atlas.topics).find(topic => topic.tabIds.includes(tabId)) || null;
}

function getAtlasTopicDepth(atlas, topicId) {
  function visit(id, depth) {
    if (id === topicId) return depth;
    const topic = atlas.topics[id];
    if (!topic) return 0;
    for (const childId of topic.children) {
      const found = visit(childId, depth + 1);
      if (found) return found;
    }
    return 0;
  }

  for (const rootId of atlas.rootTopicIds) {
    const found = visit(rootId, 1);
    if (found) return found;
  }
  return 0;
}

function getAtlasRootTopicId(atlas, topicId) {
  function visit(id, rootId) {
    if (id === topicId) return rootId;
    const topic = atlas.topics[id];
    if (!topic) return '';
    for (const childId of topic.children) {
      const found = visit(childId, rootId);
      if (found) return found;
    }
    return '';
  }

  for (const rootId of atlas.rootTopicIds) {
    const found = visit(rootId, rootId);
    if (found) return found;
  }
  return '';
}

function atlasSiblingTopics(atlas, parentId) {
  const ids = parentId ? (atlas.topics[parentId] && atlas.topics[parentId].children) || [] : atlas.rootTopicIds;
  return ids.map(id => atlas.topics[id]).filter(Boolean);
}

function assertUniqueAtlasTopicName(atlas, parentId, name, exceptId = '') {
  const key = normalizeAtlasNameKey(name);
  if (!key) throw new Error('Enter a topic name');
  const exists = atlasSiblingTopics(atlas, parentId).some(topic =>
    topic.id !== exceptId && normalizeAtlasNameKey(topic.name) === key
  );
  if (exists) throw new Error('Topic name already exists here');
}

function touchAtlasTopicBranch(atlas, topicId, timestamp = nowIso()) {
  let currentId = topicId;
  while (currentId) {
    const topic = atlas.topics[currentId];
    if (topic) topic.updatedAt = timestamp;
    const parent = findAtlasParentInfo(atlas, currentId);
    currentId = parent && parent.parentId ? parent.parentId : '';
  }
}

async function addAtlasTopic(parentId, name, note = '') {
  const trimmedName = String(name || '').trim();
  const atlas = await getTabAtlas();
  const parentTopic = parentId ? atlas.topics[parentId] : null;
  if (parentId && !parentTopic) throw new Error('Topic not found');
  const parentDepth = parentId ? getAtlasTopicDepth(atlas, parentId) : 0;
  if (parentDepth >= atlas.maxDepth) throw new Error('Maximum depth is 3');
  assertUniqueAtlasTopicName(atlas, parentId, trimmedName);

  const id = createAtlasTopicId();
  const timestamp = nowIso();
  atlas.topics[id] = {
    id,
    name: trimmedName,
    note: String(note || '').trim(),
    children: [],
    tabIds: [],
    items: [],
    expanded: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (parentId) {
    insertAtlasTopicItem(parentTopic, 'topic', id);
    touchAtlasTopicBranch(atlas, parentId, timestamp);
  } else {
    atlas.rootTopicIds.push(id);
  }
  await saveTabAtlas(atlas);
  return id;
}

async function updateAtlasTopic(topicId, name, note = '') {
  const trimmedName = String(name || '').trim();
  const atlas = await getTabAtlas();
  const topic = atlas.topics[topicId];
  if (!topic) throw new Error('Topic not found');
  const parent = findAtlasParentInfo(atlas, topicId);
  assertUniqueAtlasTopicName(atlas, parent ? parent.parentId : '', trimmedName, topicId);
  topic.name = trimmedName;
  topic.note = String(note || '').trim();
  touchAtlasTopicBranch(atlas, topicId);
  await saveTabAtlas(atlas);
}

async function toggleAtlasTopic(topicId) {
  const atlas = await getTabAtlas();
  const topic = atlas.topics[topicId];
  if (!topic) return;
  topic.expanded = !topic.expanded;
  topic.updatedAt = nowIso();
  await saveTabAtlas(atlas);
}

function collectAtlasTopicSubtreeIds(atlas, topicId, ids = []) {
  const topic = atlas.topics[topicId];
  if (!topic) return ids;
  ids.push(topicId);
  topic.children.forEach(childId => collectAtlasTopicSubtreeIds(atlas, childId, ids));
  return ids;
}

async function deleteAtlasTopic(topicId) {
  const atlas = await getTabAtlas();
  const topic = atlas.topics[topicId];
  if (!topic) throw new Error('Topic not found');
  const parent = findAtlasParentInfo(atlas, topicId);
  if (parent) {
    parent.list.splice(parent.list.indexOf(topicId), 1);
    if (parent.parentId && atlas.topics[parent.parentId]) {
      removeAtlasTopicItem(atlas.topics[parent.parentId], 'topic', topicId);
    }
  }
  const subtreeIds = collectAtlasTopicSubtreeIds(atlas, topicId);
  for (const id of subtreeIds) {
    const node = atlas.topics[id];
    if (!node) continue;
    node.tabIds.forEach(tabId => delete atlas.tabs[tabId]);
    delete atlas.topics[id];
  }
  if (parent && parent.parentId) touchAtlasTopicBranch(atlas, parent.parentId);
  await saveTabAtlas(atlas);
}

function displayNameFromAtlasUrl(url) {
  return displayNameFromTreeUrl(url);
}

function upsertAtlasTabSource(atlas, topicId, title, normalizedUrl, note = '', timestamp = nowIso()) {
  const topic = atlas.topics[topicId];
  if (!topic) throw new Error('Topic not found');
  const urlKey = getComparableAtlasUrl(normalizedUrl);
  const sameIds = topic.tabIds.filter(tabId => {
    const tab = atlas.tabs[tabId];
    return tab && getComparableAtlasUrl(tab.url) === urlKey;
  });
  const trimmedTitle = String(title || '').trim() || displayNameFromAtlasUrl(normalizedUrl);
  if (sameIds.length > 0) {
    const keepId = sameIds[sameIds.length - 1];
    const existing = atlas.tabs[keepId];
    existing.title = trimmedTitle;
    existing.url = normalizedUrl;
    existing.note = String(note || '').trim();
    existing.updatedAt = timestamp;
    topic.tabIds = topic.tabIds.filter(tabId => {
      if (tabId === keepId) return false;
      if (sameIds.includes(tabId)) {
        delete atlas.tabs[tabId];
        return false;
      }
      return true;
    });
    topic.items = (Array.isArray(topic.items) ? topic.items : []).filter(item =>
      item.type !== 'tab' || !sameIds.includes(item.id)
    );
    insertAtlasTopicItem(topic, 'tab', keepId);
    touchAtlasTopicBranch(atlas, topicId, timestamp);
    return existing;
  }

  const id = createAtlasSourceId();
  atlas.tabs[id] = {
    id,
    title: trimmedTitle,
    url: normalizedUrl,
    note: String(note || '').trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  insertAtlasTopicItem(topic, 'tab', id);
  touchAtlasTopicBranch(atlas, topicId, timestamp);
  return atlas.tabs[id];
}

async function addAtlasTabSource(topicId, title, url, note = '') {
  const normalizedUrl = normalizeTreeUrl(url);
  const atlas = await getTabAtlas();
  upsertAtlasTabSource(atlas, topicId, title, normalizedUrl, note);
  await saveTabAtlas(atlas);
}

async function updateAtlasTabSource(tabId, title, url, note = '') {
  const normalizedUrl = normalizeTreeUrl(url);
  const atlas = await getTabAtlas();
  const tab = atlas.tabs[tabId];
  if (!tab) throw new Error('Tab source not found');
  const parent = findAtlasTabParent(atlas, tabId);
  if (!parent) throw new Error('Topic not found');
  const urlKey = getComparableAtlasUrl(normalizedUrl);
  const duplicate = parent.tabIds.some(id => id !== tabId && atlas.tabs[id] && getComparableAtlasUrl(atlas.tabs[id].url) === urlKey);
  if (duplicate) throw new Error('This URL already exists in this topic');
  tab.title = String(title || '').trim() || displayNameFromAtlasUrl(normalizedUrl);
  tab.url = normalizedUrl;
  tab.note = String(note || '').trim();
  tab.updatedAt = nowIso();
  touchAtlasTopicBranch(atlas, parent.id, tab.updatedAt);
  await saveTabAtlas(atlas);
}

async function deleteAtlasTabSource(tabId) {
  const atlas = await getTabAtlas();
  const parent = findAtlasTabParent(atlas, tabId);
  if (!parent || !atlas.tabs[tabId]) throw new Error('Tab source not found');
  parent.tabIds = parent.tabIds.filter(id => id !== tabId);
  removeAtlasTopicItem(parent, 'tab', tabId);
  delete atlas.tabs[tabId];
  touchAtlasTopicBranch(atlas, parent.id);
  await saveTabAtlas(atlas);
}

function getAtlasTopicSubtreeHeight(atlas, topicId) {
  const topic = atlas.topics[topicId];
  if (!topic || topic.children.length === 0) return 1;
  return 1 + Math.max(...topic.children.map(childId => getAtlasTopicSubtreeHeight(atlas, childId)));
}

async function moveAtlasTopic(draggedId, targetType, targetId, position = 'after') {
  if (!draggedId || !targetId || (targetType === 'topic' && draggedId === targetId)) return false;
  const atlas = await getTabAtlas();
  const dragged = atlas.topics[draggedId];
  if (!dragged || getAtlasRootTopicId(atlas, draggedId) !== currentAtlasTopicId) return false;

  const oldParent = findAtlasParentInfo(atlas, draggedId);
  if (!oldParent || !oldParent.parentId) return false;
  const oldParentTopic = atlas.topics[oldParent.parentId];
  if (!oldParentTopic) return false;

  const draggedSubtreeIds = collectAtlasTopicSubtreeIds(atlas, draggedId);
  let newParent = null;
  let newParentId = '';
  let insertIndex = -1;

  if (position === 'inside') {
    if (targetType !== 'topic') return false;
    const target = atlas.topics[targetId];
    if (!target || getAtlasRootTopicId(atlas, targetId) !== currentAtlasTopicId) return false;
    const targetDepth = getAtlasTopicDepth(atlas, targetId);
    if (targetDepth >= atlas.maxDepth) return false;
    newParent = target;
    newParentId = targetId;
    insertIndex = newParent.items.length;
  } else if (targetType === 'topic') {
    const target = atlas.topics[targetId];
    const targetParent = findAtlasParentInfo(atlas, targetId);
    if (!target || !targetParent || !targetParent.parentId || getAtlasRootTopicId(atlas, targetId) !== currentAtlasTopicId) return false;
    newParentId = targetParent.parentId;
    newParent = atlas.topics[newParentId];
    insertIndex = findAtlasTopicItemIndex(newParent, 'topic', targetId);
    if (position === 'after') insertIndex += 1;
  } else if (targetType === 'tab') {
    const targetParent = findAtlasTabParent(atlas, targetId);
    if (!targetParent || getAtlasRootTopicId(atlas, targetParent.id) !== currentAtlasTopicId) return false;
    newParent = targetParent;
    newParentId = targetParent.id;
    insertIndex = findAtlasTopicItemIndex(newParent, 'tab', targetId);
    if (position === 'after') insertIndex += 1;
  } else {
    return false;
  }

  if (!newParent || insertIndex < 0 || draggedSubtreeIds.includes(newParent.id)) return false;
  const newDepth = getAtlasTopicDepth(atlas, newParentId) + 1;
  const subtreeHeight = getAtlasTopicSubtreeHeight(atlas, draggedId);
  if (newDepth + subtreeHeight - 1 > atlas.maxDepth) return false;

  const siblingDuplicate = atlasSiblingTopics(atlas, newParentId).some(topic =>
    topic.id !== draggedId && normalizeAtlasNameKey(topic.name) === normalizeAtlasNameKey(dragged.name)
  );
  if (siblingDuplicate) return false;

  const oldItemIndex = findAtlasTopicItemIndex(oldParentTopic, 'topic', draggedId);
  if (oldParentTopic === newParent && oldItemIndex >= 0 && oldItemIndex < insertIndex) insertIndex -= 1;
  removeAtlasTopicItem(oldParentTopic, 'topic', draggedId);
  insertAtlasTopicItem(newParent, 'topic', draggedId, insertIndex);
  const timestamp = nowIso();
  dragged.updatedAt = timestamp;
  touchAtlasTopicBranch(atlas, newParentId, timestamp);
  if (oldParent.parentId !== newParentId) touchAtlasTopicBranch(atlas, oldParent.parentId, timestamp);
  await saveTabAtlas(atlas);
  return true;
}

async function moveAtlasTabSource(draggedId, targetType, targetId, position = 'inside') {
  if (!draggedId || !targetId) return false;
  const atlas = await getTabAtlas();
  const tab = atlas.tabs[draggedId];
  const oldParent = findAtlasTabParent(atlas, draggedId);
  if (!tab || !oldParent || getAtlasRootTopicId(atlas, oldParent.id) !== currentAtlasTopicId) return false;

  let newParent = null;
  let insertIndex = -1;
  if (targetType === 'topic' && position === 'inside') {
    newParent = atlas.topics[targetId];
    if (!newParent || getAtlasRootTopicId(atlas, targetId) !== currentAtlasTopicId) return false;
    insertIndex = newParent.items.length;
  } else if (targetType === 'topic') {
    const targetParent = findAtlasParentInfo(atlas, targetId);
    if (!targetParent || !targetParent.parentId || getAtlasRootTopicId(atlas, targetId) !== currentAtlasTopicId) return false;
    newParent = atlas.topics[targetParent.parentId];
    insertIndex = findAtlasTopicItemIndex(newParent, 'topic', targetId);
    if (position === 'after') insertIndex += 1;
  } else if (targetType === 'tab') {
    const targetParent = findAtlasTabParent(atlas, targetId);
    if (!targetParent || getAtlasRootTopicId(atlas, targetParent.id) !== currentAtlasTopicId) return false;
    newParent = targetParent;
    insertIndex = findAtlasTopicItemIndex(newParent, 'tab', targetId);
    if (position === 'after') insertIndex += 1;
  }

  if (!newParent || insertIndex < 0) return false;
  const duplicate = newParent.tabIds.some(id => id !== draggedId && atlas.tabs[id] && getComparableAtlasUrl(atlas.tabs[id].url) === getComparableAtlasUrl(tab.url));
  if (duplicate) return false;

  const oldIndex = findAtlasTopicItemIndex(oldParent, 'tab', draggedId);
  if (oldParent.id === newParent.id && oldIndex >= 0 && oldIndex < insertIndex) insertIndex -= 1;
  removeAtlasTopicItem(oldParent, 'tab', draggedId);
  insertAtlasTopicItem(newParent, 'tab', draggedId, insertIndex);
  const timestamp = nowIso();
  tab.updatedAt = timestamp;
  touchAtlasTopicBranch(atlas, oldParent.id, timestamp);
  touchAtlasTopicBranch(atlas, newParent.id, timestamp);
  await saveTabAtlas(atlas);
  return true;
}

async function moveAtlasRootTopic(draggedId, targetId, position = 'after') {
  if (!draggedId || !targetId || draggedId === targetId) return false;
  const atlas = await getTabAtlas();
  if (!atlas.topics[draggedId] || !atlas.topics[targetId]) return false;
  if (!atlas.rootTopicIds.includes(draggedId) || !atlas.rootTopicIds.includes(targetId)) return false;

  const nextRootIds = atlas.rootTopicIds.filter(topicId => topicId !== draggedId);
  let insertIndex = nextRootIds.indexOf(targetId);
  if (insertIndex < 0) return false;
  if (position === 'after') insertIndex += 1;
  nextRootIds.splice(insertIndex, 0, draggedId);
  atlas.rootTopicIds = nextRootIds;
  await saveTabAtlas(atlas);
  return true;
}

async function getTabTree() {
  const store = await getTabOutStore();
  return normalizeTabTree(store.data.tabTree);
}

async function saveTabTree(tree) {
  await updateTabOutStore(store => {
    store.data.tabTree = normalizeTabTree(tree);
  });
}

async function isTabTreeEnabled() {
  const store = await getTabOutStore();
  return !!(store.features && store.features.tabTree && store.features.tabTree.enabled);
}

async function setTabTreeEnabled(enabled) {
  await updateTabOutStore(store => {
    store.features.tabTree = { ...(store.features.tabTree || {}), enabled: !!enabled };
  });
}

async function getThemePreference() {
  const store = await getTabOutStore();
  return normalizeThemePreference(store.settings && store.settings.theme);
}

async function setThemePreference(theme) {
  let nextTheme = 'system';
  await updateTabOutStore(store => {
    store.settings = {
      ...(store.settings || {}),
      theme: normalizeThemePreference(theme),
    };
    nextTheme = store.settings.theme;
  });
  applyThemePreference(nextTheme);
}

function findTreeParent(tree, nodeId) {
  for (const node of Object.values(tree.nodes)) {
    if (node.type === 'folder' && node.children.includes(nodeId)) return node;
  }
  return null;
}

function isTreeRootId(nodeId) {
  return nodeId === 'root';
}

async function addTreeFolder(parentId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Enter a folder name');

  const tree = await getTabTree();
  if (!isTreeRootId(parentId)) throw new Error('Folders can only be created at the top level');
  const parent = tree.nodes[parentId];
  if (!parent || parent.type !== 'folder') throw new Error('Folder not found');

  const id = createTreeNodeId();
  const timestamp = nowIso();
  tree.nodes[id] = {
    id,
    type: 'folder',
    name: trimmed,
    children: [],
    expanded: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  parent.children.push(id);
  parent.expanded = true;
  parent.updatedAt = timestamp;
  await saveTabTree(tree);
}

async function updateTreeFolder(nodeId, name) {
  if (nodeId === 'root') throw new Error('Root folder cannot be renamed');
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Enter a folder name');

  const tree = await getTabTree();
  const node = tree.nodes[nodeId];
  if (!node || node.type !== 'folder') throw new Error('Folder not found');
  node.name = trimmed;
  node.updatedAt = nowIso();
  await saveTabTree(tree);
}

function normalizeTreeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Enter a URL');

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Enter a valid URL');
  }

  if (!TAB_TREE_ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error('That URL type is not supported');
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
  if (!folder || folder.type !== 'folder') throw new Error('Folder not found');
  if (isTreeRootId(folderId)) throw new Error('Choose a folder before adding a tab');

  const trimmedName = (name || '').trim() || displayNameFromTreeUrl(normalizedUrl);
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

  const id = createTreeNodeId();
  tree.nodes[id] = {
    id,
    type: 'tab',
    name: trimmedName,
    url: normalizedUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  folder.children.push(id);
  folder.expanded = true;
  folder.updatedAt = timestamp;
  return tree.nodes[id];
}

function getUrlProtocol(url) {
  try { return new URL(url).protocol; }
  catch { return ''; }
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

function isGenericFetchedTitle(title, url) {
  const cleanTitleText = stripTitleNoise(title || '').trim();
  if (!cleanTitleText) return true;

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const path = parsed.pathname || '/';
    const host = parsed.hostname.replace(/^www\./, '');
    const friendly = friendlyDomain(parsed.hostname);
    const titleLower = cleanTitleText.toLowerCase();
    const genericProductTitles = [
      'doc',
      'docs',
      'document',
      'wiki',
      'lark',
      'lark docs',
      'feishu',
      '飞书',
      '飞书文档',
      '飞书云文档',
      'loading',
      'loading...',
    ];
    const genericNames = [
      parsed.hostname,
      host,
      friendly,
      host.replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, ''),
    ].filter(Boolean).map(value => value.toLowerCase());

    return path !== '/' && (
      genericNames.includes(titleLower) ||
      genericProductTitles.includes(titleLower)
    );
  } catch {
    return false;
  }
}

async function fetchTitleWithTemporaryTab(url) {
  const protocol = getUrlProtocol(url);
  if (!['http:', 'https:'].includes(protocol)) {
    return { title: displayNameFromTreeUrl(url), url };
  }
  const isLikelyDocumentApp = (() => {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname.endsWith('larkoffice.com') ||
        parsed.hostname.endsWith('feishu.cn') ||
        parsed.pathname.startsWith('/wiki/') ||
        parsed.pathname.startsWith('/docx/') ||
        parsed.pathname.startsWith('/doc/')
      );
    } catch {
      return false;
    }
  })();

  let tempTab = null;
  let listener = null;
  let timeoutId = null;
  let settleTimeoutId = null;
  let pollIntervalId = null;

  try {
    tempTab = await chrome.tabs.create({ url, active: false });
    const tabId = tempTab.id;

    const result = await new Promise(resolve => {
      let resolved = false;
      let latestTitle = tempTab.title || '';
      let latestUrl = tempTab.url || url;
      let pageComplete = false;

      const finish = async () => {
        if (resolved) return;
        resolved = true;
        try {
          const latest = await chrome.tabs.get(tabId);
          const finalUrl = latest.url || latestUrl || url;
          const finalTitle = stripTitleNoise(latest.title || latestTitle || '');
          resolve({
            title: finalTitle && !isGenericFetchedTitle(finalTitle, finalUrl)
              ? finalTitle
              : displayNameFromTreeUrl(finalUrl),
            url: finalUrl,
          });
        } catch {
          const fallbackTitle = stripTitleNoise(latestTitle || '');
          const fallbackUrl = latestUrl || url;
          resolve({
            title: fallbackTitle && !isGenericFetchedTitle(fallbackTitle, fallbackUrl)
              ? fallbackTitle
              : displayNameFromTreeUrl(fallbackUrl),
            url: fallbackUrl,
          });
        }
      };

      const scheduleFinish = (delay = 650) => {
        if (settleTimeoutId) clearTimeout(settleTimeoutId);
        settleTimeoutId = setTimeout(finish, delay);
      };

      const pollLatestTitle = async () => {
        if (resolved) return;
        try {
          const latest = await chrome.tabs.get(tabId);
          latestTitle = latest.title || latestTitle;
          latestUrl = latest.url || latestUrl;
          if (latest.status === 'complete') pageComplete = true;
          if (
            latestTitle &&
            !isGenericFetchedTitle(latestTitle, latestUrl) &&
            (!isLikelyDocumentApp || pageComplete)
          ) {
            scheduleFinish(isLikelyDocumentApp ? 900 : 650);
          }
        } catch {
          // The tab may already be gone; the normal timeout path will settle.
        }
      };

      listener = (updatedTabId, changeInfo, tabInfo) => {
        if (updatedTabId !== tabId) return;
        latestTitle = changeInfo.title || tabInfo.title || latestTitle;
        latestUrl = tabInfo.url || latestUrl;

        if (changeInfo.status === 'complete') {
          pageComplete = true;
          if (!isLikelyDocumentApp || !isGenericFetchedTitle(latestTitle, latestUrl)) {
            scheduleFinish(isLikelyDocumentApp ? 900 : 650);
          }
          return;
        }

        if (
          latestTitle &&
          !isGenericFetchedTitle(latestTitle, latestUrl) &&
          (!isLikelyDocumentApp || pageComplete)
        ) {
          scheduleFinish(isLikelyDocumentApp ? 1400 : 850);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
      if (isLikelyDocumentApp) {
        pollIntervalId = setInterval(pollLatestTitle, 500);
      }
      timeoutId = setTimeout(finish, isLikelyDocumentApp ? 15000 : 4500);
      if (tempTab.title && !isGenericFetchedTitle(tempTab.title, tempTab.url || url)) {
        scheduleFinish(isLikelyDocumentApp ? 1400 : 850);
      }
    });

    return result;
  } catch (err) {
    console.warn('[tab-out] Could not fetch page title:', err);
    return { title: displayNameFromTreeUrl(url), url };
  } finally {
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    if (timeoutId) clearTimeout(timeoutId);
    if (settleTimeoutId) clearTimeout(settleTimeoutId);
    if (pollIntervalId) clearInterval(pollIntervalId);
    if (tempTab && tempTab.id) {
      try { await chrome.tabs.remove(tempTab.id); }
      catch (err) { console.warn('[tab-out] Could not close temporary title tab:', err); }
    }
  }
}

async function addTreeTab(parentId, name, url) {
  const normalizedUrl = normalizeTreeUrl(url);
  const tree = await getTabTree();
  upsertTreeTabInFolder(tree, parentId, name, normalizedUrl);
  await saveTabTree(tree);
}

async function updateTreeTab(nodeId, name, url) {
  const normalizedUrl = normalizeTreeUrl(url);
  const trimmedName = (name || '').trim() || displayNameFromTreeUrl(normalizedUrl);
  const tree = await getTabTree();
  const node = tree.nodes[nodeId];
  if (!node || node.type !== 'tab') throw new Error('Tab not found');
  node.name = trimmedName;
  node.url = normalizedUrl;
  node.updatedAt = nowIso();
  await saveTabTree(tree);
}

function collectTreeSubtreeIds(tree, nodeId, ids = []) {
  const node = tree.nodes[nodeId];
  if (!node) return ids;
  ids.push(nodeId);
  if (node.type === 'folder') {
    node.children.forEach(childId => collectTreeSubtreeIds(tree, childId, ids));
  }
  return ids;
}

async function deleteTreeNode(nodeId) {
  if (nodeId === 'root') throw new Error('Root folder cannot be deleted');
  const tree = await getTabTree();
  const node = tree.nodes[nodeId];
  if (!node) throw new Error('Node not found');
  const parent = findTreeParent(tree, nodeId);
  if (parent) parent.children = parent.children.filter(childId => childId !== nodeId);
  const ids = collectTreeSubtreeIds(tree, nodeId);
  ids.forEach(id => delete tree.nodes[id]);
  await saveTabTree(tree);
}

async function toggleTreeFolder(nodeId) {
  const tree = await getTabTree();
  const node = tree.nodes[nodeId];
  if (!node || node.type !== 'folder') return;
  node.expanded = nodeId === 'root' ? true : !node.expanded;
  node.updatedAt = nowIso();
  await saveTabTree(tree);
}

async function moveTreeNode(draggedId, targetId, position = 'inside') {
  if (!draggedId || draggedId === 'root' || draggedId === targetId) return false;
  const tree = await getTabTree();
  const dragged = tree.nodes[draggedId];
  const target = tree.nodes[targetId];
  if (!dragged || !target) return false;

  const oldParent = findTreeParent(tree, draggedId);
  if (!oldParent) return false;
  const oldIndex = oldParent.children.indexOf(draggedId);

  let newParent = null;
  let insertIndex = -1;

  if (dragged.type === 'folder') {
    if (oldParent.id !== 'root') return false;
    if (target.type !== 'folder' || targetId === 'root' || position === 'inside') return false;
    newParent = tree.nodes.root;
    insertIndex = newParent.children.indexOf(targetId);
    if (insertIndex < 0) return false;
    if (position === 'after') insertIndex += 1;
  } else {
    if (targetId === 'root') return false;
    if (target.type === 'folder') {
      if (position !== 'inside') return false;
      newParent = target;
      insertIndex = target.children.length;
      target.expanded = true;
    } else {
      newParent = findTreeParent(tree, targetId);
      if (!newParent || newParent.id === 'root') return false;
      insertIndex = newParent.children.indexOf(targetId);
      if (insertIndex < 0) return false;
      if (position === 'after') insertIndex += 1;
    }
  }

  oldParent.children = oldParent.children.filter(id => id !== draggedId);
  if (oldParent.id === newParent.id) {
    if (oldIndex >= 0 && oldIndex < insertIndex) insertIndex -= 1;
    if (insertIndex > oldParent.children.length) insertIndex = oldParent.children.length;
  }
  newParent.children.splice(Math.max(0, insertIndex), 0, draggedId);
  const timestamp = nowIso();
  oldParent.updatedAt = timestamp;
  newParent.updatedAt = timestamp;
  dragged.updatedAt = timestamp;
  await saveTabTree(tree);
  return true;
}

function getTreeNodeIcon(node) {
  if (node.type === 'folder') return node.expanded ? '▾' : '▸';
  return '↗';
}

function treeNodeMatches(node, query) {
  if (!query) return true;
  const haystack = `${node.name || ''} ${node.url || ''}`.toLowerCase();
  return haystack.includes(query);
}

function getVisibleTreeIds(tree, query) {
  if (!query) return null;
  const visible = new Set(['root']);

  function visit(id, ancestors) {
    const node = tree.nodes[id];
    if (!node) return false;
    const selfMatches = treeNodeMatches(node, query);
    let childMatches = false;
    if (node.type === 'folder') {
      for (const childId of node.children) {
        if (visit(childId, [...ancestors, id])) childMatches = true;
      }
    }
    if (selfMatches || childMatches) {
      ancestors.forEach(ancestorId => visible.add(ancestorId));
      visible.add(id);
      return true;
    }
    return false;
  }

  visit('root', []);
  return visible;
}

function renderTreeNode(tree, nodeId, depth, query, visibleIds) {
  const node = tree.nodes[nodeId];
  if (!node || (visibleIds && !visibleIds.has(nodeId))) return '';

  const isFolder = node.type === 'folder';
  const rowClasses = ['tab-tree-row', isFolder ? 'folder' : 'tab'];

  const safeId = escapeHtml(node.id);
  const safeName = escapeHtml(node.name || '');
  const safeUrl = escapeHtml(node.url || '');
  const indent = Math.min(depth * 22, 220);
  const showChildren = isFolder && (query || node.expanded);
  const childHtml = showChildren
    ? node.children.map(childId => renderTreeNode(tree, childId, depth + 1, query, visibleIds)).join('')
    : '';

  const addButton = isFolder
    ? `<button class="tree-icon-btn" type="button" data-action="add-tree-child" data-parent-id="${safeId}" title="Add tab">+</button>`
    : '';
  const editAction = isFolder ? 'edit-tree-folder' : 'edit-tree-tab';
  const editButton = `<button class="tree-icon-btn" type="button" data-action="${editAction}" data-node-id="${safeId}" title="Edit">✎</button>`;
  const deleteButton = `<button class="tree-icon-btn danger" type="button" data-action="delete-tree-node" data-node-id="${safeId}" title="Delete">×</button>`;
  const urlMeta = !isFolder && node.url ? `<span class="tree-url">${safeUrl}</span>` : '';
  const titleAction = isFolder ? 'toggle-tree-folder' : 'open-tree-tab';

  return `
    <div class="tab-tree-node" data-node-id="${safeId}">
      <div class="${rowClasses.join(' ')}" style="--tree-indent:${indent}px" draggable="true" data-node-id="${safeId}" data-node-type="${node.type}">
        <button class="tree-toggle" type="button" data-action="${titleAction}" data-node-id="${safeId}" title="${isFolder ? 'Expand or collapse' : 'Open tab'}">${getTreeNodeIcon(node)}</button>
        <button class="tree-title" type="button" data-action="${titleAction}" data-node-id="${safeId}" title="${safeUrl || safeName}">
          <span>${safeName}</span>
          ${urlMeta}
        </button>
        <div class="tree-row-actions">
          ${addButton}
          ${editButton}
          ${deleteButton}
        </div>
      </div>
      ${childHtml}
    </div>`;
}

async function renderTabTree() {
  const surface = document.getElementById('tabTreeSurface');
  const disabled = document.getElementById('tabTreeDisabled');
  const search = document.getElementById('tabTreeSearch');
  if (!surface || !disabled) return;

  const enabled = await isTabTreeEnabled();
  if (!enabled) {
    disabled.style.display = 'block';
    surface.style.display = 'none';
    return;
  }

  disabled.style.display = 'none';
  surface.style.display = 'block';
  if (search && search.value !== tabTreeSearchQuery) search.value = tabTreeSearchQuery;

  const tree = await getTabTree();
  const query = tabTreeSearchQuery.trim().toLowerCase();
  const visibleIds = getVisibleTreeIds(tree, query);
  const root = tree.nodes.root;
  const rendered = root.children.map(childId => renderTreeNode(tree, childId, 0, query, visibleIds)).join('');
  const empty = root.children.length === 0 && !query
    ? `<div class="tab-tree-empty">
        <div class="tab-tree-empty-title">Start with a folder.</div>
        <div class="tab-tree-empty-subtitle">This tree is for links you want nearby, without making bookmarks feel official.</div>
        <div class="tab-tree-empty-actions">
          <button class="action-btn primary" type="button" data-action="add-tree-folder" data-parent-id="root">Add folder</button>
        </div>
      </div>`
    : '';
  const noResults = query && visibleIds.size <= 1
    ? `<div class="tab-tree-empty"><div class="tab-tree-empty-title">No matching nodes.</div></div>`
    : '';

  surface.innerHTML = rendered + empty + noResults;
}

function countAtlasDescendantTopics(atlas, topicId) {
  const topic = atlas.topics[topicId];
  if (!topic) return 0;
  return topic.children.reduce((count, childId) => count + 1 + countAtlasDescendantTopics(atlas, childId), 0);
}

function countAtlasTopicTabs(atlas, topicId) {
  const topic = atlas.topics[topicId];
  if (!topic) return 0;
  return topic.tabIds.length + topic.children.reduce((count, childId) => count + countAtlasTopicTabs(atlas, childId), 0);
}

function atlasTopicMatches(topic, query) {
  if (!query) return true;
  return `${topic.name || ''} ${topic.note || ''}`.toLowerCase().includes(query);
}

function atlasTabMatches(tab, query) {
  if (!query) return true;
  return `${tab.title || ''} ${tab.url || ''} ${tab.note || ''}`.toLowerCase().includes(query);
}

function atlasSubtreeMatches(atlas, topicId, query) {
  const topic = atlas.topics[topicId];
  if (!topic) return false;
  if (atlasTopicMatches(topic, query)) return true;
  if (topic.tabIds.some(tabId => atlas.tabs[tabId] && atlasTabMatches(atlas.tabs[tabId], query))) return true;
  return topic.children.some(childId => atlasSubtreeMatches(atlas, childId, query));
}

function renderAtlasHomeItem(atlas, topicId) {
  const topic = atlas.topics[topicId];
  if (!topic) return '';
  const safeId = escapeHtml(topic.id);
  const safeName = escapeHtml(topic.name);
  const safeNote = escapeHtml(topic.note || '');
  const topicCount = countAtlasDescendantTopics(atlas, topicId);
  const tabCount = countAtlasTopicTabs(atlas, topicId);
  const updated = timeAgo(topic.updatedAt);
  return `
    <div class="atlas-home-item" draggable="true" data-atlas-node-type="root-topic" data-atlas-topic-id="${safeId}" data-topic-id="${safeId}">
      <button class="atlas-home-main" type="button" data-action="open-atlas-topic" data-topic-id="${safeId}">
        <span class="atlas-home-title">${safeName}</span>
        <span class="atlas-home-note">${safeNote || 'No note yet.'}</span>
        <span class="atlas-home-meta">${topicCount} topic${topicCount !== 1 ? 's' : ''} · ${tabCount} tab${tabCount !== 1 ? 's' : ''}${updated ? ` · Updated ${escapeHtml(updated)}` : ''}</span>
      </button>
      <div class="atlas-home-actions">
        <button class="tree-icon-btn" type="button" data-action="edit-atlas-topic" data-topic-id="${safeId}" title="Edit">✎</button>
        <button class="tree-icon-btn danger" type="button" data-action="delete-atlas-topic" data-topic-id="${safeId}" title="Delete">×</button>
      </div>
    </div>`;
}

async function renderTabAtlasHome() {
  const home = document.getElementById('tabAtlasHome');
  const detail = document.getElementById('tabAtlasDetail');
  const search = document.getElementById('tabAtlasHomeSearch');
  if (!home || !detail) return;
  currentAtlasTopicId = '';
  home.style.display = 'block';
  detail.style.display = 'none';
  if (search && search.value !== tabAtlasHomeSearchQuery) search.value = tabAtlasHomeSearchQuery;

  const atlas = await getTabAtlas();
  const query = tabAtlasHomeSearchQuery.trim().toLowerCase();
  const topicIds = atlas.rootTopicIds
    .filter(topicId => atlas.topics[topicId] && atlasTopicMatches(atlas.topics[topicId], query));

  const list = document.getElementById('tabAtlasHomeList');
  if (!list) return;
  if (topicIds.length === 0 && !query) {
    list.innerHTML = `
      <div class="tab-tree-empty">
        <div class="tab-tree-empty-title">Start your first atlas.</div>
        <div class="tab-tree-empty-subtitle">Create a top-level topic, then connect the tabs that explain it.</div>
        <div class="tab-tree-empty-actions">
          <button class="action-btn primary" type="button" data-action="add-atlas-topic">Add topic</button>
        </div>
      </div>`;
    return;
  }
  if (topicIds.length === 0) {
    list.innerHTML = '<div class="tab-tree-empty"><div class="tab-tree-empty-title">No matching topics.</div></div>';
    return;
  }
  list.innerHTML = topicIds.map(topicId => renderAtlasHomeItem(atlas, topicId)).join('');
}

function renderAtlasTabSource(atlas, tabId, depth, query) {
  const tab = atlas.tabs[tabId];
  if (!tab || (query && !atlasTabMatches(tab, query))) return '';
  const safeId = escapeHtml(tab.id);
  const safeTitle = escapeHtml(tab.title || displayNameFromAtlasUrl(tab.url));
  const safeUrl = escapeHtml(tab.url || '');
  const safeNote = escapeHtml(tab.note || '');
  const indent = Math.min(depth * 22, 220);
  return `
    <div class="atlas-tab-source" style="--tree-indent:${indent}px" draggable="true" data-atlas-node-type="tab" data-tab-id="${safeId}">
      <button class="tree-toggle" type="button" data-action="open-atlas-tab" data-tab-id="${safeId}" title="Open tab">↗</button>
      <button class="atlas-tab-main" type="button" data-action="open-atlas-tab" data-tab-id="${safeId}" title="${safeUrl}">
        <span class="atlas-tab-title">${safeTitle}</span>
        <span class="tree-url">${safeUrl}</span>
        ${safeNote ? `<span class="atlas-note">${safeNote}</span>` : ''}
      </button>
      <div class="tree-row-actions">
        <button class="tree-icon-btn" type="button" data-action="edit-atlas-tab" data-tab-id="${safeId}" title="Edit">✎</button>
        <button class="tree-icon-btn danger" type="button" data-action="delete-atlas-tab" data-tab-id="${safeId}" title="Delete">×</button>
      </div>
    </div>`;
}

function renderAtlasTopicItem(atlas, item, depth, query) {
  if (!item || item.type === 'tab') return item ? renderAtlasTabSource(atlas, item.id, depth, query) : '';
  if (item.type === 'topic') return renderAtlasTopicNode(atlas, item.id, depth + 1, query);
  return '';
}

function renderAtlasTopicNode(atlas, topicId, depth, query) {
  const topic = atlas.topics[topicId];
  if (!topic) return '';
  const hasMatch = !query || atlasSubtreeMatches(atlas, topicId, query);
  if (!hasMatch) return '';

  const safeId = escapeHtml(topic.id);
  const safeName = escapeHtml(topic.name);
  const safeNote = escapeHtml(topic.note || '');
  const indent = Math.min((depth - 1) * 22, 220);
  const subtreeHeight = getAtlasTopicSubtreeHeight(atlas, topic.id);
  const showContents = !!query || topic.expanded !== false;
  const itemHtml = showContents ? topic.items.map(item => renderAtlasTopicItem(atlas, item, depth, query)).join('') : '';
  const draggable = depth > 1 ? 'true' : 'false';
  const toggleIcon = showContents ? '▾' : '▸';
  const toggleTitle = showContents ? 'Collapse topic' : 'Expand topic';

  return `
    <section class="atlas-topic-node" data-topic-id="${safeId}">
      <div class="atlas-topic-row" style="--tree-indent:${indent}px" draggable="${draggable}" data-atlas-node-type="topic" data-topic-id="${safeId}" data-topic-depth="${depth}" data-topic-subtree-height="${subtreeHeight}">
        <button class="tree-toggle" type="button" data-action="toggle-atlas-topic" data-topic-id="${safeId}" title="${toggleTitle}">${toggleIcon}</button>
        <div class="atlas-topic-main">
          <div class="atlas-topic-title-row">
            <span class="atlas-topic-level">L${depth}</span>
            <span class="atlas-topic-title">${safeName}</span>
          </div>
          ${safeNote ? `<div class="atlas-note">${safeNote}</div>` : ''}
        </div>
        <div class="tree-row-actions">
          <button class="tree-icon-btn" type="button" data-action="add-atlas-child" data-topic-id="${safeId}" title="Add">+</button>
          <button class="tree-icon-btn" type="button" data-action="edit-atlas-topic" data-topic-id="${safeId}" title="Edit">✎</button>
          <button class="tree-icon-btn danger" type="button" data-action="delete-atlas-topic" data-topic-id="${safeId}" title="Delete">×</button>
        </div>
      </div>
      ${itemHtml ? `<div class="atlas-item-list">${itemHtml}</div>` : ''}
    </section>`;
}

async function renderTabAtlasDetail(topicId = currentAtlasTopicId) {
  const home = document.getElementById('tabAtlasHome');
  const detail = document.getElementById('tabAtlasDetail');
  const detailTitle = document.getElementById('tabAtlasDetailTitle');
  const detailNote = document.getElementById('tabAtlasDetailNote');
  const surface = document.getElementById('tabAtlasDetailSurface');
  const search = document.getElementById('tabAtlasDetailSearch');
  if (!home || !detail || !surface) return;

  const atlas = await getTabAtlas();
  const topic = atlas.topics[topicId];
  if (!topic || !atlas.rootTopicIds.includes(topicId)) {
    await showTabAtlasHomeView({ updateHash: true });
    return;
  }

  currentAtlasTopicId = topicId;
  home.style.display = 'none';
  detail.style.display = 'block';
  if (detailTitle) detailTitle.textContent = topic.name;
  if (detailNote) detailNote.textContent = topic.note || '';
  if (search && search.value !== tabAtlasDetailSearchQuery) search.value = tabAtlasDetailSearchQuery;

  const query = tabAtlasDetailSearchQuery.trim().toLowerCase();
  const rendered = renderAtlasTopicNode(atlas, topicId, 1, query);
  surface.innerHTML = rendered || '<div class="tab-tree-empty"><div class="tab-tree-empty-title">No matching nodes.</div></div>';
}

async function renderTabAtlas() {
  if (!await isTabAtlasEnabled()) {
    const disabled = document.getElementById('tabAtlasDisabled');
    const shell = document.getElementById('tabAtlasShell');
    if (disabled) disabled.style.display = 'block';
    if (shell) shell.style.display = 'none';
    return;
  }

  const disabled = document.getElementById('tabAtlasDisabled');
  const shell = document.getElementById('tabAtlasShell');
  if (disabled) disabled.style.display = 'none';
  if (shell) shell.style.display = 'block';
  if (currentAtlasTopicId) await renderTabAtlasDetail(currentAtlasTopicId);
  else await renderTabAtlasHome();
}

async function renderAppShell() {
  const tabTreeEnabled = await isTabTreeEnabled();
  const tabAtlasEnabled = await isTabAtlasEnabled();
  const treeNav = document.getElementById('tabTreeNavButton');
  const atlasNav = document.getElementById('tabAtlasNavButton');
  if (treeNav) treeNav.style.display = tabTreeEnabled ? 'inline-flex' : 'none';
  if (atlasNav) atlasNav.style.display = tabAtlasEnabled ? 'inline-flex' : 'none';

  if (!tabTreeEnabled && currentView === 'tab-tree') {
    await showDashboardView({ updateHash: true });
    return;
  }
  if (!tabAtlasEnabled && currentView === 'tab-atlas') {
    await showDashboardView({ updateHash: true });
    return;
  }

  document.querySelectorAll('.app-nav-item').forEach(btn => btn.classList.remove('active'));
  const activeId = currentView === 'tab-tree'
    ? 'tabTreeNavButton'
    : currentView === 'tab-atlas'
      ? 'tabAtlasNavButton'
      : 'dashboardNavButton';
  const active = document.getElementById(activeId);
  if (active) active.classList.add('active');
}

async function showDashboardView(options = {}) {
  currentView = 'dashboard';
  currentAtlasTopicId = '';
  const dashboard = document.getElementById('dashboardView');
  const tabTree = document.getElementById('tabTreeView');
  const tabAtlas = document.getElementById('tabAtlasView');
  if (dashboard) dashboard.style.display = 'block';
  if (tabTree) tabTree.style.display = 'none';
  if (tabAtlas) tabAtlas.style.display = 'none';
  if (options.updateHash !== false) history.replaceState(null, '', location.pathname);
  await renderAppShell();
  await renderDashboard();
}

async function showTabTreeView(options = {}) {
  if (!await isTabTreeEnabled()) {
    showToast('Tab Stash is turned off');
    await showDashboardView({ updateHash: true });
    return;
  }
  currentView = 'tab-tree';
  currentAtlasTopicId = '';
  const dashboard = document.getElementById('dashboardView');
  const tabTree = document.getElementById('tabTreeView');
  const tabAtlas = document.getElementById('tabAtlasView');
  if (dashboard) dashboard.style.display = 'none';
  if (tabTree) tabTree.style.display = 'block';
  if (tabAtlas) tabAtlas.style.display = 'none';
  if (options.updateHash !== false) history.replaceState(null, '', '#tab-tree');
  await renderAppShell();
  await renderTabTree();
}

async function showTabAtlasHomeView(options = {}) {
  if (!await isTabAtlasEnabled()) {
    showToast('Tab Atlas is turned off');
    await showDashboardView({ updateHash: true });
    return;
  }
  currentView = 'tab-atlas';
  currentAtlasTopicId = '';
  const dashboard = document.getElementById('dashboardView');
  const tabTree = document.getElementById('tabTreeView');
  const tabAtlas = document.getElementById('tabAtlasView');
  if (dashboard) dashboard.style.display = 'none';
  if (tabTree) tabTree.style.display = 'none';
  if (tabAtlas) tabAtlas.style.display = 'block';
  if (options.updateHash !== false) history.replaceState(null, '', '#tab-atlas');
  await renderAppShell();
  await renderTabAtlasHome();
}

async function showTabAtlasDetailView(topicId, options = {}) {
  if (!await isTabAtlasEnabled()) {
    showToast('Tab Atlas is turned off');
    await showDashboardView({ updateHash: true });
    return;
  }
  currentView = 'tab-atlas';
  const nextTopicId = topicId || '';
  if (currentAtlasTopicId !== nextTopicId) tabAtlasDetailSearchQuery = '';
  currentAtlasTopicId = nextTopicId;
  const dashboard = document.getElementById('dashboardView');
  const tabTree = document.getElementById('tabTreeView');
  const tabAtlas = document.getElementById('tabAtlasView');
  if (dashboard) dashboard.style.display = 'none';
  if (tabTree) tabTree.style.display = 'none';
  if (tabAtlas) tabAtlas.style.display = 'block';
  if (options.updateHash !== false) history.replaceState(null, '', `#tab-atlas/${encodeURIComponent(currentAtlasTopicId)}`);
  await renderAppShell();
  await renderTabAtlasDetail(currentAtlasTopicId);
}

async function initializeApp() {
  const store = await getTabOutStore();
  applyThemePreference(store.settings && store.settings.theme);
  renderDashboardChrome();
  if (location.hash === '#tab-tree' && await isTabTreeEnabled()) {
    await showTabTreeView({ updateHash: false });
    return;
  }
  if (location.hash === '#tab-atlas' && await isTabAtlasEnabled()) {
    await showTabAtlasHomeView({ updateHash: false });
    return;
  }
  if (location.hash.startsWith('#tab-atlas/') && await isTabAtlasEnabled()) {
    const topicId = decodeURIComponent(location.hash.replace('#tab-atlas/', ''));
    await showTabAtlasDetailView(topicId, { updateHash: false });
    return;
  }
  await showDashboardView({ updateHash: false });
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    if (await getThemePreference() === 'system') applyThemePreference('system');
  });
}

function setTreeTabError(message) {
  const errorEl = document.getElementById('treeTabError');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function updateTreeNodeModalUi() {
  const nameGroup = document.getElementById('treeTabNameGroup');
  const nameLabel = document.getElementById('treeTabNameLabel');
  const urlGroup = document.getElementById('treeTabUrlGroup');
  const submit = document.getElementById('treeTabSubmitButton');
  const title = document.getElementById('treeTabModalTitle');
  const modeInput = document.getElementById('treeTabModeInput');
  const typeInput = document.getElementById('treeNodeTypeInput');
  const mode = modeInput ? modeInput.value : 'add';
  const type = typeInput && typeInput.value === 'folder' ? 'folder' : 'tab';
  const isEdit = mode === 'edit';
  const isTab = type === 'tab';

  if (urlGroup) urlGroup.style.display = isTab ? 'block' : 'none';
  if (nameGroup) nameGroup.style.display = (!isTab || mode !== 'add') ? 'block' : 'none';
  if (nameLabel) nameLabel.textContent = isTab ? 'Name' : 'Folder name';
  if (submit) submit.textContent = isTab && mode === 'add' ? 'Continue' : 'Save';
  if (title) {
    if (isEdit) title.textContent = isTab ? 'Edit tab' : 'Edit folder';
    else title.textContent = isTab ? 'Add tab' : 'Add folder';
  }
}

function openTreeNodeModal(mode, parentId, node = null, type = 'tab') {
  const modal = document.getElementById('treeTabModal');
  const modeInput = document.getElementById('treeTabModeInput');
  const typeInput = document.getElementById('treeNodeTypeInput');
  const parentInput = document.getElementById('treeTabParentInput');
  const nodeInput = document.getElementById('treeTabNodeInput');
  const urlInput = document.getElementById('treeTabUrlInput');
  const nameInput = document.getElementById('treeTabNameInput');
  if (!modal || !modeInput || !typeInput || !parentInput || !nodeInput || !urlInput || !nameInput) return;

  let nodeType = node ? node.type : type;
  if (!node && mode !== 'edit') {
    nodeType = parentId === 'root' ? 'folder' : 'tab';
  }
  modeInput.value = mode === 'edit' ? 'edit' : 'add';
  typeInput.value = nodeType === 'folder' ? 'folder' : 'tab';
  parentInput.value = parentId || 'root';
  nodeInput.value = node && node.id ? node.id : '';
  urlInput.value = node && node.url ? node.url : '';
  nameInput.value = node && node.name ? node.name : '';
  nameInput.placeholder = nodeType === 'folder' ? 'Research' : 'Page title';
  updateTreeNodeModalUi();
  setTreeTabError('');
  modal.style.display = 'flex';
  setTimeout(() => {
    const focusEl = nodeType === 'folder' ? nameInput : urlInput;
    focusEl.focus();
    focusEl.select();
  }, 0);
}

function openTreeTabModal(mode, parentId, node = null) {
  openTreeNodeModal(mode, parentId, node, 'tab');
}

function openTreeFolderModal(mode, parentId, node = null) {
  openTreeNodeModal(mode, parentId, node, 'folder');
}

function closeTreeTabModal() {
  const modal = document.getElementById('treeTabModal');
  const form = document.getElementById('treeTabForm');
  if (!modal || !form) return;
  modal.style.display = 'none';
  form.reset();
  const modeInput = document.getElementById('treeTabModeInput');
  const typeInput = document.getElementById('treeNodeTypeInput');
  if (modeInput) modeInput.value = 'add';
  if (typeInput) typeInput.value = 'tab';
  updateTreeNodeModalUi();
  setTreeTabError('');
}

async function prepareTreeTabConfirmation() {
  const modeInput = document.getElementById('treeTabModeInput');
  const urlInput = document.getElementById('treeTabUrlInput');
  const nameInput = document.getElementById('treeTabNameInput');
  const submit = document.getElementById('treeTabSubmitButton');
  if (!modeInput || !urlInput || !nameInput || !submit) return;

  let normalizedUrl;
  try {
    normalizedUrl = normalizeTreeUrl(urlInput.value);
  } catch (err) {
    setTreeTabError(err.message || 'Enter a valid URL');
    return;
  }

  setTreeTabError('');
  submit.disabled = true;
  submit.textContent = 'Fetching title...';

  const result = await fetchTitleWithTemporaryTab(normalizedUrl);
  urlInput.value = result.url || normalizedUrl;
  nameInput.value = result.title || displayNameFromTreeUrl(result.url || normalizedUrl);
  modeInput.value = 'confirm';
  updateTreeNodeModalUi();
  submit.disabled = false;
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 0);
}

async function saveTreeTabFromModal() {
  const modeInput = document.getElementById('treeTabModeInput');
  const parentInput = document.getElementById('treeTabParentInput');
  const nodeInput = document.getElementById('treeTabNodeInput');
  const urlInput = document.getElementById('treeTabUrlInput');
  const nameInput = document.getElementById('treeTabNameInput');
  if (!modeInput || !parentInput || !nodeInput || !urlInput || !nameInput) return;

  try {
    if (modeInput.value === 'edit') {
      await updateTreeTab(nodeInput.value, nameInput.value, urlInput.value);
      showToast('Tab updated');
    } else {
      await addTreeTab(parentInput.value || 'root', nameInput.value, urlInput.value);
      showToast('Tab added');
    }
    closeTreeTabModal();
    await renderTabTree();
  } catch (err) {
    setTreeTabError(err && err.message ? err.message : 'Could not save tab');
  }
}

async function saveTreeFolderFromModal() {
  const modeInput = document.getElementById('treeTabModeInput');
  const parentInput = document.getElementById('treeTabParentInput');
  const nodeInput = document.getElementById('treeTabNodeInput');
  const nameInput = document.getElementById('treeTabNameInput');
  if (!modeInput || !parentInput || !nodeInput || !nameInput) return;

  try {
    if (modeInput.value === 'edit') {
      await updateTreeFolder(nodeInput.value, nameInput.value);
      showToast('Folder updated');
    } else {
      await addTreeFolder(parentInput.value || 'root', nameInput.value);
      showToast('Folder added');
    }
    closeTreeTabModal();
    await renderTabTree();
  } catch (err) {
    setTreeTabError(err && err.message ? err.message : 'Could not save folder');
  }
}

function setAtlasAddError(message) {
  const errorEl = document.getElementById('atlasAddError');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function getAtlasAddType() {
  const input = document.getElementById('atlasAddTypeInput');
  return input && input.value === 'topic' ? 'topic' : 'tab';
}

function updateAtlasAddModalUi() {
  const type = getAtlasAddType();
  const modeInput = document.getElementById('atlasAddModeInput');
  const tabFields = document.getElementById('atlasAddTabFields');
  const topicFields = document.getElementById('atlasAddTopicFields');
  const titleGroup = document.getElementById('atlasAddTitleGroup');
  const submit = document.getElementById('atlasAddSubmitButton');
  const title = document.getElementById('atlasAddModalTitle');
  const tabButton = document.getElementById('atlasAddTabTypeButton');
  const topicButton = document.getElementById('atlasAddTopicTypeButton');
  const mode = modeInput ? modeInput.value : 'add';

  if (tabFields) tabFields.style.display = type === 'tab' ? 'block' : 'none';
  if (topicFields) topicFields.style.display = type === 'topic' ? 'block' : 'none';
  if (titleGroup) titleGroup.style.display = type === 'tab' && mode !== 'add' ? 'block' : 'none';
  if (submit) submit.textContent = type === 'tab' && mode === 'add' ? 'Continue' : 'Save';
  if (title) title.textContent = type === 'topic' ? 'Add topic' : 'Add tab';
  if (tabButton) tabButton.classList.toggle('active', type === 'tab');
  if (topicButton) topicButton.classList.toggle('active', type === 'topic');
}

function selectAtlasAddType(type) {
  const modal = document.getElementById('atlasAddModal');
  const typeInput = document.getElementById('atlasAddTypeInput');
  const modeInput = document.getElementById('atlasAddModeInput');
  const canAddTopic = modal ? modal.dataset.canAddTopic === 'true' : true;
  if (!typeInput || !modeInput) return;

  if (type === 'topic' && !canAddTopic) {
    setAtlasAddError('Maximum topic depth reached');
    return;
  }

  typeInput.value = type === 'topic' ? 'topic' : 'tab';
  modeInput.value = 'add';
  setAtlasAddError('');
  updateAtlasAddModalUi();
  const focusEl = typeInput.value === 'topic'
    ? document.getElementById('atlasAddTopicNameInput')
    : document.getElementById('atlasAddUrlInput');
  if (focusEl) {
    focusEl.focus();
    focusEl.select();
  }
}

async function openAtlasAddModal(topicId) {
  const modal = document.getElementById('atlasAddModal');
  const topicInput = document.getElementById('atlasAddTopicInput');
  const typeInput = document.getElementById('atlasAddTypeInput');
  const modeInput = document.getElementById('atlasAddModeInput');
  const form = document.getElementById('atlasAddForm');
  const topicButton = document.getElementById('atlasAddTopicTypeButton');
  if (!modal || !topicInput || !typeInput || !modeInput || !form) return;

  const atlas = await getTabAtlas();
  const topic = atlas.topics[topicId];
  if (!topic) {
    showToast('Topic not found');
    return;
  }

  const depth = getAtlasTopicDepth(atlas, topicId);
  const canAddTopic = depth > 0 && depth < atlas.maxDepth;
  form.reset();
  topicInput.value = topicId;
  typeInput.value = 'tab';
  modeInput.value = 'add';
  modal.dataset.canAddTopic = canAddTopic ? 'true' : 'false';
  if (topicButton) {
    topicButton.classList.toggle('disabled', !canAddTopic);
    topicButton.setAttribute('aria-disabled', canAddTopic ? 'false' : 'true');
  }
  setAtlasAddError('');
  updateAtlasAddModalUi();
  modal.style.display = 'flex';
  setTimeout(() => {
    const urlInput = document.getElementById('atlasAddUrlInput');
    if (urlInput) {
      urlInput.focus();
      urlInput.select();
    }
  }, 0);
}

function closeAtlasAddModal() {
  const modal = document.getElementById('atlasAddModal');
  const form = document.getElementById('atlasAddForm');
  if (!modal || !form) return;
  modal.style.display = 'none';
  form.reset();
  modal.dataset.canAddTopic = 'true';
  const typeInput = document.getElementById('atlasAddTypeInput');
  const modeInput = document.getElementById('atlasAddModeInput');
  if (typeInput) typeInput.value = 'tab';
  if (modeInput) modeInput.value = 'add';
  setAtlasAddError('');
  updateAtlasAddModalUi();
}

async function prepareAtlasAddTabConfirmation() {
  const modeInput = document.getElementById('atlasAddModeInput');
  const urlInput = document.getElementById('atlasAddUrlInput');
  const titleInput = document.getElementById('atlasAddTitleInput');
  const submit = document.getElementById('atlasAddSubmitButton');
  if (!modeInput || !urlInput || !titleInput || !submit) return;

  let normalizedUrl;
  try {
    normalizedUrl = normalizeTreeUrl(urlInput.value);
  } catch (err) {
    setAtlasAddError(err.message || 'Enter a valid URL');
    return;
  }

  setAtlasAddError('');
  submit.disabled = true;
  submit.textContent = 'Fetching title...';
  const result = await fetchTitleWithTemporaryTab(normalizedUrl);
  urlInput.value = result.url || normalizedUrl;
  titleInput.value = result.title || displayNameFromAtlasUrl(result.url || normalizedUrl);
  modeInput.value = 'confirm';
  updateAtlasAddModalUi();
  submit.disabled = false;
  setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);
}

async function saveAtlasAddTabFromModal() {
  const topicInput = document.getElementById('atlasAddTopicInput');
  const urlInput = document.getElementById('atlasAddUrlInput');
  const titleInput = document.getElementById('atlasAddTitleInput');
  const noteInput = document.getElementById('atlasAddTabNoteInput');
  if (!topicInput || !urlInput || !titleInput || !noteInput) return;

  try {
    await addAtlasTabSource(topicInput.value, titleInput.value, urlInput.value, noteInput.value);
    closeAtlasAddModal();
    if (currentView === 'tab-atlas') await renderTabAtlasDetail(currentAtlasTopicId);
    showToast('Tab added');
  } catch (err) {
    setAtlasAddError(err && err.message ? err.message : 'Could not save tab');
  }
}

async function saveAtlasAddTopicFromModal() {
  const topicInput = document.getElementById('atlasAddTopicInput');
  const nameInput = document.getElementById('atlasAddTopicNameInput');
  const noteInput = document.getElementById('atlasAddTopicNoteInput');
  if (!topicInput || !nameInput || !noteInput) return;

  try {
    await addAtlasTopic(topicInput.value, nameInput.value, noteInput.value);
    closeAtlasAddModal();
    if (currentView === 'tab-atlas') await renderTabAtlasDetail(currentAtlasTopicId);
    showToast('Topic added');
  } catch (err) {
    setAtlasAddError(err && err.message ? err.message : 'Could not save topic');
  }
}

function setAtlasTopicError(message) {
  const errorEl = document.getElementById('atlasTopicError');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function openAtlasTopicModal(mode = 'add', parentId = '', topic = null) {
  const modal = document.getElementById('atlasTopicModal');
  const modeInput = document.getElementById('atlasTopicModeInput');
  const parentInput = document.getElementById('atlasTopicParentInput');
  const topicInput = document.getElementById('atlasTopicIdInput');
  const nameInput = document.getElementById('atlasTopicNameInput');
  const noteInput = document.getElementById('atlasTopicNoteInput');
  const title = document.getElementById('atlasTopicModalTitle');
  if (!modal || !modeInput || !parentInput || !topicInput || !nameInput || !noteInput) return;
  modeInput.value = mode === 'edit' ? 'edit' : 'add';
  parentInput.value = parentId || '';
  topicInput.value = topic && topic.id ? topic.id : '';
  nameInput.value = topic && topic.name ? topic.name : '';
  noteInput.value = topic && topic.note ? topic.note : '';
  if (title) title.textContent = mode === 'edit' ? 'Edit topic' : 'Add topic';
  setAtlasTopicError('');
  modal.style.display = 'flex';
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 0);
}

function closeAtlasTopicModal() {
  const modal = document.getElementById('atlasTopicModal');
  const form = document.getElementById('atlasTopicForm');
  if (!modal || !form) return;
  modal.style.display = 'none';
  form.reset();
  setAtlasTopicError('');
}

async function saveAtlasTopicFromModal() {
  const modeInput = document.getElementById('atlasTopicModeInput');
  const parentInput = document.getElementById('atlasTopicParentInput');
  const topicInput = document.getElementById('atlasTopicIdInput');
  const nameInput = document.getElementById('atlasTopicNameInput');
  const noteInput = document.getElementById('atlasTopicNoteInput');
  if (!modeInput || !parentInput || !topicInput || !nameInput || !noteInput) return;

  try {
    let createdRootTopicId = '';
    if (modeInput.value === 'edit') {
      await updateAtlasTopic(topicInput.value, nameInput.value, noteInput.value);
      showToast('Topic updated');
    } else {
      const id = await addAtlasTopic(parentInput.value || '', nameInput.value, noteInput.value);
      showToast(parentInput.value ? 'Topic added' : 'Atlas topic added');
      if (!parentInput.value) createdRootTopicId = id;
    }
    closeAtlasTopicModal();
    if (currentView === 'tab-atlas') {
      if (createdRootTopicId) await showTabAtlasDetailView(createdRootTopicId);
      else if (currentAtlasTopicId) await renderTabAtlasDetail(currentAtlasTopicId);
      else await renderTabAtlasHome();
    }
  } catch (err) {
    setAtlasTopicError(err && err.message ? err.message : 'Could not save topic');
  }
}

function setAtlasTabError(message) {
  const errorEl = document.getElementById('atlasTabError');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function updateAtlasTabModalUi() {
  const modeInput = document.getElementById('atlasTabModeInput');
  const titleGroup = document.getElementById('atlasTabTitleGroup');
  const submit = document.getElementById('atlasTabSubmitButton');
  const title = document.getElementById('atlasTabModalTitle');
  const mode = modeInput ? modeInput.value : 'add';
  if (titleGroup) titleGroup.style.display = mode === 'add' ? 'none' : 'block';
  if (submit) submit.textContent = mode === 'add' ? 'Continue' : 'Save';
  if (title) title.textContent = mode === 'edit' ? 'Edit tab' : 'Add tab';
}

function openAtlasTabModal(mode = 'add', topicId = '', tab = null) {
  const modal = document.getElementById('atlasTabModal');
  const modeInput = document.getElementById('atlasTabModeInput');
  const topicInput = document.getElementById('atlasTabTopicInput');
  const tabInput = document.getElementById('atlasTabIdInput');
  const urlInput = document.getElementById('atlasTabUrlInput');
  const titleInput = document.getElementById('atlasTabTitleInput');
  const noteInput = document.getElementById('atlasTabNoteInput');
  if (!modal || !modeInput || !topicInput || !tabInput || !urlInput || !titleInput || !noteInput) return;
  modeInput.value = mode === 'edit' ? 'edit' : 'add';
  topicInput.value = topicId || '';
  tabInput.value = tab && tab.id ? tab.id : '';
  urlInput.value = tab && tab.url ? tab.url : '';
  titleInput.value = tab && tab.title ? tab.title : '';
  noteInput.value = tab && tab.note ? tab.note : '';
  updateAtlasTabModalUi();
  setAtlasTabError('');
  modal.style.display = 'flex';
  setTimeout(() => {
    urlInput.focus();
    urlInput.select();
  }, 0);
}

function closeAtlasTabModal() {
  const modal = document.getElementById('atlasTabModal');
  const form = document.getElementById('atlasTabForm');
  if (!modal || !form) return;
  modal.style.display = 'none';
  form.reset();
  const modeInput = document.getElementById('atlasTabModeInput');
  if (modeInput) modeInput.value = 'add';
  setAtlasTabError('');
  updateAtlasTabModalUi();
}

async function prepareAtlasTabConfirmation() {
  const modeInput = document.getElementById('atlasTabModeInput');
  const urlInput = document.getElementById('atlasTabUrlInput');
  const titleInput = document.getElementById('atlasTabTitleInput');
  const submit = document.getElementById('atlasTabSubmitButton');
  if (!modeInput || !urlInput || !titleInput || !submit) return;

  let normalizedUrl;
  try {
    normalizedUrl = normalizeTreeUrl(urlInput.value);
  } catch (err) {
    setAtlasTabError(err.message || 'Enter a valid URL');
    return;
  }

  setAtlasTabError('');
  submit.disabled = true;
  submit.textContent = 'Fetching title...';
  const result = await fetchTitleWithTemporaryTab(normalizedUrl);
  urlInput.value = result.url || normalizedUrl;
  titleInput.value = result.title || displayNameFromAtlasUrl(result.url || normalizedUrl);
  modeInput.value = 'confirm';
  updateAtlasTabModalUi();
  submit.disabled = false;
  setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);
}

async function saveAtlasTabFromModal() {
  const modeInput = document.getElementById('atlasTabModeInput');
  const topicInput = document.getElementById('atlasTabTopicInput');
  const tabInput = document.getElementById('atlasTabIdInput');
  const urlInput = document.getElementById('atlasTabUrlInput');
  const titleInput = document.getElementById('atlasTabTitleInput');
  const noteInput = document.getElementById('atlasTabNoteInput');
  if (!modeInput || !topicInput || !tabInput || !urlInput || !titleInput || !noteInput) return;

  try {
    if (modeInput.value === 'edit') {
      await updateAtlasTabSource(tabInput.value, titleInput.value, urlInput.value, noteInput.value);
      showToast('Tab updated');
    } else {
      await addAtlasTabSource(topicInput.value, titleInput.value, urlInput.value, noteInput.value);
      showToast('Tab added');
    }
    closeAtlasTabModal();
    if (currentView === 'tab-atlas') await renderTabAtlasDetail(currentAtlasTopicId);
  } catch (err) {
    setAtlasTabError(err && err.message ? err.message : 'Could not save tab');
  }
}

async function openTreeTab(url) {
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    console.warn('[tab-out] Chrome blocked opening URL:', err);
    showToast('Chrome blocked opening this URL');
    try { await navigator.clipboard.writeText(url); showToast('URL copied'); }
    catch {}
  }
}

function scheduleAfterPaint(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function scheduleIdleWork(callback) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => callback(), { timeout: 300 });
    return;
  }
  setTimeout(callback, 0);
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}

function getFavoriteDisplayName(url) {
  try {
    const parsed = new URL(url);
    return friendlyDomain(parsed.hostname) || parsed.hostname || url;
  } catch {
    return url;
  }
}

function getFavoriteDisplayUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${host}${path}` || url;
  } catch {
    return url;
  }
}

function getBrowserFaviconUrl(url, size = 16) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
    faviconUrl.searchParams.set('pageUrl', parsed.toString());
    faviconUrl.searchParams.set('size', String(size));
    return faviconUrl.toString();
  } catch {
    return '';
  }
}

function getSafeInlineFaviconUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return ['data:', 'chrome-extension:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function getFavoriteFaviconUrl(url) {
  return getBrowserFaviconUrl(url, 16);
}

function getFaviconFallbackText(url, label = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const friendly = friendlyDomain(host) || host;
    if (friendly) return friendly.charAt(0).toUpperCase();
  } catch {}

  const trimmed = String(label || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

function renderSiteFavicon(url, className, label = '', options = {}) {
  const size = options.size || 16;
  const providedFaviconUrl = getSafeInlineFaviconUrl(options.favIconUrl);
  const faviconUrl = providedFaviconUrl || getBrowserFaviconUrl(url, size);
  const fallbackText = getFaviconFallbackText(url, label);
  const safeClassName = escapeHtml(className);
  const safeFallbackText = escapeHtml(fallbackText);

  const imgHtml = faviconUrl
    ? `<img class="site-favicon-img" src="${escapeHtml(faviconUrl)}" alt="" draggable="false" loading="lazy" decoding="async">`
    : '';

  return `<span class="${safeClassName} site-favicon-shell" aria-hidden="true"><span class="site-favicon-letter">${safeFallbackText}</span>${imgHtml}</span>`;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Hub pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function renderPageChip(tab, hostname, urlCounts = {}) {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), hostname);
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}

  const count = urlCounts[tab.url] || 1;
  const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const chipClass = count > 1 ? ' chip-has-dupes' : '';
  const safeUrl = escapeHtml(tab.url || '');
  const safeTitle = escapeHtml(label);
  const faviconHtml = renderSiteFavicon(tab.url, 'chip-favicon', label, {
    size: 16,
    favIconUrl: tab.favIconUrl || '',
  });
  const safeFaviconUrl = escapeHtml(tab.favIconUrl || '');
  return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconHtml}
      <span class="chip-text">${safeTitle}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" data-tab-favicon-url="${safeFaviconUrl}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
}

function buildOverflowChips(hiddenTabs, hostname, urlCounts = {}) {
  const overflowId = 'overflow-' + (++overflowChipSeq);
  overflowChipCache.set(overflowId, {
    hiddenTabs: hiddenTabs.map(tab => ({ url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl || '' })),
    hostname,
    urlCounts,
  });

  return `
    <div class="page-chips-overflow" data-overflow-id="${overflowId}" style="display:none"></div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => renderPageChip(tab, group.domain, urlCounts)).join('')
    + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), group.domain, urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   COMMON SITES — Render shortcuts + modal
   ---------------------------------------------------------------- */

function renderFavoriteItem(item) {
  const displayName = getFavoriteDisplayName(item.url);
  const displayUrl = getFavoriteDisplayUrl(item.url);
  const faviconHtml = renderSiteFavicon(item.url, 'favorite-favicon', displayName, {
    size: 18,
    favIconUrl: item.favIconUrl || getFavoriteFaviconUrl(item.url),
  });
  const safeId = escapeHtml(item.id);
  const safeUrl = escapeHtml(item.url);

  return `
    <div class="favorite-item" data-favorite-id="${safeId}" draggable="true">
      <a class="favorite-main" href="${safeUrl}" title="${safeUrl}">
        ${faviconHtml}
        <div class="favorite-text">
          <div class="favorite-name">${escapeHtml(displayName)}</div>
          <div class="favorite-url">${escapeHtml(displayUrl)}</div>
        </div>
      </a>
      <div class="favorite-actions">
        <button class="favorite-action edit" type="button" data-action="edit-favorite" data-favorite-id="${safeId}" title="Edit site" aria-label="Edit site">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
        </button>
        <button class="favorite-action delete" type="button" data-action="delete-favorite" data-favorite-id="${safeId}" title="Remove site" aria-label="Remove site">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673A2.25 2.25 0 0 1 15.916 21.75H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
        </button>
      </div>
    </div>`;
}

async function renderFavoritesSection() {
  const section = document.getElementById('favoritesSection');
  const empty = document.getElementById('favoritesEmpty');
  const grid = document.getElementById('favoritesGrid');
  if (!section || !empty || !grid) return;

  try {
    const favorites = await getFavorites();
    section.style.display = 'block';

    if (favorites.length === 0) {
      empty.style.display = 'block';
      grid.style.display = 'none';
      grid.innerHTML = '';
      return;
    }

    empty.style.display = 'none';
    grid.innerHTML = favorites.map(renderFavoriteItem).join('');
    grid.style.display = 'grid';
  } catch (err) {
    console.warn('[tab-out] Could not load favorites:', err);
    empty.style.display = 'block';
    grid.style.display = 'none';
    grid.innerHTML = '';
  }
}

function setFavoriteError(message) {
  const errorEl = document.getElementById('favoriteError');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function openFavoriteModal(mode = 'add', item = null) {
  const modal = document.getElementById('favoriteModal');
  const titleEl = document.getElementById('favoriteModalTitle');
  const idInput = document.getElementById('favoriteIdInput');
  const urlInput = document.getElementById('favoriteUrlInput');
  if (!modal || !titleEl || !idInput || !urlInput) return;

  titleEl.textContent = mode === 'edit' ? 'Edit site' : 'Add site';
  idInput.value = item && item.id ? item.id : '';
  urlInput.value = item && item.url ? item.url : '';
  setFavoriteError('');
  modal.style.display = 'flex';

  setTimeout(() => {
    urlInput.focus();
    urlInput.select();
  }, 0);
}

function closeFavoriteModal() {
  const modal = document.getElementById('favoriteModal');
  const form = document.getElementById('favoriteForm');
  const idInput = document.getElementById('favoriteIdInput');
  if (!modal || !form || !idInput) return;

  modal.style.display = 'none';
  form.reset();
  idInput.value = '';
  setFavoriteError('');
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);
  const title = item.title || item.url;
  const safeId = escapeHtml(item.id);
  const safeUrl = escapeHtml(item.url);
  const safeTitle = escapeHtml(title);
  const faviconHtml = renderSiteFavicon(item.url, 'deferred-favicon', title, {
    size: 16,
    favIconUrl: item.favIconUrl || '',
  });

  return `
    <div class="deferred-item" data-deferred-id="${safeId}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${safeId}">
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitle}">
          ${faviconHtml}
          <span class="deferred-title-text">${safeTitle}</span>
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${safeId}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
function renderDashboardChrome() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
}

async function renderMainDashboard(runId) {
  // --- Fetch tabs ---
  await fetchOpenTabs();
  if (runId !== dashboardRenderRun) return;
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  document.body.classList.toggle('reduced-motion-heavy', domainGroups.length > 10 || realTabs.length > 40);

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    const cardsHtml = domainGroups.map(g => renderDomainCard(g)).join('');
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = cardsHtml;
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Hub tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column after the main tabs paint ---
  scheduleIdleWork(() => {
    if (runId !== dashboardRenderRun) return;
    void renderDeferredColumn();
  });
}

async function renderDashboard() {
  const runId = ++dashboardRenderRun;
  renderDashboardChrome();
  await renderFavoritesSection();

  scheduleAfterPaint(() => {
    if (runId !== dashboardRenderRun) return;
    void renderMainDashboard(runId);
  });
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'show-dashboard') {
    await showDashboardView();
    return;
  }

  if (action === 'show-tab-tree') {
    await showTabTreeView();
    return;
  }

  if (action === 'show-tab-atlas') {
    await showTabAtlasHomeView();
    return;
  }

  if (action === 'open-settings-modal') {
    const modal = document.getElementById('settingsModal');
    const input = document.getElementById('tabTreeEnabledInput');
    const atlasInput = document.getElementById('tabAtlasEnabledInput');
    const themeSelect = document.getElementById('themePreferenceInput');
    if (input) input.checked = await isTabTreeEnabled();
    if (atlasInput) atlasInput.checked = await isTabAtlasEnabled();
    if (themeSelect) themeSelect.value = await getThemePreference();
    if (modal) modal.style.display = 'flex';
    return;
  }

  if (action === 'close-settings-modal') {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'none';
    return;
  }

  if (action === 'save-settings') {
    const input = document.getElementById('tabTreeEnabledInput');
    const atlasInput = document.getElementById('tabAtlasEnabledInput');
    const themeSelect = document.getElementById('themePreferenceInput');
    await setTabTreeEnabled(!!(input && input.checked));
    await setTabAtlasEnabled(!!(atlasInput && atlasInput.checked));
    await setThemePreference(themeSelect ? themeSelect.value : 'system');
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'none';
    await renderAppShell();
    if (currentView === 'tab-tree' && !(input && input.checked)) await showDashboardView();
    else if (currentView === 'tab-tree') await renderTabTree();
    else if (currentView === 'tab-atlas' && !(atlasInput && atlasInput.checked)) await showDashboardView();
    else if (currentView === 'tab-atlas') await renderTabAtlas();
    showToast('Settings saved');
    return;
  }

  if (action === 'enable-tab-tree') {
    await setTabTreeEnabled(true);
    await showTabTreeView();
    showToast('Tab Stash enabled');
    return;
  }

  if (action === 'enable-tab-atlas') {
    await setTabAtlasEnabled(true);
    await showTabAtlasHomeView();
    showToast('Tab Atlas enabled');
    return;
  }

  if (action === 'add-atlas-topic') {
    openAtlasTopicModal('add', actionEl.dataset.parentId || '', null);
    return;
  }

  if (action === 'add-atlas-child') {
    await openAtlasAddModal(actionEl.dataset.topicId || currentAtlasTopicId);
    return;
  }

  if (action === 'add-atlas-child-to-current') {
    if (!currentAtlasTopicId) return;
    await openAtlasAddModal(currentAtlasTopicId);
    return;
  }

  if (action === 'select-atlas-add-type') {
    selectAtlasAddType(actionEl.dataset.addType || 'tab');
    return;
  }

  if (action === 'close-atlas-add-modal') {
    closeAtlasAddModal();
    return;
  }

  if (action === 'open-atlas-topic') {
    await showTabAtlasDetailView(actionEl.dataset.topicId);
    return;
  }

  if (action === 'toggle-atlas-topic') {
    await toggleAtlasTopic(actionEl.dataset.topicId);
    await renderTabAtlasDetail(currentAtlasTopicId);
    return;
  }

  if (action === 'edit-current-atlas-topic') {
    const atlas = await getTabAtlas();
    const topic = atlas.topics[currentAtlasTopicId];
    if (topic) openAtlasTopicModal('edit', '', topic);
    return;
  }

  if (action === 'edit-atlas-topic') {
    const atlas = await getTabAtlas();
    const topic = atlas.topics[actionEl.dataset.topicId];
    if (topic) {
      const parent = findAtlasParentInfo(atlas, topic.id);
      openAtlasTopicModal('edit', parent ? parent.parentId : '', topic);
    }
    return;
  }

  if (action === 'delete-atlas-topic') {
    const topicId = actionEl.dataset.topicId;
    const atlas = await getTabAtlas();
    const topic = atlas.topics[topicId];
    if (!topic) return;
    const ok = window.confirm(`Delete "${topic.name}" and all of its subtopics and tabs?`);
    if (!ok) return;
    try {
      const wasCurrent = topicId === currentAtlasTopicId;
      await deleteAtlasTopic(topicId);
      if (wasCurrent) await showTabAtlasHomeView();
      else if (currentAtlasTopicId) await renderTabAtlasDetail(currentAtlasTopicId);
      else await renderTabAtlasHome();
      showToast('Topic deleted');
    } catch (err) {
      console.warn('[tab-out] Failed to delete atlas topic:', err);
      showToast('Could not delete topic');
    }
    return;
  }

  if (action === 'open-atlas-tab') {
    const atlas = await getTabAtlas();
    const tab = atlas.tabs[actionEl.dataset.tabId];
    if (tab) await openTreeTab(tab.url);
    return;
  }

  if (action === 'edit-atlas-tab') {
    const atlas = await getTabAtlas();
    const tab = atlas.tabs[actionEl.dataset.tabId];
    const parent = tab ? findAtlasTabParent(atlas, tab.id) : null;
    if (tab && parent) openAtlasTabModal('edit', parent.id, tab);
    return;
  }

  if (action === 'delete-atlas-tab') {
    const tabId = actionEl.dataset.tabId;
    const atlas = await getTabAtlas();
    const tab = atlas.tabs[tabId];
    if (!tab) return;
    const ok = window.confirm(`Delete "${tab.title || tab.url}"?`);
    if (!ok) return;
    try {
      await deleteAtlasTabSource(tabId);
      await renderTabAtlasDetail(currentAtlasTopicId);
      showToast('Tab deleted');
    } catch (err) {
      console.warn('[tab-out] Failed to delete atlas tab:', err);
      showToast('Could not delete tab');
    }
    return;
  }

  if (action === 'close-atlas-topic-modal') {
    closeAtlasTopicModal();
    return;
  }

  if (action === 'close-atlas-tab-modal') {
    closeAtlasTabModal();
    return;
  }

  if (action === 'add-tree-child') {
    const parentId = actionEl.dataset.parentId || 'root';
    openTreeNodeModal('add', parentId, null, parentId === 'root' ? 'folder' : 'tab');
    return;
  }

  if (action === 'add-tree-folder') {
    openTreeNodeModal('add', actionEl.dataset.parentId || 'root', null, 'folder');
    return;
  }

  if (action === 'add-tree-tab') {
    const parentId = actionEl.dataset.parentId || 'root';
    if (parentId === 'root') {
      showToast('Create a folder first');
      return;
    }
    openTreeNodeModal('add', parentId, null, 'tab');
    return;
  }

  if (action === 'close-tree-tab-modal') {
    closeTreeTabModal();
    return;
  }

  if (action === 'toggle-tree-folder') {
    await toggleTreeFolder(actionEl.dataset.nodeId);
    await renderTabTree();
    return;
  }

  if (action === 'open-tree-tab') {
    const tree = await getTabTree();
    const node = tree.nodes[actionEl.dataset.nodeId];
    if (node && node.type === 'tab') await openTreeTab(node.url);
    return;
  }

  if (action === 'edit-tree-folder') {
    const tree = await getTabTree();
    const node = tree.nodes[actionEl.dataset.nodeId];
    if (node && node.type === 'folder') openTreeFolderModal('edit', '', node);
    return;
  }

  if (action === 'edit-tree-tab') {
    const tree = await getTabTree();
    const node = tree.nodes[actionEl.dataset.nodeId];
    if (node && node.type === 'tab') openTreeTabModal('edit', '', node);
    return;
  }

  if (action === 'delete-tree-node') {
    const nodeId = actionEl.dataset.nodeId;
    const tree = await getTabTree();
    const node = tree.nodes[nodeId];
    if (!node || nodeId === 'root') return;

    const ok = node.type === 'folder'
      ? window.confirm(`Delete "${node.name}" and all of its tabs?`)
      : window.confirm(`Delete "${node.name}"?`);
    if (!ok) return;

    try {
      await deleteTreeNode(nodeId);
      await renderTabTree();
      showToast(node.type === 'folder' ? 'Folder deleted' : 'Tab deleted');
    } catch (err) {
      console.warn('[tab-out] Failed to delete tree node:', err);
      showToast('Could not delete node');
    }
    return;
  }

  if (action === 'open-favorite-modal') {
    openFavoriteModal('add');
    return;
  }

  if (action === 'close-favorite-modal') {
    closeFavoriteModal();
    return;
  }

  if (action === 'edit-favorite') {
    e.preventDefault();
    e.stopPropagation();
    const favoriteId = actionEl.dataset.favoriteId;
    if (!favoriteId) return;

    const favorites = await getFavorites();
    const favorite = favorites.find(item => item.id === favoriteId);
    if (!favorite) return;

    openFavoriteModal('edit', favorite);
    return;
  }

  if (action === 'delete-favorite') {
    e.preventDefault();
    e.stopPropagation();
    const favoriteId = actionEl.dataset.favoriteId;
    if (!favoriteId) return;

    try {
      await removeFavorite(favoriteId);
      await renderFavoritesSection();
      showToast('Site removed');
    } catch (err) {
      console.warn('[tab-out] Failed to remove favorite:', err);
      showToast('Could not remove site');
    }
    return;
  }

  // ---- Close duplicate Tab Hub tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Hub tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      const overflowId = overflowContainer.dataset.overflowId;
      if (overflowId && overflowContainer.childElementCount === 0) {
        const cached = overflowChipCache.get(overflowId);
        if (cached) {
          overflowContainer.innerHTML = cached.hiddenTabs
            .map(tab => renderPageChip(tab, cached.hostname, cached.urlCounts))
            .join('');
          overflowChipCache.delete(overflowId);
        }
      }
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    const tabFaviconUrl = actionEl.dataset.tabFaviconUrl || '';
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle, favIconUrl: tabFaviconUrl });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id === 'tabTreeSearch') {
    tabTreeSearchQuery = e.target.value.trim().toLowerCase();
    await renderTabTree();
    return;
  }

  if (e.target.id === 'tabAtlasHomeSearch') {
    tabAtlasHomeSearchQuery = e.target.value.trim().toLowerCase();
    await renderTabAtlasHome();
    return;
  }

  if (e.target.id === 'tabAtlasDetailSearch') {
    tabAtlasDetailSearchQuery = e.target.value.trim().toLowerCase();
    await renderTabAtlasDetail(currentAtlasTopicId);
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'atlasAddForm') {
    e.preventDefault();
    const type = getAtlasAddType();
    const modeInput = document.getElementById('atlasAddModeInput');
    if (type === 'topic') {
      await saveAtlasAddTopicFromModal();
      return;
    }
    if (modeInput && modeInput.value === 'add') {
      await prepareAtlasAddTabConfirmation();
      return;
    }
    await saveAtlasAddTabFromModal();
    return;
  }

  if (e.target.id === 'atlasTopicForm') {
    e.preventDefault();
    await saveAtlasTopicFromModal();
    return;
  }

  if (e.target.id === 'atlasTabForm') {
    e.preventDefault();
    const modeInput = document.getElementById('atlasTabModeInput');
    if (modeInput && modeInput.value === 'add') {
      await prepareAtlasTabConfirmation();
      return;
    }
    await saveAtlasTabFromModal();
    return;
  }

  if (e.target.id === 'treeTabForm') {
    e.preventDefault();
    const modeInput = document.getElementById('treeTabModeInput');
    const typeInput = document.getElementById('treeNodeTypeInput');
    if (!modeInput || !typeInput) return;

    if (typeInput.value === 'folder') {
      await saveTreeFolderFromModal();
      return;
    }

    if (modeInput.value === 'add') {
      await prepareTreeTabConfirmation();
      return;
    }

    await saveTreeTabFromModal();
    return;
  }

  if (e.target.id !== 'favoriteForm') return;
  e.preventDefault();

  const idInput = document.getElementById('favoriteIdInput');
  const urlInput = document.getElementById('favoriteUrlInput');
  if (!idInput || !urlInput) return;

  const favoriteId = idInput.value.trim();
  const isEditing = favoriteId.length > 0;

  try {
    if (isEditing) {
      await updateFavorite(favoriteId, urlInput.value);
    } else {
      await addFavorite(urlInput.value);
    }

    closeFavoriteModal();
    await renderFavoritesSection();
    showToast(isEditing ? 'Site updated' : 'Site added');
  } catch (err) {
    setFavoriteError(err && err.message ? err.message : 'Could not save site');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const favoriteModal = document.getElementById('favoriteModal');
  const settingsModal = document.getElementById('settingsModal');
  const tabModal = document.getElementById('treeTabModal');
  const atlasAddModal = document.getElementById('atlasAddModal');
  const atlasTopicModal = document.getElementById('atlasTopicModal');
  const atlasTabModal = document.getElementById('atlasTabModal');
  if (favoriteModal && favoriteModal.style.display !== 'none') closeFavoriteModal();
  if (settingsModal && settingsModal.style.display !== 'none') settingsModal.style.display = 'none';
  if (tabModal && tabModal.style.display !== 'none') closeTreeTabModal();
  if (atlasAddModal && atlasAddModal.style.display !== 'none') closeAtlasAddModal();
  if (atlasTopicModal && atlasTopicModal.style.display !== 'none') closeAtlasTopicModal();
  if (atlasTabModal && atlasTabModal.style.display !== 'none') closeAtlasTabModal();
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'favoriteModal') closeFavoriteModal();
  if (e.target && e.target.id === 'settingsModal') e.target.style.display = 'none';
  if (e.target && e.target.id === 'treeTabModal') closeTreeTabModal();
  if (e.target && e.target.id === 'atlasAddModal') closeAtlasAddModal();
  if (e.target && e.target.id === 'atlasTopicModal') closeAtlasTopicModal();
  if (e.target && e.target.id === 'atlasTabModal') closeAtlasTabModal();
});

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('site-favicon-img')) return;
  img.remove();
}, true);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[TAB_OUT_STORE_KEY]) return;
  const store = normalizeStore(changes[TAB_OUT_STORE_KEY].newValue);
  applyThemePreference(store.settings && store.settings.theme);
  void (async () => {
    await renderAppShell();
    if (currentView === 'tab-tree') await renderTabTree();
    else if (currentView === 'tab-atlas') await renderTabAtlas();
  })();
});

document.addEventListener('dragstart', (e) => {
  const atlasHomeItem = e.target.closest('.atlas-home-item');
  if (atlasHomeItem && atlasHomeItem.getAttribute('draggable') === 'true') {
    atlasDragId = atlasHomeItem.dataset.topicId || null;
    atlasDragType = 'root-topic';
    atlasDragSubtreeHeight = 1;
    atlasHomeItem.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', atlasDragId || '');
    }
    return;
  }

  const atlasTopicRow = e.target.closest('.atlas-topic-row');
  if (atlasTopicRow && atlasTopicRow.getAttribute('draggable') === 'true') {
    atlasDragId = atlasTopicRow.dataset.topicId || null;
    atlasDragType = 'topic';
    atlasDragSubtreeHeight = Math.max(1, Number(atlasTopicRow.dataset.topicSubtreeHeight || 1));
    atlasTopicRow.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', atlasDragId || '');
    }
    return;
  }

  const atlasTabRow = e.target.closest('.atlas-tab-source');
  if (atlasTabRow && atlasTabRow.getAttribute('draggable') === 'true') {
    atlasDragId = atlasTabRow.dataset.tabId || null;
    atlasDragType = 'tab';
    atlasDragSubtreeHeight = 1;
    atlasTabRow.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', atlasDragId || '');
    }
    return;
  }

  const treeRow = e.target.closest('.tab-tree-row');
  if (treeRow && treeRow.getAttribute('draggable') === 'true') {
    treeDragId = treeRow.dataset.nodeId || null;
    treeDragType = treeRow.dataset.nodeType || null;
    treeRow.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', treeDragId || '');
    }
    return;
  }

  const item = e.target.closest('.favorite-item');
  if (!item) return;

  favoriteDragId = item.dataset.favoriteId || null;
  item.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', favoriteDragId || '');
  }
});

document.addEventListener('dragover', (e) => {
  const atlasHomeItem = e.target.closest('.atlas-home-item');
  if (atlasHomeItem && atlasDragId && atlasDragType === 'root-topic') {
    const targetId = atlasHomeItem.dataset.topicId || null;
    document.querySelectorAll('.atlas-home-item.drop-before, .atlas-home-item.drop-after').forEach(el => {
      if (el !== atlasHomeItem) el.classList.remove('drop-before', 'drop-after');
    });
    if (!targetId || targetId === atlasDragId) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const rect = atlasHomeItem.getBoundingClientRect();
    const position = e.clientY - rect.top < rect.height * 0.5 ? 'before' : 'after';
    atlasHomeItem.dataset.dropPosition = position;
    atlasHomeItem.classList.remove('drop-before', 'drop-after');
    atlasHomeItem.classList.add(`drop-${position}`);
    return;
  }

  const atlasRow = e.target.closest('.atlas-topic-row, .atlas-tab-source');
  if (atlasRow && atlasDragId && (atlasDragType === 'topic' || atlasDragType === 'tab')) {
    const targetType = atlasRow.classList.contains('atlas-topic-row') ? 'topic' : 'tab';
    const targetId = targetType === 'topic' ? atlasRow.dataset.topicId : atlasRow.dataset.tabId;
    if (!targetId || targetId === atlasDragId) return;

    if (atlasDragType === 'topic' && targetType !== 'topic' && targetType !== 'tab') return;
    if (atlasDragType === 'tab' && targetType !== 'topic' && targetType !== 'tab') return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.atlas-topic-row.drop-before, .atlas-topic-row.drop-after, .atlas-topic-row.drop-inside, .atlas-tab-source.drop-before, .atlas-tab-source.drop-after, .atlas-tab-source.drop-inside').forEach(el => {
      if (el !== atlasRow) el.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });

    const rect = atlasRow.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const x = e.clientX - rect.left;
    let position = 'inside';
    if (atlasDragType === 'topic') {
      if (targetType === 'topic') {
        const targetDepth = Number(atlasRow.dataset.topicDepth || 0);
        const canNestInTarget = targetDepth + atlasDragSubtreeHeight <= TAB_ATLAS_MAX_DEPTH;
        const rootInside = targetDepth <= 1 && canNestInTarget;
        const insideThreshold = Math.min(rect.width * 0.3, 104 + Math.max(0, targetDepth - 1) * 22);
        const horizontalInside = canNestInTarget && x > insideThreshold;
        const verticalInside = canNestInTarget && y >= rect.height * 0.24 && y <= rect.height * 0.76;
        if (rootInside || horizontalInside || verticalInside) position = 'inside';
        else position = y < rect.height * 0.5 ? 'before' : 'after';
      } else {
        position = y < rect.height * 0.5 ? 'before' : 'after';
      }
    } else if (targetType === 'topic') {
      const targetDepth = Number(atlasRow.dataset.topicDepth || 0);
      const rootInside = targetDepth <= 1;
      if (rootInside) position = 'inside';
      else if (y < rect.height * 0.28) position = 'before';
      else if (y > rect.height * 0.72) position = 'after';
      else position = 'inside';
    } else if (targetType === 'tab') {
      position = y < rect.height * 0.5 ? 'before' : 'after';
    }
    atlasRow.dataset.dropPosition = position;
    atlasRow.classList.remove('drop-before', 'drop-after', 'drop-inside');
    atlasRow.classList.add(`drop-${position}`);
    return;
  }

  const treeRow = e.target.closest('.tab-tree-row');
  if (treeRow && treeDragId && treeRow.dataset.nodeId !== treeDragId) {
    document.querySelectorAll('.tab-tree-row.drop-before, .tab-tree-row.drop-after, .tab-tree-row.drop-inside').forEach(el => {
      if (el !== treeRow) el.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });

    const targetType = treeRow.dataset.nodeType || null;
    if (treeDragType === 'folder' && targetType !== 'folder') return;
    if (treeDragType === 'tab' && targetType !== 'folder' && targetType !== 'tab') return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const rect = treeRow.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let position = 'inside';
    if (treeDragType === 'folder') {
      position = y < rect.height * 0.5 ? 'before' : 'after';
    } else if (targetType === 'tab') {
      position = y < rect.height * 0.5 ? 'before' : 'after';
    }
    treeRow.dataset.dropPosition = position;
    treeRow.classList.remove('drop-before', 'drop-after', 'drop-inside');
    treeRow.classList.add(`drop-${position}`);
    return;
  }

  const item = e.target.closest('.favorite-item');
  if (!item || !favoriteDragId || item.dataset.favoriteId === favoriteDragId) return;

  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.favorite-item.drag-over').forEach(el => {
    if (el !== item) el.classList.remove('drag-over');
  });
  item.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  const atlasHomeItem = e.target.closest('.atlas-home-item');
  if (atlasHomeItem) {
    const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.atlas-home-item') : null;
    if (related !== atlasHomeItem) atlasHomeItem.classList.remove('drop-before', 'drop-after');
  }

  const atlasRow = e.target.closest('.atlas-topic-row, .atlas-tab-source');
  if (atlasRow) {
    const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.atlas-topic-row, .atlas-tab-source') : null;
    if (related !== atlasRow) atlasRow.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  const treeRow = e.target.closest('.tab-tree-row');
  if (treeRow) {
    const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.tab-tree-row') : null;
    if (related !== treeRow) treeRow.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  const item = e.target.closest('.favorite-item');
  if (!item) return;
  const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.favorite-item') : null;
  if (related !== item) item.classList.remove('drag-over');
});

document.addEventListener('dragend', () => {
  atlasDragId = null;
  atlasDragType = null;
  atlasDragSubtreeHeight = 1;
  document.querySelectorAll('.atlas-home-item, .atlas-topic-row, .atlas-tab-source').forEach(row => {
    row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-inside');
    delete row.dataset.dropPosition;
  });

  treeDragId = null;
  treeDragType = null;
  document.querySelectorAll('.tab-tree-row').forEach(row => {
    row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-inside');
    delete row.dataset.dropPosition;
  });

  favoriteDragId = null;
  document.querySelectorAll('.favorite-item').forEach(item => {
    item.classList.remove('dragging', 'drag-over');
  });
});

document.addEventListener('drop', async (e) => {
  const atlasHomeItem = e.target.closest('.atlas-home-item');
  if (atlasHomeItem && atlasDragId && atlasDragType === 'root-topic') {
    e.preventDefault();
    const targetId = atlasHomeItem.dataset.topicId || null;
    const position = atlasHomeItem.dataset.dropPosition || 'after';
    const moved = await moveAtlasRootTopic(atlasDragId, targetId, position);
    atlasDragId = null;
    atlasDragType = null;
    atlasDragSubtreeHeight = 1;
    document.querySelectorAll('.atlas-home-item').forEach(row => {
      row.classList.remove('dragging', 'drop-before', 'drop-after');
      delete row.dataset.dropPosition;
    });
    if (!moved) {
      showToast('Cannot move there');
      return;
    }
    await renderTabAtlasHome();
    showToast('Topic moved');
    return;
  }

  const atlasRow = e.target.closest('.atlas-topic-row, .atlas-tab-source');
  if (atlasRow && atlasDragId && (atlasDragType === 'topic' || atlasDragType === 'tab')) {
    e.preventDefault();
    const targetType = atlasRow.classList.contains('atlas-topic-row') ? 'topic' : 'tab';
    const targetId = targetType === 'topic' ? atlasRow.dataset.topicId : atlasRow.dataset.tabId;
    const position = atlasRow.dataset.dropPosition || 'inside';
    let moved = false;
    if (atlasDragType === 'topic') {
      moved = await moveAtlasTopic(atlasDragId, targetType, targetId, position);
    } else if (atlasDragType === 'tab') {
      moved = await moveAtlasTabSource(atlasDragId, targetType, targetId, position);
    }
    atlasDragId = null;
    atlasDragType = null;
    atlasDragSubtreeHeight = 1;
    document.querySelectorAll('.atlas-home-item, .atlas-topic-row, .atlas-tab-source').forEach(row => {
      row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-inside');
      delete row.dataset.dropPosition;
    });
    if (!moved) {
      showToast('Cannot move there');
      return;
    }
    await renderTabAtlasDetail(currentAtlasTopicId);
    showToast('Atlas updated');
    return;
  }

  const treeRow = e.target.closest('.tab-tree-row');
  if (treeRow && treeDragId) {
    e.preventDefault();
    const targetId = treeRow.dataset.nodeId;
    const position = treeRow.dataset.dropPosition || 'inside';
    const moved = await moveTreeNode(treeDragId, targetId, position);
    treeDragId = null;
    treeDragType = null;
    document.querySelectorAll('.tab-tree-row').forEach(row => {
      row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-inside');
      delete row.dataset.dropPosition;
    });
    if (!moved) {
      showToast('Cannot move there');
      return;
    }
    await renderTabTree();
    showToast('Node moved');
    return;
  }

  const item = e.target.closest('.favorite-item');
  if (!item || !favoriteDragId) return;

  e.preventDefault();
  const targetId = item.dataset.favoriteId;
  const moved = await moveFavorite(favoriteDragId, targetId);
  favoriteDragId = null;
  document.querySelectorAll('.favorite-item').forEach(el => el.classList.remove('dragging', 'drag-over'));

  if (!moved) return;
  await renderFavoritesSection();
  showToast('Order updated');
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
initializeApp();
