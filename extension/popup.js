'use strict';

const TAB_OUT_STORE_KEY = 'tabOutStore';
const TAB_OUT_STORE_VERSION = 1;
const EXPORT_FORMAT = 'tab-hub-backup';
const EXPORT_FORMAT_VERSION = 1;
const TAB_ATLAS_MAX_DEPTH = 3;
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

function createDefaultTabAtlas() {
  return {
    schemaVersion: 1,
    maxDepth: TAB_ATLAS_MAX_DEPTH,
    rootTopicIds: [],
    topics: {},
    tabs: {},
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

function insertAtlasTopicItem(topic, type, id) {
  if (!topic) return;
  if (!Array.isArray(topic.items)) topic.items = [];
  topic.items = topic.items.filter(item => item.type !== type || item.id !== id);
  topic.items.push(createAtlasItem(type, id));
  syncAtlasTopicItemIndexes(topic);
}

function createUniqueAtlasId(collection, prefix, preferredId) {
  if (preferredId && !collection[preferredId]) return preferredId;
  let id = createScopedId(prefix);
  while (collection[id]) id = createScopedId(prefix);
  return id;
}

function normalizeTabAtlas(raw) {
  const fallback = createDefaultTabAtlas();
  if (!raw || typeof raw !== 'object') return fallback;

  const rawTopics = raw.topics && typeof raw.topics === 'object' ? raw.topics : {};
  const rawTabs = raw.tabs && typeof raw.tabs === 'object' ? raw.tabs : {};
  const topics = {};
  const tabs = {};
  const visitedTopics = new Set();
  const maxDepth = TAB_ATLAS_MAX_DEPTH;

  function cloneTab(rawTabId) {
    const tab = rawTabs[rawTabId];
    if (!tab || typeof tab !== 'object' || typeof tab.url !== 'string') return '';
    const id = createUniqueAtlasId(tabs, 'source', rawTabId);
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

    const id = createUniqueAtlasId(topics, 'topic', rawTopicId);
    const timestamp = topic.updatedAt || topic.createdAt || nowIso();
    topics[id] = {
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

    const rawItems = getRawAtlasTopicItems(topic);
    const tabIds = rawItems.filter(item => item.type === 'tab').map(item => item.id);
    const latestByUrl = new Map();
    for (const tabId of tabIds) {
      const tab = rawTabs[tabId];
      if (!tab || typeof tab.url !== 'string') continue;
      const key = normalizeImportUrlKey(tab.url);
      if (key) latestByUrl.set(key, tabId);
    }
    const addedKeys = new Set();

    const usedChildNames = new Set();
    for (const item of rawItems) {
      if (item.type === 'tab') {
        const tab = rawTabs[item.id];
        if (!tab || typeof tab.url !== 'string') continue;
        const key = normalizeImportUrlKey(tab.url);
        if (!key || addedKeys.has(key) || latestByUrl.get(key) !== item.id) continue;
        const cloned = cloneTab(item.id);
        if (cloned) {
          topics[id].items.push(createAtlasItem('tab', cloned));
          addedKeys.add(key);
        }
      } else if (depth < maxDepth) {
        const cloned = cloneTopic(item.id, depth + 1, usedChildNames);
        if (cloned) topics[id].items.push(createAtlasItem('topic', cloned));
      }
    }
    syncAtlasTopicItemIndexes(topics[id]);
    return id;
  }

  const rootTopicIds = [];
  const usedRootNames = new Set();
  const roots = Array.isArray(raw.rootTopicIds) ? raw.rootTopicIds.filter(id => typeof id === 'string') : [];
  for (const rootId of roots) {
    const cloned = cloneTopic(rootId, 1, usedRootNames);
    if (cloned) rootTopicIds.push(cloned);
  }

  return {
    schemaVersion: 1,
    maxDepth,
    rootTopicIds,
    topics,
    tabs,
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
  const atlas = normalized.data.tabAtlas || createDefaultTabAtlas();
  const folders = tree.nodes.root.children.filter(id => tree.nodes[id] && tree.nodes[id].type === 'folder');
  const treeTabs = folders.reduce((count, folderId) => {
    const folder = tree.nodes[folderId];
    return count + folder.children.filter(childId => tree.nodes[childId] && tree.nodes[childId].type === 'tab').length;
  }, 0);
  const atlasTopics = Object.keys(atlas.topics || {}).length;
  const atlasTabs = Object.keys(atlas.tabs || {}).length;

  return {
    favorites: dashboard.favorites.length,
    savedTabs: dashboard.deferred.filter(item => item && !item.dismissed).length,
    folders: folders.length,
    treeTabs,
    atlasTopics,
    atlasTabs,
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

function upsertImportedAtlasTab(atlas, targetTopic, importedTab, stats) {
  if (!importedTab || typeof importedTab.url !== 'string') return;
  const urlKey = normalizeImportUrlKey(importedTab.url);
  if (!urlKey) return;

  const sameIds = targetTopic.tabIds.filter(tabId => {
    const tab = atlas.tabs[tabId];
    return tab && normalizeImportUrlKey(tab.url) === urlKey;
  });
  const timestamp = importedTab.updatedAt || nowIso();
  const title = String(importedTab.title || importedTab.name || importedTab.url || 'Untitled tab');

  if (sameIds.length > 0) {
    const keepId = sameIds[sameIds.length - 1];
    const existing = atlas.tabs[keepId];
    existing.title = title;
    existing.url = String(importedTab.url);
    existing.note = String(importedTab.note || '');
    existing.updatedAt = timestamp;
    targetTopic.tabIds = targetTopic.tabIds.filter(tabId => {
      if (tabId === keepId) return false;
      if (sameIds.includes(tabId)) {
        delete atlas.tabs[tabId];
        return false;
      }
      return true;
    });
    targetTopic.items = (Array.isArray(targetTopic.items) ? targetTopic.items : []).filter(item =>
      item.type !== 'tab' || !sameIds.includes(item.id)
    );
    insertAtlasTopicItem(targetTopic, 'tab', keepId);
    targetTopic.updatedAt = timestamp;
    stats.atlasTabsUpdated += 1;
    return;
  }

  const id = createUniqueAtlasId(atlas.tabs, 'source', importedTab.id);
  atlas.tabs[id] = {
    id,
    title,
    url: String(importedTab.url),
    note: String(importedTab.note || ''),
    createdAt: importedTab.createdAt || timestamp,
    updatedAt: timestamp,
  };
  insertAtlasTopicItem(targetTopic, 'tab', id);
  targetTopic.updatedAt = timestamp;
  stats.atlasTabsAdded += 1;
}

function mergeAtlasTopicChildren(targetAtlas, importedAtlas, targetTopic, importedTopic, stats) {
  const childByName = new Map();
  for (const childId of targetTopic.children) {
    const child = targetAtlas.topics[childId];
    if (!child) continue;
    const key = normalizeNameKey(child.name);
    if (key && !childByName.has(key)) childByName.set(key, childId);
  }

  const importedItems = Array.isArray(importedTopic.items) && importedTopic.items.length > 0
    ? importedTopic.items
    : [
        ...importedTopic.tabIds.map(id => createAtlasItem('tab', id)),
        ...importedTopic.children.map(id => createAtlasItem('topic', id)),
      ];

  for (const item of importedItems) {
    if (!item || item.type === 'tab') {
      if (item) upsertImportedAtlasTab(targetAtlas, targetTopic, importedAtlas.tabs[item.id], stats);
      continue;
    }

    if (item.type !== 'topic') continue;
    const importedChild = importedAtlas.topics[item.id];
    if (!importedChild) continue;
    const key = normalizeNameKey(importedChild.name);
    let targetChildId = key ? childByName.get(key) : '';
    if (!targetChildId) {
      targetChildId = createUniqueAtlasId(targetAtlas.topics, 'topic', importedChild.id);
      targetAtlas.topics[targetChildId] = {
        id: targetChildId,
        name: String(importedChild.name || 'Untitled topic'),
        note: String(importedChild.note || ''),
        children: [],
        tabIds: [],
        items: [],
        expanded: typeof importedChild.expanded === 'boolean' ? importedChild.expanded : true,
        createdAt: importedChild.createdAt || nowIso(),
        updatedAt: importedChild.updatedAt || importedChild.createdAt || nowIso(),
      };
      if (key) childByName.set(key, targetChildId);
      stats.atlasTopicsAdded += 1;
    } else {
      const targetChild = targetAtlas.topics[targetChildId];
      targetChild.note = String(importedChild.note || targetChild.note || '');
      targetChild.updatedAt = importedChild.updatedAt || targetChild.updatedAt || nowIso();
    }
    insertAtlasTopicItem(targetTopic, 'topic', targetChildId);
    mergeAtlasTopicChildren(targetAtlas, importedAtlas, targetAtlas.topics[targetChildId], importedChild, stats);
  }
}

function mergeTabAtlas(targetStore, importedStore, stats) {
  const targetAtlas = normalizeTabAtlas(targetStore.data.tabAtlas);
  const importedAtlas = normalizeTabAtlas(importedStore.data.tabAtlas);
  const rootByName = new Map();

  for (const topicId of targetAtlas.rootTopicIds) {
    const topic = targetAtlas.topics[topicId];
    if (!topic) continue;
    const key = normalizeNameKey(topic.name);
    if (key && !rootByName.has(key)) rootByName.set(key, topicId);
  }

  for (const importedRootId of importedAtlas.rootTopicIds) {
    const importedTopic = importedAtlas.topics[importedRootId];
    if (!importedTopic) continue;
    const key = normalizeNameKey(importedTopic.name);
    let targetTopicId = key ? rootByName.get(key) : '';
    if (!targetTopicId) {
      targetTopicId = createUniqueAtlasId(targetAtlas.topics, 'topic', importedTopic.id);
      targetAtlas.topics[targetTopicId] = {
        id: targetTopicId,
        name: String(importedTopic.name || 'Untitled topic'),
        note: String(importedTopic.note || ''),
        children: [],
        tabIds: [],
        items: [],
        expanded: typeof importedTopic.expanded === 'boolean' ? importedTopic.expanded : true,
        createdAt: importedTopic.createdAt || nowIso(),
        updatedAt: importedTopic.updatedAt || importedTopic.createdAt || nowIso(),
      };
      targetAtlas.rootTopicIds.push(targetTopicId);
      if (key) rootByName.set(key, targetTopicId);
      stats.atlasTopicsAdded += 1;
    } else {
      const targetTopic = targetAtlas.topics[targetTopicId];
      targetTopic.note = String(importedTopic.note || targetTopic.note || '');
      targetTopic.updatedAt = importedTopic.updatedAt || targetTopic.updatedAt || nowIso();
    }
    mergeAtlasTopicChildren(targetAtlas, importedAtlas, targetAtlas.topics[targetTopicId], importedTopic, stats);
  }

  targetStore.data.tabAtlas = normalizeTabAtlas(targetAtlas);
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
    atlasTopicsAdded: 0,
    atlasTabsAdded: 0,
    atlasTabsUpdated: 0,
  };

  target.features = {
    ...target.features,
    ...imported.features,
    tabTree: {
      ...(target.features.tabTree || {}),
      ...(imported.features.tabTree || {}),
    },
    tabAtlas: {
      ...(target.features.tabAtlas || {}),
      ...(imported.features.tabAtlas || {}),
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
  mergeTabAtlas(target, imported, stats);
  return { store: target, stats };
}

function formatImportStats(stats, mode) {
  if (mode === 'replace') {
    return `Replaced data: ${stats.favorites} sites, ${stats.savedTabs} saved tabs, ${stats.folders} folders, ${stats.treeTabs} stash links, ${stats.atlasTopics} atlas topics, ${stats.atlasTabs} atlas tabs.`;
  }

  return `Merged data: +${stats.favoritesAdded} sites, +${stats.savedTabsAdded} saved tabs, +${stats.foldersAdded} folders, +${stats.treeTabsAdded} stash links, ${stats.treeTabsUpdated} stash updated, +${stats.atlasTopicsAdded} atlas topics, +${stats.atlasTabsAdded} atlas tabs, ${stats.atlasTabsUpdated} atlas updated.`;
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
  setMessage(`Exported ${counts.favorites} sites, ${counts.savedTabs} saved tabs, ${counts.folders} folders, ${counts.treeTabs} stash links, ${counts.atlasTopics} atlas topics, ${counts.atlasTabs} atlas tabs.`);
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
