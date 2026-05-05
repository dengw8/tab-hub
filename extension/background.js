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
const TAB_TREE_ALLOWED_PROTOCOLS = ['http:', 'https:', 'chrome:', 'chrome-extension:', 'about:', 'file:'];
const TAB_TREE_CREATE_FOLDER_MESSAGE = 'tab-out:create-folder-and-add-current-page';
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

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  syncTabTreeContextMenu();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  syncTabTreeContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
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
  if (!message || message.type !== TAB_TREE_CREATE_FOLDER_MESSAGE) return false;

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
    syncTabTreeContextMenu();
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
syncTabTreeContextMenu();
