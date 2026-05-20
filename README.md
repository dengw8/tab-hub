# Tab Hub

**Keep tabs on your tabs.**

Tab Hub is a local Chromium extension for Chrome, Edge, and Edge Beta. It replaces the new tab page with a clean dashboard of open tabs grouped by domain, adds a lightweight Tab Stash for temporary links, and includes Tab Atlas for organizing knowledge with tabs.

No server. No account. No Tab Hub backend. Your data stays in browser extension storage unless you explicitly export it.

---

## Features

- **Dashboard new tab** shows all open tabs grouped by domain
- **Common sites** pins frequently used websites at the top
- **Homepages group** collects Gmail, X, LinkedIn, YouTube, GitHub homepages into one cleanup card
- **Duplicate detection** flags repeated pages with one-click cleanup
- **Jump to tab** opens the existing tab instead of creating another one
- **Save for later** keeps tabs in a local checklist before closing them
- **Tab Stash** stores temporary links in shallow folders
- **Tab Atlas** organizes knowledge topics with nested subtopics, source tabs, and optional notes
- **Right-click add to Tab Stash** adds the current page to an existing folder or creates a folder inline
- **Right-click add to Tab Atlas** saves the current page into an existing knowledge topic from an inline picker
- **Settings** controls optional features, appearance, Tab Hub backups, and open tabs transfer
- **Toolbar popup** opens Tab Stash, Tab Atlas, and Settings
- **Import/export** moves data between Chrome, Edge, and Edge Beta using local JSON backups
- **Open tabs transfer** moves currently open tabs between Chrome, Edge, and Edge Beta, including native tab groups when supported
- **Light/dark themes** can follow system appearance or stay fixed
- **Localhost grouping** shows port numbers so local projects are easier to tell apart
- **100% local-first** no accounts, no remote sync service, no setup beyond loading the extension

---

## Install

**1. Clone the repo**

```bash
git clone https://github.com/dengw8/tab-hub.git
cd tab-hub
```

**2. Load the extension**

1. Open your browser extension page:
   - Chrome: `chrome://extensions`
   - Edge / Edge Beta: `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repo's `extension/` folder.

**3. Open a new tab**

You should see Tab Hub.

---

## How It Works

```text
You open a new tab
  -> Tab Hub shows your open tabs grouped by domain
  -> Common sites stay at the top for quick access
  -> Homepages get their own cleanup group
  -> Click a tab title to jump to that existing tab
  -> Close tabs or groups when you're done
  -> Save tabs for later before closing them
  -> Use Tab Stash for temporary folders of links
  -> Right-click a page to add it to a Tab Stash folder
  -> Use Tab Atlas for structured knowledge topics and source tabs
  -> Right-click a page to add it to an Atlas topic without leaving the page
  -> Use the toolbar popup for Tab Stash, Tab Atlas, and Settings
```

Dashboard is the fixed new tab entry. Tab Stash is an optional feature and is enabled by default.
Tab Atlas is also optional and enabled by default.

---

## Tab Stash

Tab Stash is intentionally lighter than bookmarks.

- There is one Tab Stash.
- The root contains folders.
- Folders contain tab links.
- Folders do not contain nested folders.
- Clicking a tab node opens the saved URL in a new browser tab.
- Adding the same URL to the same folder updates that item and moves it to the latest position.
- The same URL can still exist in different folders.

You can add links from the Tab Stash page or from the browser right-click menu.

## Tab Atlas

Tab Atlas is for knowledge you want to keep structured instead of temporarily parked.

- The Tab Atlas home shows top-level knowledge topics as a list.
- Top-level topics can be dragged on the Tab Atlas home to adjust their order.
- Each top-level topic opens into a topic tree with expandable and collapsible branches.
- Topic depth is capped at three levels.
- Every topic can have an optional note.
- Tabs can be attached to any topic level.
- Every attached tab has a title, URL, and optional note.
- Topic names must be unique among siblings. Tab titles can repeat.
- Drag topics and tab sources inside a top-level topic to reorganize the atlas.
- Add topic and add tab share one modal; at the maximum topic depth, only tab sources can be added.
- Right-click **Add current page to Tab Atlas** opens an inline picker on the current page.
- The inline picker shows a collapsible topic tree, remembers recent target topics, and saves an optional tab note.
- If there is no top-level topic yet, the right-click flow creates a `Default` L1 topic with no note before opening the picker.
- Adding the same URL to the same topic updates that source tab and moves it to the latest position.

---

## Toolbar Popup

Click the Tab Hub icon in the browser toolbar to open controls:

- Toggle Tab Stash on/off
- Open Tab Stash
- Toggle Tab Atlas on/off
- Open Tab Atlas
- Open Settings

Settings opens inside the Tab Hub new tab page. It contains optional feature toggles, appearance controls, Tab Hub backup import/export, and open tabs transfer.

---

## Settings

Open **Settings** from the toolbar popup or the gear button inside Tab Hub.

Settings contains lower-frequency controls:

- **Features** toggles Tab Stash and Tab Atlas.
- **Appearance** chooses **System**, **Light**, or **Dark** theme.
- **Tab Hub backup** exports, merges, or replaces saved Tab Hub data.
- **Open tabs transfer** exports and imports currently open browser windows, tabs, and tab groups.

---

## Data Transfer

Chrome, Edge, and Edge Beta keep extension local storage separately. Tab Hub does not automatically sync between them.

Open **Settings** and use **Export backup** in one browser and **Import merge** in another browser to move data across browsers.

Export backup creates a local JSON file named like:

```text
tab-hub-backup-YYYY-MM-DD.json
```

Import modes:

- **Import merge** keeps existing data and adds backup data. Common sites are deduped by URL. Tab Stash folders are merged by folder name. Repeated URLs in the same folder are updated and moved to the latest position. Tab Atlas topics are merged by sibling name; repeated URLs in the same topic update the existing source tab.
- **Replace data** overwrites the current browser's Tab Hub data with the selected backup.

The backup includes feature flags, theme settings, Common sites, Saved for later, Tab Stash data, Tab Atlas data, and metadata.

Open tabs transfer is separate from Tab Hub data backups. In **Settings**, use **Export tabs** to create a local session file named like:

```text
tab-hub-open-tabs-YYYY-MM-DD.json
```

Use **Import tabs** in another Chrome, Edge, or Edge Beta browser to open the exported tabs in new windows. Tab Hub restores tab order, active tabs, pinned tabs, and native tab groups when the target browser supports Chromium tab group APIs. If native tab groups are unavailable, Tab Hub still opens the tabs in order and keeps the import message compact.

Open tabs transfer does not save cookies, login state, form state, scroll position, or browser history. Browser-internal pages such as `chrome://settings`, `edge://settings`, extension pages, and DevTools pages may be skipped during import.

---

## Storage

Tab Hub stores data in `chrome.storage.local` under a versioned `tabOutStore` envelope:

```text
tabOutStore
  -> features
  -> settings
  -> data.dashboard
  -> data.tabTree
  -> data.tabAtlas
  -> meta
```

Legacy `favorites` and `deferred` keys are migrated into `data.dashboard` when the store is created.

---

## Tech Stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| New tab | `chrome_url_overrides.newtab` |
| Storage | `chrome.storage.local` |
| Context menu | `chrome.contextMenus` for Tab Stash and Tab Atlas quick add |
| Page injection | `chrome.scripting` for inline Tab Stash folder creation and Tab Atlas topic picker |
| Tab groups | `chrome.tabGroups` and `chrome.tabs.group()` for open tabs transfer |
| Favicons | Manifest V3 `_favicon` URL with the `favicon` permission |
| Sound | Web Audio API |
| UI | Plain HTML, CSS, and JavaScript |

---

## Update

```bash
git pull
```

Then reload Tab Hub in the browser extensions page.

---

## License

MIT
