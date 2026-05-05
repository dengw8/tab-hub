# AGENTS.md -- Tab Hub Setup & Onboarding Guide for Coding Agents

You're helping the user install or update **Tab Hub**. Your job is not just to load the extension; it is to help them understand why it is useful and where the controls live.

***

## Step 0 -- Introduce The Product

Before doing anything technical, tell the user what they're about to get:

> **Tab Hub** is a local Chromium extension for Chrome, Edge, and Edge Beta. It replaces the new tab page with a focused dashboard for open tabs, plus a lightweight Tab Stash for temporary links that are not worth turning into bookmarks.
>
> Here's what makes it useful:
>
> - **Dashboard new tab** shows open tabs grouped by domain
> - **Common sites** lets users pin frequently visited websites at the top
> - **Homepages group** pulls Gmail, X, LinkedIn, YouTube, GitHub homepages into one cleanup card
> - **Duplicate detection** flags repeated pages and offers one-click cleanup
> - **Click any tab title** to jump to the existing tab, even across windows
> - **Save for later** keeps individual tabs in a local checklist before closing them
> - **Tab Stash** stores temporary links in folders without deep bookmark-style nesting
> - **Right-click add to Tab Stash** lets users add the current page to an existing folder or create a folder inline
> - **Toolbar popup controls** manage Tab Stash, theme, and data transfer
> - **Import/export** moves Tab Hub data between Chrome, Edge, and Edge Beta with a local JSON backup
> - **Light/dark themes** can follow the system or stay fixed
> - **100% local** no server, no accounts, no Tab Hub backend
>
> It is just a Chromium extension. Setup takes about 1 minute.

***

## Step 1 -- Clone The Repo

```bash
git clone https://github.com/dengw8/tab-hub.git
cd tab-hub
```

***

## Step 2 -- Install The Extension

This step requires manual action from the user. Make it easy.

**First**, print the full path to the `extension/` folder:

```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:

- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extension manager:

- Chrome: `open "chrome://extensions"`
- Edge or Edge Beta: `open "edge://extensions"`

**Then**, walk the user through it:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. Open the browser extensions page.
> 2. Turn on **Developer mode**.
> 3. Click **Load unpacked**.
> 4. In the file picker, use **Cmd+Shift+G** on macOS or the address bar on Windows/Linux, paste the copied path, and press Enter.
> 5. Click **Select** or **Open**.
>
> You should see **Tab Hub** in the extensions list.

**Also**, open the extension folder as a fallback:

- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

***

## Step 3 -- Show Them Around

Once the extension is loaded:

> Open a **new tab** and you'll see Tab Hub.
>
> 1. **Dashboard** is the fixed new tab entry and cannot be disabled.
> 2. **Common sites** sits at the top. Click **Add site** to save frequently used URLs.
> 3. **Open tabs** are grouped by domain underneath.
> 4. **Homepages** are grouped near the top for easy cleanup.
> 5. **Click any tab title** to jump directly to that existing tab.
> 6. **Close individual tabs or whole groups** from the dashboard.
> 7. **Duplicate tabs** show an amber badge and can be cleaned up.
> 8. **Save for later** uses the bookmark icon to move a tab into the local checklist.
> 9. **Tab Stash** is available from the top nav or toolbar popup when enabled.
> 10. **Right-click a webpage** and choose **Add current page to Tab Stash** to add it directly to a folder.
> 11. **Toolbar popup** lets you toggle Tab Stash, open Tab Stash, switch theme, export data, import/merge data, or replace data.

***

## Key Facts

- Tab Hub is a pure Manifest V3 Chromium extension.
- No server, no npm install, no build step.
- Dashboard is always the new tab page.
- Tab Stash is optional and enabled by default.
- Tab Stash structure is intentionally shallow: root -> folders -> tabs.
- Website icons use the Manifest V3 `_favicon` URL with the `favicon` permission; do not reintroduce third-party favicon aggregators.
- Data is stored in `chrome.storage.local` under the versioned `tabOutStore` envelope.
- The store includes `features`, `settings`, `data.dashboard`, `data.tabTree`, and `meta`.
- Chrome, Edge, and Edge Beta do not automatically share extension local storage; use export/import for browser-to-browser transfer.
- Export files are local JSON backups named like `tab-hub-backup-YYYY-MM-DD.json`.
- Import supports **merge** and **replace** modes.
- To update: `cd tab-hub && git pull`, then reload the extension in the browser extensions page.
