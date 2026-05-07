/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Hub.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 * It also owns the Tab Stash context-menu entries. Existing folders are
 * direct submenu actions; creating a new folder injects a small one-off
 * modal into the current page when Chrome allows it.
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;
const TAB_TREE_CONTEXT_MENU_ID = 'tab-out-add-current-page';
const TAB_TREE_NEW_FOLDER_MENU_ID = 'tab-out-add-current-page-new-folder';
const TAB_TREE_FOLDER_MENU_PREFIX = 'tab-out-add-current-page-folder:';
const TAB_TREE_PENDING_ADD_KEY = 'tabTreePendingAdd';
const TAB_ATLAS_CONTEXT_MENU_ID = 'tab-out-add-current-page-atlas';
const TAB_TREE_ALLOWED_PROTOCOLS = ['http:', 'https:', 'chrome:', 'chrome-extension:', 'about:', 'file:'];
const TAB_TREE_CREATE_FOLDER_MESSAGE = 'tab-out:create-folder-and-add-current-page';
const TAB_ATLAS_ADD_CURRENT_PAGE_MESSAGE = 'tab-out:add-current-page-to-atlas';
const TAB_ATLAS_MAX_DEPTH = 3;
const TAB_ATLAS_RECENT_LIMIT = 5;
const TAB_ATLAS_DEFAULT_TOPIC_NAME = 'Default';
const THEME_OPTIONS = ['system', 'light', 'dark'];

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Tab Stash context menu ────────────────────────────────────────────────────

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

function createDefaultStore() {
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
        favorites: [],
        deferred: [],
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

function createAtlasTopicId() {
  return createScopedAtlasId('topic');
}

function createAtlasSourceId() {
  return createScopedAtlasId('source');
}

function createScopedAtlasId(prefix) {
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

function insertAtlasTopicItem(topic, type, id, index = -1) {
  if (!topic) return;
  if (!Array.isArray(topic.items)) topic.items = [];
  topic.items = topic.items.filter(item => item.type !== type || item.id !== id);
  const safeIndex = index < 0 ? topic.items.length : Math.max(0, Math.min(index, topic.items.length));
  topic.items.splice(safeIndex, 0, createAtlasItem(type, id));
  syncAtlasTopicItemIndexes(topic);
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
      const key = getComparableTreeUrl(tab.url);
      if (key) latestTabIdByUrl.set(key, rawTabId);
    }

    const addedTabKeys = new Set();
    const usedChildNames = new Set();
    for (const item of rawItems) {
      if (item.type === 'tab') {
        const tab = rawTabs[item.id];
        if (!tab || typeof tab.url !== 'string') continue;
        const key = getComparableTreeUrl(tab.url);
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
  if (!store.features.tabAtlas || typeof store.features.tabAtlas !== 'object') {
    store.features.tabAtlas = { enabled: true };
  }
  if (typeof store.features.tabAtlas.enabled !== 'boolean') {
    store.features.tabAtlas.enabled = true;
  }
  store.settings.theme = normalizeThemePreference(store.settings.theme);

  const dashboard = store.data.dashboard && typeof store.data.dashboard === 'object' ? store.data.dashboard : {};
  store.data.dashboard = {
    favorites: Array.isArray(dashboard.favorites) ? dashboard.favorites : [],
    deferred: Array.isArray(dashboard.deferred) ? dashboard.deferred : [],
  };
  store.data.tabTree = normalizeTabTree(store.data.tabTree);
  store.data.tabAtlas = normalizeTabAtlas(store.data.tabAtlas);
  store.schemaVersion = TAB_OUT_STORE_VERSION;
  return store;
}

async function getTabOutStore() {
  const data = await chrome.storage.local.get(TAB_OUT_STORE_KEY);
  const store = normalizeStore(data[TAB_OUT_STORE_KEY]);
  if (!data[TAB_OUT_STORE_KEY]) await saveTabOutStore(store);
  return store;
}

async function saveTabOutStore(store) {
  const next = normalizeStore(store);
  next.meta.updatedAt = nowIso();
  await chrome.storage.local.set({ [TAB_OUT_STORE_KEY]: next });
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

function getTabDisplayTitle(tab) {
  const url = tab && tab.url ? tab.url : '';
  return stripTitleNoise(tab && tab.title ? tab.title : '') || displayNameFromTreeUrl(url);
}

function getRootFolders(store) {
  const tree = store.data.tabTree;
  const root = tree.nodes.root;
  return root.children
    .map(id => tree.nodes[id])
    .filter(node => node && node.type === 'folder');
}

function findAtlasParentInfo(atlas, topicId) {
  if (atlas.rootTopicIds.includes(topicId)) return { parentId: '', list: atlas.rootTopicIds };
  for (const topic of Object.values(atlas.topics)) {
    if (topic.children.includes(topicId)) return { parentId: topic.id, list: topic.children };
  }
  return null;
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

function getAtlasTopicOptions(store) {
  const atlas = store.data.tabAtlas;
  const rows = [];
  function visit(topicId, depth, parentId = '') {
    const topic = atlas.topics[topicId];
    if (!topic) return;
    const children = Array.isArray(topic.children)
      ? topic.children.filter(childId => atlas.topics[childId])
      : [];
    rows.push({
      id: topic.id,
      name: topic.name,
      depth,
      parentId,
      hasChildren: children.length > 0,
      note: topic.note || '',
    });
    children.forEach(childId => visit(childId, depth + 1, topic.id));
  }
  atlas.rootTopicIds.forEach(topicId => visit(topicId, 1));
  return rows;
}

function getDefaultAtlasTopicId(store, topics) {
  const atlas = store.data.tabAtlas;
  const recent = Array.isArray(atlas.recentTopicIds)
    ? atlas.recentTopicIds.find(topicId => atlas.topics[topicId])
    : '';
  return recent || (topics[0] && topics[0].id) || '';
}

function updateAtlasRecentTopics(atlas, topicId) {
  atlas.recentTopicIds = [
    topicId,
    ...(Array.isArray(atlas.recentTopicIds) ? atlas.recentTopicIds : []).filter(id => id !== topicId),
  ].filter(id => atlas.topics[id]).slice(0, TAB_ATLAS_RECENT_LIMIT);
}

function ensureDefaultAtlasRootTopic(atlas, timestamp = nowIso()) {
  const hasRootTopic = Array.isArray(atlas.rootTopicIds) && atlas.rootTopicIds.some(topicId => atlas.topics[topicId]);
  if (hasRootTopic) return '';

  const topicId = createUniqueAtlasId(atlas.topics, '', createAtlasTopicId);
  atlas.topics[topicId] = {
    id: topicId,
    name: TAB_ATLAS_DEFAULT_TOPIC_NAME,
    note: '',
    children: [],
    tabIds: [],
    items: [],
    expanded: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  atlas.rootTopicIds = [topicId];
  atlas.recentTopicIds = (Array.isArray(atlas.recentTopicIds) ? atlas.recentTopicIds : [])
    .filter(existingTopicId => atlas.topics[existingTopicId]);
  return topicId;
}

function truncateMenuTitle(title) {
  const clean = String(title || 'Untitled folder').trim() || 'Untitled folder';
  return clean.length > 55 ? `${clean.slice(0, 52)}...` : clean;
}

function contextMenuCreate(options) {
  return new Promise(resolve => {
    chrome.contextMenus.create(options, () => {
      if (chrome.runtime.lastError) {
        console.warn('[tab-out] Context menu create skipped:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

function contextMenuRemove(id) {
  return new Promise(resolve => {
    chrome.contextMenus.remove(id, () => {
      void chrome.runtime.lastError;
      // Missing menus are fine; this keeps sync idempotent across worker restarts.
      resolve();
    });
  });
}

async function syncTabTreeContextMenu() {
  try {
    await contextMenuRemove(TAB_TREE_CONTEXT_MENU_ID);
    const store = await getTabOutStore();
    if (store.features.tabTree.enabled === false) return;

    await contextMenuCreate({
      id: TAB_TREE_CONTEXT_MENU_ID,
      title: 'Add current page to Tab Stash',
      contexts: ['page'],
    });

    await contextMenuCreate({
      id: TAB_TREE_NEW_FOLDER_MENU_ID,
      parentId: TAB_TREE_CONTEXT_MENU_ID,
      title: '+ New folder...',
      contexts: ['page'],
    });

    const folders = getRootFolders(store);
    if (folders.length > 0) {
      await contextMenuCreate({
        id: `${TAB_TREE_CONTEXT_MENU_ID}-separator`,
        parentId: TAB_TREE_CONTEXT_MENU_ID,
        type: 'separator',
        contexts: ['page'],
      });
      for (const folder of folders) {
        await contextMenuCreate({
          id: `${TAB_TREE_FOLDER_MENU_PREFIX}${folder.id}`,
          parentId: TAB_TREE_CONTEXT_MENU_ID,
          title: truncateMenuTitle(folder.name),
          contexts: ['page'],
        });
      }
    } else {
      await contextMenuCreate({
        id: `${TAB_TREE_CONTEXT_MENU_ID}-empty`,
        parentId: TAB_TREE_CONTEXT_MENU_ID,
        title: 'No folders yet',
        enabled: false,
        contexts: ['page'],
      });
    }
  } catch (err) {
    console.warn('[tab-out] Failed to sync Tab Stash context menu:', err);
  }
}

async function syncTabAtlasContextMenu() {
  try {
    await contextMenuRemove(TAB_ATLAS_CONTEXT_MENU_ID);
    const store = await getTabOutStore();
    if (store.features.tabAtlas.enabled === false) return;

    await contextMenuCreate({
      id: TAB_ATLAS_CONTEXT_MENU_ID,
      title: 'Add current page to Tab Atlas',
      contexts: ['page'],
    });
  } catch (err) {
    console.warn('[tab-out] Failed to sync Tab Atlas context menu:', err);
  }
}

async function syncContextMenus() {
  await syncTabTreeContextMenu();
  await syncTabAtlasContextMenu();
}

async function storePendingTabTreeAdd(tab) {
  if (!tab || !tab.url) return;

  const pending = {
    url: tab.url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    sourceTabId: tab.id,
    capturedAt: new Date().toISOString(),
  };

  try {
    await chrome.storage.session.set({ [TAB_TREE_PENDING_ADD_KEY]: pending });
  } catch (err) {
    console.warn('[tab-out] Could not store pending Tab Stash add:', err);
    return;
  }

  return pending;
}

async function openTabTreePicker(tab, mode = '') {
  const pending = await storePendingTabTreeAdd(tab);
  if (!pending) return false;

  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`tree-picker.html${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`),
      type: 'popup',
      width: 440,
      height: mode === 'new-folder' ? 360 : 560,
      focused: true,
    });
    return true;
  } catch (err) {
    console.warn('[tab-out] Could not open Tab Stash picker:', err);
  }
  return false;
}

async function addCurrentTabToTreeFolder(tab, folderId) {
  if (!tab || !tab.url || !folderId) return;

  try {
    const normalizedUrl = normalizeTreeUrl(tab.url);
    const store = await getTabOutStore();
    if (store.features.tabTree.enabled === false) return;

    const tree = store.data.tabTree;
    upsertTreeTabInFolder(tree, folderId, getTabDisplayTitle({ ...tab, url: normalizedUrl }), normalizedUrl);

    await saveTabOutStore(store);
  } catch (err) {
    console.warn('[tab-out] Could not add current page to Tab Stash:', err);
  }
}

function upsertAtlasTabSource(atlas, topicId, title, normalizedUrl, note = '', timestamp = nowIso()) {
  const topic = atlas.topics[topicId];
  if (!topic) throw new Error('Topic not found');
  const urlKey = getComparableTreeUrl(normalizedUrl);
  const sameIds = topic.tabIds.filter(tabId => {
    const source = atlas.tabs[tabId];
    return source && getComparableTreeUrl(source.url) === urlKey;
  });
  const trimmedTitle = String(title || '').trim() || displayNameFromTreeUrl(normalizedUrl);

  if (sameIds.length > 0) {
    const keepId = sameIds[sameIds.length - 1];
    const existing = atlas.tabs[keepId];
    existing.title = trimmedTitle;
    existing.url = normalizedUrl;
    existing.note = String(note || '').trim();
    existing.updatedAt = timestamp;
    topic.items = (Array.isArray(topic.items) ? topic.items : []).filter(item =>
      item.type !== 'tab' || !sameIds.includes(item.id)
    );
    sameIds.forEach(tabId => {
      if (tabId !== keepId) delete atlas.tabs[tabId];
    });
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

async function addCurrentTabToAtlasTopic(tab, topicId, note = '', pageTitle = '') {
  if (!tab || !tab.url || !topicId) throw new Error('Missing current page or topic');
  const normalizedUrl = normalizeTreeUrl(tab.url);
  const store = await getTabOutStore();
  if (store.features.tabAtlas.enabled === false) throw new Error('Tab Atlas is turned off in Settings.');

  const atlas = store.data.tabAtlas;
  if (!atlas.topics[topicId]) throw new Error('Choose a valid topic');
  upsertAtlasTabSource(atlas, topicId, getTabDisplayTitle({ ...tab, title: pageTitle || tab.title, url: normalizedUrl }), normalizedUrl, note);
  updateAtlasRecentTopics(atlas, topicId);
  await saveTabOutStore(store);
  return { topicId };
}

async function createFolderAndAddCurrentTab(tab, folderName) {
  if (!tab || !tab.url) throw new Error('Missing current page');
  const trimmedName = String(folderName || '').trim();
  if (!trimmedName) throw new Error('Enter a folder name');

  const normalizedUrl = normalizeTreeUrl(tab.url);
  const store = await getTabOutStore();
  if (store.features.tabTree.enabled === false) throw new Error('Tab Stash is turned off');

  const tree = store.data.tabTree;
  const timestamp = nowIso();
  const folderId = createUniqueTreeNodeId(tree.nodes);
  const tabId = createUniqueTreeNodeId({ ...tree.nodes, [folderId]: true });

  tree.nodes[folderId] = {
    id: folderId,
    type: 'folder',
    name: trimmedName,
    children: [tabId],
    expanded: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  tree.nodes[tabId] = {
    id: tabId,
    type: 'tab',
    name: getTabDisplayTitle({ ...tab, url: normalizedUrl }),
    url: normalizedUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  tree.nodes.root.children.push(folderId);
  tree.nodes.root.updatedAt = timestamp;

  await saveTabOutStore(store);
  return { folderId, tabId };
}

function showTabTreeFolderModalInPage(pageTitle, themePreference) {
  const existing = document.getElementById('tab-out-tree-folder-modal-host');
  if (existing) existing.remove();
  const darkQuery = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolvedTheme = themePreference === 'dark' || (themePreference === 'system' && darkQuery) ? 'dark' : 'light';
  const theme = resolvedTheme === 'dark'
    ? {
        overlay: 'rgba(0, 0, 0, 0.56)',
        border: 'rgba(82, 73, 64, 0.95)',
        card: '#1b1815',
        input: '#151310',
        ink: '#f4eee6',
        muted: '#a79b8f',
        line: '#342f2a',
        accent: '#d58a52',
        shadow: 'rgba(0, 0, 0, 0.44)',
        soft: 'rgba(167, 155, 143, 0.12)',
        danger: '#cf7470',
      }
    : {
        overlay: 'rgba(26, 22, 19, 0.34)',
        border: 'rgba(154, 145, 138, 0.32)',
        card: '#fffdf9',
        input: '#fff',
        ink: '#1a1613',
        muted: '#9a918a',
        line: '#e8e2da',
        accent: '#c8713a',
        shadow: 'rgba(26, 22, 19, 0.22)',
        soft: 'rgba(154, 145, 138, 0.12)',
        danger: '#b35a5a',
      };

  const host = document.createElement('div');
  host.id = 'tab-out-tree-folder-modal-host';
  host.style.all = 'initial';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      background: ${theme.overlay};
    }
    .card {
      width: min(420px, calc(100vw - 36px));
      border: 1px solid ${theme.border};
      border-radius: 12px;
      background: ${theme.card};
      box-shadow: 0 22px 70px ${theme.shadow};
      color: ${theme.ink};
      padding: 20px;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .kicker {
      margin-bottom: 4px;
      color: ${theme.muted};
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 27px;
      font-style: italic;
      font-weight: 400;
      line-height: 1.05;
    }
    .close {
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: ${theme.muted};
      cursor: pointer;
      font: inherit;
      font-size: 22px;
      line-height: 1;
    }
    .close:hover {
      background: ${theme.soft};
      color: ${theme.ink};
    }
    .page {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${theme.muted};
      font-size: 12px;
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      color: ${theme.muted};
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid ${theme.line};
      border-radius: 8px;
      background: ${theme.input};
      color: ${theme.ink};
      font: inherit;
      font-size: 14px;
      padding: 11px 12px;
      outline: none;
    }
    input:focus {
      border-color: ${theme.accent};
      box-shadow: 0 0 0 3px color-mix(in srgb, ${theme.accent} 16%, transparent);
    }
    .error {
      display: none;
      margin-top: 9px;
      color: ${theme.danger};
      font-size: 12px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }
    .btn {
      min-height: 36px;
      border: 1px solid ${theme.line};
      border-radius: 7px;
      background: ${theme.card};
      color: ${theme.ink};
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      padding: 8px 14px;
    }
    .btn.primary {
      border-color: ${theme.ink};
      background: ${theme.ink};
      color: ${theme.card};
      font-weight: 700;
    }
    .btn:disabled {
      cursor: default;
      opacity: 0.55;
    }
  `;

  const wrapper = document.createElement('div');
  wrapper.className = 'backdrop';
  wrapper.innerHTML = `
    <form class="card">
      <div class="header">
        <div>
          <div class="kicker">Tab Stash</div>
          <h1>New folder</h1>
        </div>
        <button class="close" type="button" aria-label="Close">x</button>
      </div>
      <div class="page"></div>
      <label for="folderName">Folder name</label>
      <input id="folderName" type="text" autocomplete="off" spellcheck="false" placeholder="Work Later">
      <div class="error"></div>
      <div class="actions">
        <button class="btn" type="button" data-action="cancel">Cancel</button>
        <button class="btn primary" type="submit">Add</button>
      </div>
    </form>
  `;

  shadow.append(style, wrapper);

  const form = shadow.querySelector('form');
  const input = shadow.querySelector('input');
  const error = shadow.querySelector('.error');
  const page = shadow.querySelector('.page');
  const close = () => host.remove();
  const setError = message => {
    error.textContent = message || '';
    error.style.display = message ? 'block' : 'none';
  };
  const setBusy = busy => {
    shadow.querySelectorAll('button, input').forEach(el => {
      if (!el.classList.contains('close')) el.disabled = busy;
    });
  };

  page.textContent = pageTitle || location.href;
  shadow.querySelector('.close').addEventListener('click', close);
  shadow.querySelector('[data-action="cancel"]').addEventListener('click', close);
  wrapper.addEventListener('click', event => {
    if (event.target === wrapper) close();
  });
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const folderName = input.value.trim();
    if (!folderName) {
      setError('Enter a folder name');
      input.focus();
      return;
    }

    setBusy(true);
    setError('');
    chrome.runtime.sendMessage({
      type: 'tab-out:create-folder-and-add-current-page',
      folderName,
      pageTitle: document.title || pageTitle || '',
    }, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response || !response.ok) {
        setError(runtimeError ? runtimeError.message : (response && response.error) || 'Could not add page');
        setBusy(false);
        return;
      }
      close();
    });
  });

  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function showTabAtlasAddModalInPage(pageTitle, topics, selectedTopicId, themePreference) {
  const existing = document.getElementById('tab-out-atlas-add-modal-host');
  if (existing) existing.remove();
  const darkQuery = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolvedTheme = themePreference === 'dark' || (themePreference === 'system' && darkQuery) ? 'dark' : 'light';
  const theme = resolvedTheme === 'dark'
    ? {
        overlay: 'rgba(0, 0, 0, 0.56)',
        border: 'rgba(82, 73, 64, 0.95)',
        card: '#1b1815',
        input: '#151310',
        ink: '#f4eee6',
        muted: '#a79b8f',
        line: '#342f2a',
        accent: '#d58a52',
        shadow: 'rgba(0, 0, 0, 0.44)',
        soft: 'rgba(167, 155, 143, 0.12)',
        danger: '#cf7470',
        success: '#78a982',
      }
    : {
        overlay: 'rgba(26, 22, 19, 0.34)',
        border: 'rgba(154, 145, 138, 0.32)',
        card: '#fffdf9',
        input: '#fff',
        ink: '#1a1613',
        muted: '#9a918a',
        line: '#e8e2da',
        accent: '#c8713a',
        shadow: 'rgba(26, 22, 19, 0.22)',
        soft: 'rgba(154, 145, 138, 0.12)',
        danger: '#b35a5a',
        success: '#3d7a4a',
      };

  const host = document.createElement('div');
  host.id = 'tab-out-atlas-add-modal-host';
  host.style.cssText = [
    'all: initial !important',
    'position: fixed !important',
    'inset: 0 !important',
    'width: 100vw !important',
    'height: 100vh !important',
    'display: block !important',
    'z-index: 2147483647 !important',
    'pointer-events: auto !important',
    'isolation: isolate !important',
    'contain: layout style paint !important',
  ].join('; ');
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      background: ${theme.overlay};
    }
    .card {
      position: relative;
      z-index: 1;
      width: min(460px, calc(100vw - 36px));
      border: 1px solid ${theme.border};
      border-radius: 12px;
      background: ${theme.card};
      box-shadow: 0 22px 70px ${theme.shadow};
      color: ${theme.ink};
      padding: 20px;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .kicker {
      margin-bottom: 4px;
      color: ${theme.muted};
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 27px;
      font-style: italic;
      font-weight: 400;
      line-height: 1.05;
    }
    .close {
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: ${theme.muted};
      cursor: pointer;
      font: inherit;
      font-size: 22px;
      line-height: 1;
    }
    .close:hover {
      background: ${theme.soft};
      color: ${theme.ink};
    }
    .page {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${theme.muted};
      font-size: 12px;
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      color: ${theme.muted};
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .topic-trigger,
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid ${theme.line};
      border-radius: 8px;
      background: ${theme.input};
      color: ${theme.ink};
      font: inherit;
      font-size: 14px;
      padding: 10px 12px;
      outline: none;
    }
    .topic-trigger {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      text-align: left;
    }
    .topic-trigger:focus,
    .topic-picker.open .topic-trigger,
    textarea:focus {
      border-color: ${theme.accent};
      box-shadow: 0 0 0 3px color-mix(in srgb, ${theme.accent} 16%, transparent);
    }
    .topic-picker {
      position: relative;
    }
    .topic-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 6px);
      z-index: 5;
      display: none;
      max-height: 220px;
      overflow: auto;
      border: 1px solid ${theme.line};
      border-radius: 9px;
      background: ${theme.card};
      box-shadow: 0 14px 36px ${theme.shadow};
      padding: 6px 0;
    }
    .topic-picker.open .topic-menu {
      display: block;
    }
    .topic-row {
      min-height: 34px;
      display: flex;
      align-items: center;
      padding-left: calc(10px + var(--topic-indent, 0px));
      padding-right: 8px;
    }
    .topic-row[hidden] {
      display: none;
    }
    .topic-toggle,
    .topic-toggle-spacer {
      width: 16px;
      height: 30px;
      flex: 0 0 16px;
    }
    .topic-toggle {
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: ${theme.muted};
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      line-height: 1;
      padding: 0;
    }
    .topic-toggle:hover,
    .topic-toggle:focus {
      background: ${theme.soft};
      color: ${theme.ink};
      outline: none;
    }
    .topic-option {
      min-width: 0;
      min-height: 34px;
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: ${theme.ink};
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      padding: 0 8px 0 4px;
      text-align: left;
    }
    .topic-option:hover,
    .topic-option:focus {
      background: ${theme.soft};
      outline: none;
    }
    .topic-option[aria-selected="true"] {
      color: ${theme.accent};
      font-weight: 700;
    }
    .topic-check {
      width: 16px;
      flex: 0 0 16px;
      opacity: 0;
      color: ${theme.accent};
      text-align: center;
    }
    .topic-option[aria-selected="true"] .topic-check {
      opacity: 1;
    }
    textarea {
      min-height: 86px;
      resize: vertical;
      line-height: 1.42;
    }
    .field {
      margin-top: 12px;
    }
    .notice,
    .error,
    .success {
      display: none;
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.4;
    }
    .notice {
      color: ${theme.muted};
    }
    .error {
      color: ${theme.danger};
    }
    .success {
      color: ${theme.success};
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }
    .btn {
      min-height: 36px;
      border: 1px solid ${theme.line};
      border-radius: 7px;
      background: ${theme.card};
      color: ${theme.ink};
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      padding: 8px 14px;
    }
    .btn.primary {
      border-color: ${theme.ink};
      background: ${theme.ink};
      color: ${theme.card};
      font-weight: 700;
    }
    .btn:disabled,
    .topic-trigger:disabled,
    .topic-toggle:disabled,
    .topic-option:disabled,
    textarea:disabled {
      cursor: default;
      opacity: 0.55;
    }
  `;

  const safeTopics = Array.isArray(topics) ? topics : [];
  const escapeHtml = value => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const getTopicLabel = topic => `L${topic && topic.depth ? topic.depth : 1} ${topic && topic.name ? topic.name : 'Untitled topic'}`;
  const optionRows = safeTopics.map(topic => {
    const label = `L${topic.depth || 1} ${topic.name || 'Untitled topic'}`;
    const indent = (Math.max(1, Number(topic.depth || 1)) - 1) * 24;
    const hasChildren = topic.hasChildren ? 'true' : 'false';
    const toggle = topic.hasChildren
      ? `
        <button
          class="topic-toggle"
          type="button"
          aria-label="Collapse ${escapeHtml(label)}"
          aria-expanded="true"
          data-topic-id="${escapeHtml(topic.id)}"
        >v</button>
      `
      : '<span class="topic-toggle-spacer" aria-hidden="true"></span>';
    return `
      <div
        class="topic-row"
        data-topic-id="${escapeHtml(topic.id)}"
        data-parent-id="${escapeHtml(topic.parentId || '')}"
        data-depth="${Math.max(1, Number(topic.depth || 1))}"
        data-has-children="${hasChildren}"
        style="--topic-indent: ${indent}px"
      >
        ${toggle}
        <button
          class="topic-option"
          type="button"
          role="treeitem"
          aria-level="${Math.max(1, Number(topic.depth || 1))}"
          aria-selected="${topic.id === selectedTopicId ? 'true' : 'false'}"
          ${topic.hasChildren ? 'aria-expanded="true"' : ''}
          data-topic-id="${escapeHtml(topic.id)}"
        >
          <span>${escapeHtml(label)}</span>
          <span class="topic-check" aria-hidden="true">&#10003;</span>
        </button>
      </div>
    `;
  }).join('');
  const selectedTopic = safeTopics.find(topic => topic.id === selectedTopicId) || safeTopics[0] || null;
  const selectedTopicLabel = selectedTopic ? getTopicLabel(selectedTopic) : '';

  const wrapper = document.createElement('div');
  wrapper.className = 'backdrop';
  wrapper.innerHTML = `
    <form class="card">
      <div class="header">
        <div>
          <div class="kicker">Tab Atlas</div>
          <h1>Add current page</h1>
        </div>
        <button class="close" type="button" aria-label="Close">x</button>
      </div>
      <div class="page"></div>
      <div class="field">
        <label id="atlasTopicLabel">Topic</label>
        <div class="topic-picker">
          <button
            class="topic-trigger"
            type="button"
            aria-haspopup="tree"
            aria-expanded="false"
            aria-labelledby="atlasTopicLabel atlasTopicValue"
            ${safeTopics.length === 0 ? 'disabled' : ''}
          >
            <span id="atlasTopicValue">${escapeHtml(selectedTopicLabel)}</span>
            <span aria-hidden="true">v</span>
          </button>
          <div class="topic-menu" role="tree" aria-labelledby="atlasTopicLabel">${optionRows}</div>
        </div>
      </div>
      <div class="field">
        <label for="atlasNote">Note</label>
        <textarea id="atlasNote" placeholder="Why is this useful here?" ${safeTopics.length === 0 ? 'disabled' : ''}></textarea>
      </div>
      <div class="notice"></div>
      <div class="error"></div>
      <div class="success"></div>
      <div class="actions">
        <button class="btn" type="button" data-action="cancel">Cancel</button>
        <button class="btn primary" type="submit" ${safeTopics.length === 0 ? 'disabled' : ''}>Add</button>
      </div>
    </form>
  `;

  shadow.append(style, wrapper);

  const form = shadow.querySelector('form');
  const topicPicker = shadow.querySelector('.topic-picker');
  const topicButton = shadow.querySelector('.topic-trigger');
  const topicValue = shadow.querySelector('#atlasTopicValue');
  const topicRows = Array.from(shadow.querySelectorAll('.topic-row'));
  const topicToggles = Array.from(shadow.querySelectorAll('.topic-toggle'));
  const topicOptions = Array.from(shadow.querySelectorAll('.topic-option'));
  const textarea = shadow.querySelector('textarea');
  const submitButton = shadow.querySelector('.btn.primary');
  const cancelButton = shadow.querySelector('[data-action="cancel"]');
  const error = shadow.querySelector('.error');
  const success = shadow.querySelector('.success');
  const notice = shadow.querySelector('.notice');
  const page = shadow.querySelector('.page');
  const close = () => host.remove();
  const setError = message => {
    error.textContent = message || '';
    error.style.display = message ? 'block' : 'none';
    if (message) success.style.display = 'none';
  };
  const setSuccess = message => {
    success.textContent = message || '';
    success.style.display = message ? 'block' : 'none';
    if (message) error.style.display = 'none';
  };
  let currentTopicId = selectedTopic ? selectedTopic.id : '';
  const collapsedTopicIds = new Set();
  const getTopicById = topicId => safeTopics.find(topic => topic.id === topicId);
  const isTopicVisible = topic => {
    let parentId = topic && topic.parentId ? topic.parentId : '';
    while (parentId) {
      if (collapsedTopicIds.has(parentId)) return false;
      const parent = getTopicById(parentId);
      parentId = parent && parent.parentId ? parent.parentId : '';
    }
    return true;
  };
  const syncTopicTree = () => {
    topicRows.forEach(row => {
      const topic = getTopicById(row.dataset.topicId);
      const visible = isTopicVisible(topic);
      row.hidden = !visible;
      const collapsed = collapsedTopicIds.has(row.dataset.topicId);
      const toggle = row.querySelector('.topic-toggle');
      const option = row.querySelector('.topic-option');
      if (toggle) {
        toggle.textContent = collapsed ? '>' : 'v';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${getTopicLabel(topic)}`);
      }
      if (option && row.dataset.hasChildren === 'true') {
        option.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
    });
  };
  const toggleTopicBranch = topicId => {
    const topic = getTopicById(topicId);
    if (!topic || !topic.hasChildren) return;
    if (collapsedTopicIds.has(topicId)) {
      collapsedTopicIds.delete(topicId);
    } else {
      collapsedTopicIds.add(topicId);
    }
    syncTopicTree();
  };
  const getVisibleOptions = () => topicOptions.filter(option => {
    const row = option.closest('.topic-row');
    return row && !row.hidden && !option.disabled;
  });
  const setSelectedTopic = topicId => {
    const topic = getTopicById(topicId);
    if (!topic) return;
    currentTopicId = topic.id;
    topicValue.textContent = getTopicLabel(topic);
    topicOptions.forEach(option => {
      option.setAttribute('aria-selected', option.dataset.topicId === currentTopicId ? 'true' : 'false');
    });
  };
  const openTopicMenu = () => {
    if (!topicButton || topicButton.disabled) return;
    syncTopicTree();
    topicPicker.classList.add('open');
    topicButton.setAttribute('aria-expanded', 'true');
    const selectedOption = topicOptions.find(option => option.dataset.topicId === currentTopicId);
    const selectedRow = selectedOption && selectedOption.closest('.topic-row');
    if (selectedRow && !selectedRow.hidden) selectedOption.scrollIntoView({ block: 'nearest' });
  };
  const closeTopicMenu = () => {
    topicPicker.classList.remove('open');
    topicButton.setAttribute('aria-expanded', 'false');
  };
  const focusSelectedOption = () => {
    const visibleOptions = getVisibleOptions();
    const selectedOption = visibleOptions.find(option => option.dataset.topicId === currentTopicId) || visibleOptions[0];
    if (selectedOption) selectedOption.focus();
  };
  const moveTopicSelection = direction => {
    const visibleOptions = getVisibleOptions();
    if (visibleOptions.length === 0) return;
    const currentIndex = visibleOptions.findIndex(option => option.dataset.topicId === currentTopicId);
    const nextIndex = Math.max(0, Math.min(visibleOptions.length - 1, currentIndex + direction));
    const nextOption = visibleOptions[nextIndex] || visibleOptions[0];
    setSelectedTopic(nextOption.dataset.topicId);
    nextOption.focus();
  };
  const setBusy = busy => {
    if (topicButton) topicButton.disabled = busy || safeTopics.length === 0;
    topicOptions.forEach(option => { option.disabled = busy; });
    topicToggles.forEach(toggle => { toggle.disabled = busy; });
    textarea.disabled = busy || safeTopics.length === 0;
    submitButton.disabled = busy || safeTopics.length === 0;
    cancelButton.disabled = busy;
    if (busy) closeTopicMenu();
  };
  if (currentTopicId) setSelectedTopic(currentTopicId);
  syncTopicTree();

  page.textContent = pageTitle || location.href;
  if (safeTopics.length === 0) {
    notice.textContent = 'Topic list could not be prepared. Try again.';
    notice.style.display = 'block';
  }

  shadow.querySelector('.close').addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  wrapper.addEventListener('click', event => {
    if (event.target === wrapper) {
      close();
      return;
    }
    if (!event.target.closest('.topic-picker')) closeTopicMenu();
  });
  topicButton.addEventListener('click', event => {
    event.stopPropagation();
    if (topicPicker.classList.contains('open')) {
      closeTopicMenu();
    } else {
      openTopicMenu();
    }
  });
  topicButton.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openTopicMenu();
      focusSelectedOption();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (topicPicker.classList.contains('open')) {
        closeTopicMenu();
      } else {
        openTopicMenu();
        focusSelectedOption();
      }
    }
  });
  topicToggles.forEach(toggle => {
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      toggleTopicBranch(toggle.dataset.topicId);
    });
    toggle.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleTopicBranch(toggle.dataset.topicId);
    });
  });
  topicOptions.forEach(option => {
    option.addEventListener('click', event => {
      event.stopPropagation();
      setSelectedTopic(option.dataset.topicId);
      closeTopicMenu();
      topicButton.focus();
    });
    option.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveTopicSelection(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveTopicSelection(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setSelectedTopic(option.dataset.topicId);
        closeTopicMenu();
        topicButton.focus();
      } else if (event.key === 'ArrowRight') {
        const topic = getTopicById(option.dataset.topicId);
        if (topic && topic.hasChildren && collapsedTopicIds.has(topic.id)) {
          event.preventDefault();
          collapsedTopicIds.delete(topic.id);
          syncTopicTree();
        }
      } else if (event.key === 'ArrowLeft') {
        const topic = getTopicById(option.dataset.topicId);
        if (topic && topic.hasChildren && !collapsedTopicIds.has(topic.id)) {
          event.preventDefault();
          collapsedTopicIds.add(topic.id);
          syncTopicTree();
        }
      }
    });
  });
  shadow.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (topicPicker.classList.contains('open')) {
      closeTopicMenu();
      topicButton.focus();
      return;
    }
    close();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!currentTopicId) {
      setError('Choose a topic');
      topicButton.focus();
      return;
    }
    setBusy(true);
    setError('');
    chrome.runtime.sendMessage({
      type: 'tab-out:add-current-page-to-atlas',
      topicId: currentTopicId,
      note: textarea.value || '',
      pageTitle: document.title || pageTitle || '',
    }, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response || !response.ok) {
        setError(runtimeError ? runtimeError.message : (response && response.error) || 'Could not add this page to Tab Atlas');
        setBusy(false);
        return;
      }
      setSuccess('Added to Tab Atlas');
      setTimeout(close, 380);
    });
  });

  setTimeout(() => {
    if (topicButton && !topicButton.disabled) topicButton.focus();
  }, 0);
}

async function openInlineNewFolderModal(tab) {
  if (!tab || !tab.id) return false;
  const url = tab.url || '';
  if (
    url.startsWith('about:') ||
    url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') ||
    url.startsWith('edge:') ||
    url.startsWith('brave:')
  ) {
    return false;
  }
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return false;
  }
  try {
    const store = await getTabOutStore();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showTabTreeFolderModalInPage,
      args: [getTabDisplayTitle(tab), store.settings && store.settings.theme],
    });
    return true;
  } catch (err) {
    console.warn('[tab-out] Could not inject Tab Stash folder modal:', err);
    return false;
  }
}

function canInjectIntoTab(tab) {
  if (!tab || !tab.id) return false;
  const url = tab.url || '';
  return !(
    url.startsWith('about:') ||
    url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') ||
    url.startsWith('edge:') ||
    url.startsWith('brave:')
  );
}

async function openInlineAtlasAddModal(tab) {
  if (!canInjectIntoTab(tab)) return false;
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return false;
  try {
    let store = await getTabOutStore();
    if (store.features.tabAtlas.enabled === false) return false;
    if (ensureDefaultAtlasRootTopic(store.data.tabAtlas)) {
      store = await saveTabOutStore(store);
    }
    const topics = getAtlasTopicOptions(store);
    const selectedTopicId = getDefaultAtlasTopicId(store, topics);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showTabAtlasAddModalInPage,
      args: [getTabDisplayTitle(tab), topics, selectedTopicId, store.settings && store.settings.theme],
    });
    return true;
  } catch (err) {
    console.warn('[tab-out] Could not inject Tab Atlas modal:', err);
    return false;
  }
}

async function openNewFolderFlow(tab) {
  const injected = await openInlineNewFolderModal(tab);
  if (injected) return;

  const openedPicker = await openTabTreePicker(tab, 'new-folder');
  if (openedPicker) return;

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('tree-picker.html?mode=new-folder'),
      active: true,
    });
  } catch (err) {
    console.warn('[tab-out] Could not open any Tab Stash new-folder UI:', err);
  }
}

async function openAtlasAddFlow(tab) {
  const injected = await openInlineAtlasAddModal(tab);
  if (!injected) {
    console.warn('[tab-out] Could not open Tab Atlas modal on this page.');
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  syncContextMenus();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  syncContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === TAB_ATLAS_CONTEXT_MENU_ID) {
    openAtlasAddFlow(tab);
    return;
  }

  if (info.menuItemId === TAB_TREE_NEW_FOLDER_MENU_ID) {
    openNewFolderFlow(tab);
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(TAB_TREE_FOLDER_MENU_PREFIX)) {
    const folderId = info.menuItemId.slice(TAB_TREE_FOLDER_MENU_PREFIX.length);
    addCurrentTabToTreeFolder(tab, folderId);
    return;
  }

  if (info.menuItemId === TAB_TREE_CONTEXT_MENU_ID) {
    openTabTreePicker(tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === TAB_ATLAS_ADD_CURRENT_PAGE_MESSAGE) {
    const tab = {
      ...(sender && sender.tab ? sender.tab : {}),
      title: message.pageTitle || (sender && sender.tab && sender.tab.title) || '',
    };

    addCurrentTabToAtlasTopic(tab, message.topicId, message.note || '', message.pageTitle || '')
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({
        ok: false,
        error: err && err.message ? err.message : 'Could not add this page to Tab Atlas',
      }));

    return true;
  }

  if (message.type !== TAB_TREE_CREATE_FOLDER_MESSAGE) return false;

  const tab = {
    ...(sender && sender.tab ? sender.tab : {}),
    title: message.pageTitle || (sender && sender.tab && sender.tab.title) || '',
  };

  createFolderAndAddCurrentTab(tab, message.folderName)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({
      ok: false,
      error: err && err.message ? err.message : 'Could not add page',
    }));

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[TAB_OUT_STORE_KEY]) {
    syncContextMenus();
  }
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
syncContextMenus();
