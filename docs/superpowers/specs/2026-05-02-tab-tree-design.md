# Tab Tree 功能设计

## 背景

`Tab Out` 当前是一个纯 Chrome extension，通过 `chrome_url_overrides.newtab` 固定接管新标签页，并在 Dashboard 中展示当前打开的 tabs、常用网站和 Saved for later。

新的 `Tab Tree` 功能用于临时维护一组还不想进入书签系统的链接。它和 Dashboard 是平行功能：Dashboard 负责“看见和整理当前打开的 tabs”，Tab Tree 负责“把临时要回来的链接组织成树”。

本设计采用单插件架构：Dashboard 仍是固定 new tab 入口，不能关闭；Tab Tree 是默认开启、可关闭的可选 feature。

## 目标

- 在当前 extension 内新增一棵唯一的 Tab Tree。
- 支持目录节点和 tab 节点，其中 root 也是目录节点。
- 支持添加、编辑、删除、拖拽移动节点。
- 支持目录展开/收起，并持久化展开状态。
- 支持点击 tab 节点后新建浏览器 tab 打开对应 URL。
- 支持 `http:`, `https:`, `chrome:`, `chrome-extension:`, `about:`, `file:` URL。
- 为未来右键菜单、跨设备同步和更多 feature 预留清晰边界。
- 重构代码组织，让 Dashboard、Tab Tree 和未来 feature 横向扩展时不会继续堆进当前单个大脚本。

## 非目标

- 不新建第二个 Chrome extension。
- 不允许关闭 Dashboard new tab 入口。
- 不在第一版实现真正跨设备同步。
- 不在第一版实现右键菜单写入目录选择器；未来可先默认加入 root。
- 不和 Chrome bookmarks 同步，也不替代 Chrome bookmarks。
- 不保存当前浏览器 tab id、window id 或其他机器会话状态。

## 产品边界

`manifest.json` 继续固定：

```json
"chrome_url_overrides": { "newtab": "index.html" }
```

打开新 tab 时永远展示 Dashboard。Tab Tree 默认开启，并在 Dashboard 的 app shell 导航中出现入口。用户可以在设置中关闭 Tab Tree；关闭后隐藏 Tab Tree 入口和未来相关右键菜单，但保留已有树数据。

如果用户已经在 extension 内切到 `#tab-tree` 并刷新页面，可以保留在 Tab Tree 视图；但新开 tab 不携带 hash，仍进入 Dashboard。

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
- `background.js`：继续负责 badge；未来承接 `contextMenus`。

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
      "schemaVersion": 1,
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

Tab Tree 只有一棵树，root 固定存在。Root 是目录节点，不允许删除或移动。

采用 `nodes` map + `children` 数组，而不是深层嵌套树，方便移动节点、删除子树和未来同步冲突处理。

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
- 未来右键菜单从当前页添加时，如果 Chrome 已提供当前 tab title，优先使用已有 title。

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
    │   ├── Add folder to root
    │   ├── Add tab to root
    │   └── Search
    └── Tree surface
        └── root folder
            ├── folder rows
            └── tab rows
```

节点行为：

- 目录节点可展开/收起。
- 目录节点旁有 `+`，用于添加目录或 tab。
- Tab 节点点击名称后新建浏览器 tab 打开 URL。
- Root 展示为目录节点，但不允许删除、移动或改成 tab。
- 空树展示 root 下空状态，并提供添加目录和添加 tab 的入口。

维护操作：

- 重命名目录。
- 编辑 tab 名称和 URL。
- 删除 tab。
- 删除目录前确认，并提示会删除所有子节点。
- 拖拽移动节点到其他目录。
- 拖拽调整同级顺序。
- 禁止移动 root。
- 禁止把目录移动到自己的后代中。

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

未来右键菜单需要新增：

- `contextMenus`

## 未来右键菜单

后续在 `background.js` 注册：

- `Add current page to Tab Tree`
- `Add link to Tab Tree`

如果 `tabTree.enabled = false`，不注册或隐藏相关菜单。

第一版右键菜单可以默认加入 root。后续可扩展为选择目录、最近目录或上次使用目录。

右键菜单直接写入 `tabOutStore.data.tabTree`，不依赖 Dashboard 视图。

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
- 删除 tab。
- 删除目录子树。
- 移动节点。
- 禁止移动到自身后代。
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
- 搜索时展开命中路径，清空后恢复展开状态。
- 刷新后树结构和展开状态保留。

## 实施顺序建议

1. 建立 `src/` 目录和 app shell，但保持 Dashboard 行为不变。
2. 抽出 shared storage，并实现 `tabOutStore` envelope 和老数据迁移。
3. 将现有 Dashboard 代码迁入 `features/dashboard`。
4. 实现 feature registry 和 Tab Tree 开关。
5. 实现 Tab Tree 数据操作纯函数。
6. 实现 Tab Tree UI、modal 和拖拽。
7. 实现后台标题获取。
8. 完成错误处理、验收和 README 更新。
