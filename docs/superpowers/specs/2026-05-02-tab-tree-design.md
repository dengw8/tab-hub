# Tab Tree 功能设计

## 背景

`Tab Out` 当前是一个纯 Chrome extension，通过 `chrome_url_overrides.newtab` 固定接管新标签页，并在 Dashboard 中展示当前打开的 tabs、常用网站和 Saved for later。

新的 `Tab Tree` 功能用于临时维护一组还不想进入书签系统的链接。它和 Dashboard 是平行功能：Dashboard 负责“看见和整理当前打开的 tabs”，Tab Tree 负责“把临时要回来的链接按少量主题分组”。

为了避免功能变成另一套重型 bookmarks，Tab Tree 不支持无限层级。它只保留两层业务结构：root 下是目录，目录下是 tab。

本设计采用单插件架构：Dashboard 仍是固定 new tab 入口，不能关闭；Tab Tree 是默认开启、可关闭的可选 feature。

## 目标

- 在当前 extension 内新增一棵唯一的 Tab Tree。
- 支持目录节点和 tab 节点，其中 root 是不可见的顶层容器。
- root 下只能创建目录节点。
- 目录节点下只能创建 tab 节点，不允许二级目录。
- 支持添加、编辑、删除、拖拽移动节点。
- 支持目录展开/收起，并持久化展开状态。
- 支持点击 tab 节点后新建浏览器 tab 打开对应 URL。
- 支持 `http:`, `https:`, `chrome:`, `chrome-extension:`, `about:`, `file:` URL。
- 支持右键菜单“Add current page to Tab Tree”，并在原生二级菜单中选择已有目录直接保存。
- 为跨设备同步和更多 feature 预留清晰边界。
- 重构代码组织，让 Dashboard、Tab Tree 和未来 feature 横向扩展时不会继续堆进当前单个大脚本。

## 非目标

- 不新建第二个 Chrome extension。
- 不允许关闭 Dashboard new tab 入口。
- 不在第一版实现真正跨设备同步。
- 不支持目录嵌套或复杂分类体系。
- 不在原生右键菜单里输入新目录名；新建目录优先使用当前页面内注入的轻量 modal，无法注入时 fallback 到 extension popup。
- 不和 Chrome bookmarks 同步，也不替代 Chrome bookmarks。
- 不保存当前浏览器 tab id、window id 或其他机器会话状态。

## 产品边界

`manifest.json` 继续固定：

```json
"chrome_url_overrides": { "newtab": "index.html" }
```

打开新 tab 时永远展示 Dashboard。Tab Tree 默认开启，并在 Dashboard 的 app shell 导航中出现入口。用户可以在设置中关闭 Tab Tree；关闭后隐藏 Tab Tree 入口和未来相关右键菜单，但保留已有树数据。

如果用户已经在 extension 内切到 `#tab-tree` 并刷新页面，可以保留在 Tab Tree 视图；但新开 tab 不携带 hash，仍进入 Dashboard。

点击浏览器扩展栏里的 Tab Out 图标时，展示 toolbar popup。Popup 是后续 feature 控制入口：Dashboard 显示为固定开启；Tab Tree 提供开关；当 Tab Tree 开启时，提供 `Open Tab Tree` 按钮用于打开或聚焦 `index.html#tab-tree`。

## 架构

采用 `App Shell + Feature Modules + Shared Layer`。

```text
extension/
├── index.html
├── manifest.json
├── background.js
├── src/
│   ├── main.js
│   ├── app-shell/
│   │   ├── app-shell.js
│   │   └── feature-registry.js
│   ├── features/
│   │   ├── dashboard/
│   │   └── tab-tree/
│   └── shared/
│       ├── storage.js
│       ├── migrations/
│       ├── url.js
│       ├── page-title.js
│       ├── modal.js
│       └── toast.js
```

职责边界：

- `app-shell`：全局导航、当前视图路由、feature 开关、settings 入口。
- `features/dashboard`：现有 Dashboard 功能，包括 open tabs、Common sites、Saved for later。
- `features/tab-tree`：Tab Tree 渲染、编辑、拖拽、搜索和节点操作。
- `shared/storage.js`：唯一的 Chrome storage 访问入口。
- `shared/migrations/`：集中处理旧数据和未来 schema 升级。
- `shared/url.js`：URL 规范化、scheme 支持、显示名称 fallback。
- `shared/page-title.js`：后台临时 tab 标题获取。
- `background.js`：继续负责 badge、`contextMenus` 和当前页新目录 modal 注入。

Dashboard 和 Tab Tree 不能互相调用内部逻辑，只能通过 shared API 和 storage 协作。

## Feature 配置

Dashboard 是基础入口，不进入 feature 关闭系统。

Tab Tree 配置默认开启：

```json
{
  "features": {
    "tabTree": {
      "enabled": true
    }
  }
}
```

如果没有配置，初始化为 `tabTree.enabled = true`。关闭 Tab Tree 时不删除数据。

## Storage 设计

为了避免后续功能增长导致 storage 不兼容，新数据采用版本化 envelope，而不是继续分散写多个无版本 key。

建议主 key：`tabOutStore`。

```json
{
  "schemaVersion": 1,
  "appVersion": "1.1.0",
  "features": {
    "tabTree": {
      "enabled": true
    }
  },
  "data": {
    "dashboard": {
      "favorites": [],
      "deferred": []
    },
    "tabTree": {
      "schemaVersion": 2,
      "maxDepth": 2,
      "rootId": "root",
      "nodes": {
        "root": {
          "id": "root",
          "type": "folder",
          "name": "Tab Tree",
          "children": [],
          "expanded": true,
          "createdAt": "2026-05-02T10:00:00.000Z",
          "updatedAt": "2026-05-02T10:00:00.000Z"
        }
      }
    }
  },
  "meta": {
    "createdAt": "2026-05-02T10:00:00.000Z",
    "updatedAt": "2026-05-02T10:00:00.000Z"
  }
}
```

兼容策略：

- 读取时优先读取 `tabOutStore`。
- 如果不存在，则读取现有 `favorites` 和 `deferred` 老 key，并迁移到 `data.dashboard`。
- 写入时写 `tabOutStore`。
- 迁移完成后可以暂时保留老 key，不急于删除，降低回滚风险。
- 每个 feature 拥有自己的 namespace 和内部 `schemaVersion`。
- 未来新 feature 只能写自己的 `data.<featureName>`，不能直接改其他 feature 的内部结构。

## Tab Tree 数据模型

Tab Tree 只有一棵树，root 固定存在。Root 是不可见的顶层容器，不允许删除、移动、重命名或直接保存 tab。

采用 `nodes` map + `children` 数组，而不是深层嵌套树，方便移动节点、删除子树和未来同步冲突处理。

结构约束：

- `root.children` 只能包含目录节点 id。
- 非 root 目录的 `children` 只能包含 tab 节点 id。
- tab 节点不能有 children。
- 旧数据如果存在 root 直属 tab，会迁移到自动创建的 `Unsorted` 目录。
- 旧数据如果存在嵌套目录，会提升为 root 下的新目录；目录名使用原路径保留上下文，例如 `Research / Agents`。

目录节点：

```json
{
  "id": "node_1",
  "type": "folder",
  "name": "Research",
  "children": ["node_2"],
  "expanded": true,
  "createdAt": "2026-05-02T10:00:00.000Z",
  "updatedAt": "2026-05-02T10:00:00.000Z"
}
```

Tab 节点：

```json
{
  "id": "node_2",
  "type": "tab",
  "name": "Chrome Extension Docs",
  "url": "https://developer.chrome.com/docs/extensions",
  "createdAt": "2026-05-02T10:00:00.000Z",
  "updatedAt": "2026-05-02T10:00:00.000Z"
}
```

节点不保存 favicon、当前 tab id、window id 或激活状态。

## URL 支持

允许保存：

- `http:`
- `https:`
- `chrome:`
- `chrome-extension:`
- `about:`
- `file:`

规范化规则：

- 去掉首尾空白。
- 如果没有 scheme，默认补 `https://`。
- 必须能被 `new URL()` 解析，或是浏览器能接受的 `about:` 形式。
- 保存完整 URL，保留 path、query、hash。

标题获取规则：

- `http:` 和 `https:`：使用后台临时 tab 获取页面标题。
- `chrome:`, `chrome-extension:`, `about:`, `file:`：不主动创建后台临时 tab 获取标题，默认从 URL 生成名称，用户可编辑。
- 右键菜单从当前页添加时，如果 Chrome 已提供当前 tab title，优先使用已有 title。

打开规则：

- 点击 tab 节点时调用 `chrome.tabs.create({ url })`。
- 如果 Chrome 拒绝打开某些内部或本地 URL，显示 toast，并提供复制 URL 的入口。
- `file:` 打开能力受浏览器设置影响，按 best-effort 处理。

## 新增 Tab 的标题获取流程

1. 用户选择在某目录下添加 tab。
2. 输入 URL。
3. 做 URL 规范化和 scheme 校验。
4. 如果是 `http:` 或 `https:`，调用 `chrome.tabs.create({ url, active: false })` 创建后台临时 tab。
5. 监听加载结果或轮询 tab title，最多等待 3-5 秒。
6. 获取到标题后关闭临时 tab。
7. 如果发生重定向，保存最终 URL。
8. 展示确认 modal：名称可编辑，URL 可编辑。
9. 用户确认后保存节点。

体验说明：

- 后台临时 tab 不抢焦点。
- Chrome 标签栏可能短暂出现新 tab，尤其在页面加载慢时。
- 获取失败、超时或临时 tab 创建失败时，用 URL 作为默认名称，不阻塞添加。
- 用户取消添加时，尽力关闭临时 tab。

## UI 和交互

Tab Tree 是完整视图，不作为 Dashboard 右栏。

```text
App shell nav
└── Tab Tree view
    ├── Toolbar
    │   ├── Add folder
    │   └── Search
    └── Tree surface
        ├── folder row
        │   └── tab rows
        └── folder row
            └── tab rows
```

节点行为：

- 目录节点可展开/收起。
- 页面顶部和空状态的 `Add folder` 用于添加 root 下目录。
- 目录节点旁有 `+`，只用于向该目录添加 tab。
- Tab 节点点击名称后新建浏览器 tab 打开 URL。
- Root 不展示为可操作行。
- 空树展示空状态，并只提供添加目录入口。

维护操作：

- 重命名目录。
- 编辑 tab 名称和 URL。
- 删除 tab。
- 删除目录前确认，并提示会删除所有子节点。
- 拖拽目录调整 root 下目录顺序。
- 拖拽 tab 到其他目录。
- 拖拽 tab 调整同目录顺序。
- 禁止移动 root。
- 禁止把目录拖入目录。
- 禁止把 tab 拖到 root。

搜索：

- 支持按节点名称和 URL 过滤。
- 搜索时自动展开包含命中的路径。
- 搜索不改变真实 `expanded` 状态。
- 清空搜索后恢复用户原本展开状态。

## 错误处理

- URL 无法解析：在 modal 内显示错误，不关闭 modal。
- 不支持的 scheme：在 modal 内提示当前不支持。
- 标题获取失败：使用 URL 作为默认名称。
- 临时 tab 关闭失败：记录 warning，不影响流程。
- Storage 写入失败：保留 modal 并提示保存失败。
- 数据损坏：轻度损坏自动修复；严重损坏展示恢复入口。
- 非法拖拽：不改变数据，并轻量提示。
- 删除目录：必须确认。

轻度损坏包括：

- `children` 指向不存在节点。
- 非 root 孤儿节点。
- folder 缺少 `children`。
- folder 缺少 `expanded`。

严重损坏包括：

- 缺少 root。
- root 不是 folder。
- `nodes` 不是对象。

严重损坏恢复策略是创建新的空 root，并保留原始损坏数据到一个 recovery key，避免直接丢弃。

## 权限

当前已有权限：

- `tabs`
- `activeTab`
- `storage`

MVP 不新增 host permissions。`tabs` 权限允许读取 tab 的 URL、title、favIconUrl 等属性，适合当前 Dashboard 和标题获取流程。

右键菜单需要新增：

- `contextMenus`
- `scripting`

## 右键菜单

在 `background.js` 注册：

- `Add current page to Tab Tree`

如果 `tabTree.enabled = false`，不注册或隐藏相关菜单。

右键菜单采用原生二级菜单，而不是先打开完整选择页面：

```text
Add current page to Tab Tree
├── + New folder...
├── Work Later
├── AI Research
└── Reading
```

点击已有目录后，直接将当前网页保存为该目录下的 tab，不打开任何新页面。

点击 `+ New folder...` 后，优先在当前网页注入一个轻量 modal。Modal 中展示：

- 当前网页标题或 URL。
- 目录名称输入框。

输入目录名后，创建目录并立即把当前网页加入这个新目录，然后关闭 modal。

如果当前页面不允许注入脚本，例如浏览器内部页，则 fallback 到 extension popup，交互内容相同。

右键菜单写入 `tabOutStore.data.tabTree`，不依赖 Dashboard 视图。写入前仍复用同一套浅层结构校验：root 只接收目录，目录只接收 tab。

同一个目录下重复添加相同规范化 URL 时，不创建新 tab 节点；更新已有节点的名称、URL、`updatedAt`，并移动到该目录末尾，表示最新添加。

不同目录之间不做全局去重，同一个链接可以属于多个临时主题。

## 未来同步

第一版使用 `chrome.storage.local`。由于 storage 已经通过 envelope 和 shared API 隔离，未来可以演进为：

- 小数据直接迁移到 `chrome.storage.sync`。
- 大树保留 local，设置和元数据使用 sync。
- 提供导入/导出。
- 增加冲突检测和 merge。

为同步预留的抓手：

- 全局 `schemaVersion`。
- Feature 级 `schemaVersion`。
- 稳定 node id。
- `createdAt` 和 `updatedAt`。
- 数据不依赖机器会话状态。
- `nodes` map 便于按节点做 merge。

## 测试策略

纯函数测试或轻量脚本验证：

- URL 规范化。
- scheme 支持。
- 创建目录节点。
- 创建 tab 节点。
- 禁止 root 直接创建 tab。
- 禁止目录下创建目录。
- 删除 tab。
- 删除目录及其 tabs。
- 移动节点。
- 禁止目录拖入目录。
- 禁止 tab 拖到 root。
- 旧无限层级数据迁移为两层结构。
- 搜索路径匹配。
- 损坏数据修复。
- 老 `favorites`、`deferred` key 迁移到 `tabOutStore`。

手动验收：

- 新 tab 默认仍进入 Dashboard。
- Tab Tree 默认开启，并能从导航进入。
- 关闭 Tab Tree 后入口隐藏，Dashboard 正常。
- 添加目录。
- 添加 `http/https` tab，并确认标题获取和 fallback。
- 添加 `chrome://`, `about:`, `file:` 类型 URL。
- 点击 tab 节点打开新 tab。
- 编辑、删除、拖拽移动节点。
- 右键当前网页，选择已有目录后加入 Tab Tree。
- 右键当前网页，通过选择器新建目录并立即加入 Tab Tree。
- 搜索时展开命中路径，清空后恢复展开状态。
- 刷新后树结构和展开状态保留。

## 实施顺序建议

1. 建立 `src/` 目录和 app shell，但保持 Dashboard 行为不变。
2. 抽出 shared storage，并实现 `tabOutStore` envelope 和老数据迁移。
3. 将现有 Dashboard 代码迁入 `features/dashboard`。
4. 实现 feature registry 和 Tab Tree 开关。
5. 实现 Tab Tree 数据操作纯函数，并强制两层结构约束。
6. 实现 Tab Tree UI、modal 和受限拖拽。
7. 实现后台标题获取。
8. 实现右键菜单原生二级菜单和新目录 modal/popup fallback。
9. 完成错误处理、验收和 README 更新。
