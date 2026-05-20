# AGENTS.md - Tab Hub Project Guide For Coding Agents

Use this file as the fast project map when working in this repo. It is written for agents, not end users.

## Product Snapshot

Tab Hub is a local Manifest V3 Chromium extension for Chrome, Edge, and Edge Beta. It replaces the new tab page with a dashboard for open tabs, plus two optional local organization tools:

- **Dashboard**: always-on new tab page for open tabs, common sites, homepages, duplicates, and save-for-later.
- **Tab Stash**: shallow temporary folders for links that are not worth full bookmark nesting.
- **Tab Atlas**: a knowledge map made of top-level topics, nested subtopics, source tabs, and optional notes.

Non-negotiables:

- No server, no accounts, no remote sync.
- No npm install and no build step.
- Everything runs from `extension/` as an unpacked Chromium extension.
- Data lives in `chrome.storage.local` under the versioned `tabOutStore` envelope.
- Do not reintroduce third-party favicon services. Use Manifest V3 `_favicon` URLs with the `favicon` permission.

## Repository Map

- `extension/manifest.json`: MV3 manifest, permissions, new tab override, background worker, toolbar popup.
- `extension/index.html`: new tab shell, dashboard, Tab Stash view, Tab Atlas view, shared modals, and Settings modal.
- `extension/app.js`: main new-tab app. Owns dashboard rendering, Tab Stash UI, Tab Atlas UI, Settings modal, feature toggles, theme preference, Tab Hub backup import/export, open-tabs export, and most new-tab store mutations.
- `extension/style.css`: main new-tab styles.
- `extension/background.js`: service worker. Owns badge count, context menus, right-click quick-add flows, inline page modals injected with `chrome.scripting`, store normalization needed by the worker, and browser-level open-tabs session import.
- `extension/tree-picker.html` and `extension/tree-picker.js`: popup window used by Tab Stash right-click flow as picker/fallback.
- `extension/popup.html`, `extension/popup.js`, `extension/popup.css`: toolbar popup for high-frequency entry points only: Tab Stash toggle/open, Tab Atlas toggle/open, and opening Settings.
- `README.md`: human-facing project overview. Keep it accurate when product behavior changes.
- `docs/superpowers/specs/`: design specs. Useful context, but implementation reality in `extension/` wins.

## Run And Verify

There is no build. For code changes, prefer these checks:

```bash
for f in extension/*.js; do node --check "$f" || exit 1; done
git diff --check
```

Manual extension verification still requires reloading the unpacked extension in `chrome://extensions` or `edge://extensions`.

When testing context-menu or injected-modal behavior, reload the extension after changes because `background.js` is a service worker.

## Storage Contract

All persistent data is stored in `chrome.storage.local` under:

```text
tabOutStore
  -> schemaVersion
  -> appVersion
  -> features
  -> settings
  -> data.dashboard
  -> data.tabTree
  -> data.tabAtlas
  -> meta
```

Current defaults:

- `features.tabTree.enabled`: `true`
- `features.tabAtlas.enabled`: `true`
- `settings.theme`: `system`
- `data.dashboard.favorites`: common sites
- `data.dashboard.deferred`: save-for-later items
- `data.tabTree`: Tab Stash
- `data.tabAtlas`: Tab Atlas

Important implementation detail: store normalization exists in multiple files because there is no shared module system:

- `extension/app.js`
- `extension/background.js`
- `extension/popup.js`
- `extension/tree-picker.js` for Tab Stash only

If you change persisted shape or merge behavior, update every relevant normalizer/importer. Do not update only `app.js`.

## Settings And Toolbar Popup

The toolbar popup is intentionally small. It should expose high-frequency controls only:

- Toggle/open Tab Stash.
- Toggle/open Tab Atlas.
- Open Settings.

Low-frequency controls belong in the Settings modal inside the Tab Hub new tab page:

- Feature toggles for Tab Stash and Tab Atlas.
- Appearance theme selection.
- Tab Hub backup export/import.
- Open tabs transfer export/import.

The popup opens Settings by navigating or focusing `index.html#settings`. The new-tab app should recognize that hash and show the Settings modal. Avoid moving backup, import, or theme controls back into the popup unless the product direction changes.

## Dashboard Behavior

The dashboard is always the new tab page and cannot be disabled.

It shows:

- Common sites pinned by the user.
- Open tabs grouped by domain.
- Localhost groups with port numbers.
- A homepages cleanup group for Gmail, X, LinkedIn, YouTube, GitHub homepages.
- Duplicate detection and cleanup.
- Click-to-focus existing tabs across windows.
- Save-for-later checklist before closing tabs.

## Tab Stash Contract

Tab Stash is optional and enabled by default.

Data model:

```text
data.tabTree
  schemaVersion: 2
  maxDepth: 2
  rootId: "root"
  nodes.root -> folder children
  folder nodes -> tab children
```

Rules:

- Structure is intentionally shallow: root -> folders -> tabs.
- Folders do not contain nested folders.
- Adding the same URL to the same folder updates the existing tab and moves it to the latest position.
- The same URL may exist in different folders.
- Right-click menu supports:
  - `Add current page to Tab Stash`
  - direct add to existing root folders
  - `+ New folder...` with an inline injected modal
- `tree-picker.html/js` is still used for picker/fallback flows.

## Tab Atlas Contract

Tab Atlas is optional and enabled by default.

Data model:

```text
data.tabAtlas
  schemaVersion: 1
  maxDepth: 3
  rootTopicIds: []
  topics: { [topicId]: topic }
  tabs: { [sourceId]: sourceTab }
  recentTopicIds: []
```

Topic shape:

```text
topic
  id
  name
  note
  children
  tabIds
  items      # ordered mixed list of { type: "topic" | "tab", id }
  expanded
  createdAt
  updatedAt
```

Source tab shape:

```text
source tab
  id
  title
  url
  note
  createdAt
  updatedAt
```

Rules:

- Maximum topic depth is 3.
- Root topics are L1. Children are L2. Grandchildren are L3.
- Topic names must be unique among siblings. Tab titles may repeat.
- Topics and source tabs both support optional notes.
- Top-level Atlas home shows only L1 topic list with name and note. It does not expand the tree.
- L1 topic order is adjustable on the Atlas home and stored in `rootTopicIds`.
- A top-level topic detail page shows the topic tree for that L1 branch.
- Topic nodes support expand/collapse in the Atlas detail page.
- Dragging is supported inside one L1 branch for topics and source tabs. Reparenting must preserve `maxDepth`.
- Topic and tab ordering is stored in `topic.items`; keep `children` and `tabIds` synchronized from `items`.
- Add topic and add tab share one modal. Default mode is add tab.
- At L3, adding a topic is disallowed; keep the user-facing error `Maximum topic depth reached`.
- Adding a duplicate URL to the same topic updates the existing source tab and moves it to the latest position.

## Right-Click Add To Tab Atlas

Background menu id: `tab-out-add-current-page-atlas`.

Current behavior:

- Context menu label is `Add current page to Tab Atlas`.
- The menu is hidden when `features.tabAtlas.enabled === false`.
- It does not open a new extension page.
- It injects an inline Shadow DOM modal into the current page via `chrome.scripting.executeScript`.
- The injected modal lets the user choose an existing topic and enter an optional note.
- It does not support search.
- It does not support creating a topic manually.
- If there is no L1 topic yet, background creates a note-less `Default` L1 topic before opening the picker.
- The picker displays a collapsible topic tree, similar to browser bookmarks.
- Picker expand/collapse state is temporary for that modal. Do not persist it to `topic.expanded`.
- The selected topic display has no indentation; only the expanded candidate tree uses indentation.
- Recent successful targets are stored in `recentTopicIds` and used as the default selection.

Unsupported pages:

- `about:`, `chrome:`, `chrome-extension:`, `edge:`, and `brave:` pages cannot receive the injected Atlas modal.
- Current behavior is to log a warning. Do not add a fallback page unless the user explicitly asks.

## Tab Hub Backup Import And Export

Settings owns Tab Hub backup export/import UI. The toolbar popup should only provide the Settings entry point.

Export:

- Creates local JSON named like `tab-hub-backup-YYYY-MM-DD.json`.
- Includes feature flags, settings, dashboard data, Tab Stash, Tab Atlas, and meta.

Import modes:

- **Merge** keeps current local data and merges backup data.
- **Replace** overwrites the current local store with the backup.

Merge expectations:

- Common sites dedupe by URL.
- Saved-for-later dedupes by URL.
- Tab Stash folders merge by folder name; duplicate URLs in a folder update and move latest.
- Tab Atlas topics merge by sibling name; duplicate URLs in a topic update and move latest.
- `recentTopicIds` should be filtered to existing topics and capped at 5.

## Open Tabs Transfer

Open tabs transfer is separate from `tabOutStore` backup import/export. It is for moving currently open browser windows and tabs between Chrome, Edge, and Edge Beta.

Manifest/API requirements:

- `extension/manifest.json` must include the `tabGroups` permission.
- Export uses `chrome.windows.getAll({ populate: true })`, `chrome.tabs`, and `chrome.tabGroups.query()`.
- Import is handled in `background.js` through runtime message `tab-hub:import-open-tabs-session`.
- Import uses `chrome.windows.create`, `chrome.tabs.create` / `chrome.tabs.update`, `chrome.tabs.group()`, and `chrome.tabGroups.update()` when available.

Session export format:

```text
format: "tab-hub-open-tabs-session"
formatVersion: 1
windows[]
  -> tabs[]
  -> groups[]
```

Rules:

- Do not store native browser `groupId` as a cross-browser identity. It is only valid in the current browser session.
- Export a browser-neutral `groupKey` and recreate native groups during import.
- Chrome, Edge, and Edge Beta should interoperate in both directions when the target browser supports Chromium tab group APIs.
- If native tab groups are unavailable, import should still open restorable tabs in window/tab order and use a compact summary.
- Import should create new windows rather than mixing tabs into existing windows.
- Skip unsupported browser-internal URLs instead of failing the whole import.
- Keep import result messaging low-distraction: one compact Settings message; detailed skipped URLs and warnings can go to console.
- Do not write open-tabs transfer data into Tab Stash or Tab Atlas unless the user explicitly asks for that behavior.

## UI And Interaction Notes

- Follow existing visual language in `style.css`; avoid introducing unrelated design systems.
- Keep operational surfaces compact and scannable. Tab Hub is a work tool, not a marketing page.
- Prefer existing modal/action button patterns in `index.html` and `app.js`.
- For extension-injected modals in `background.js`, use Shadow DOM and defensive inline styles because host pages may have hostile CSS.
- Keep text concise. This extension's UI uses short labels and direct action names.
- When changing context-menu behavior, update `syncContextMenus()` / storage-change sync in `background.js`.

## Common Pitfalls

- Do not assume `app.js` is the only place that understands the store. Background, popup, and tree picker have their own normalizers.
- Do not make Tab Stash nested. Its shallow shape is intentional.
- Do not let Tab Atlas exceed depth 3, including drag/drop reparenting.
- Do not persist the right-click Atlas picker collapse state into topic data.
- Do not change Tab Atlas topic-name uniqueness to global uniqueness; it is sibling-level uniqueness.
- Do not remove `recentTopicIds`; it drives the right-click Atlas default selection.
- Do not move low-frequency Settings controls back into the toolbar popup without an explicit product decision.
- Do not persist browser-native tab group IDs as portable data; use exported `groupKey` values and recreate native groups on import.
- Do not add network calls for icons, sync, summaries, or metadata.
- Do not add a build tool unless the user explicitly asks for a larger refactor.

## User-Facing Installation Notes

If the user asks how to install or update:

```bash
git clone https://github.com/dengw8/tab-hub.git
cd tab-hub
echo "Extension folder: $(cd extension && pwd)"
```

Then load `extension/` through the browser extension page with Developer mode enabled.

To update an existing checkout:

```bash
git pull
```

Then reload the extension from the browser extension page.
