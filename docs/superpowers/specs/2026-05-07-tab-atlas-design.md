# Tab Atlas 功能设计

## 背景

`Tab Hub` 当前是一个纯本地 Chromium extension，通过 `chrome_url_overrides.newtab` 固定接管新标签页，并提供三个已成型的核心能力：

- Dashboard：展示和整理当前打开的 tabs。
- Common sites：固定高频入口。
- Tab Stash：用浅层目录临时收纳链接。

新的 `Tab Atlas` 功能用于把 tabs 组织成长期知识体系。它不是 Tab Stash 的升级版，也不是浏览器收藏夹的替代品，而是 Tab Hub 内一个独立并列的可选功能：用户可以围绕某个知识点建立结构化主题树，并把相关 tabs 作为资料来源挂到任意层级，同时为知识点和 tab 写备注。

Tab Stash 负责“临时放一下”，Tab Atlas 负责“沉淀成知识地图”。

## 目标

- 在 Tab Hub 内新增独立并列功能 `Tab Atlas`。
- Tab Atlas 默认开启，可在设置中关闭；关闭后隐藏入口但保留数据。
- Tab Atlas 主页展示所有一级知识点 list，只展示名称和 note 摘要等概览信息，不展开子树。
- 点击一级知识点进入详情页，详情页完整展开展示该一级知识点下的知识树。
- 知识树最大支持 3 层：一级知识点、二级知识点、三级知识点。
- 任意层级知识点都可以包含：
  - 知识点名称。
  - 知识点 note。
  - 子知识点。
  - 关联 tab sources。
- 每个 tab source 包含 title、url、note。
- 同一个父知识点下，子知识点名称不允许重复。
- tab source 的 title 允许重复。
- 同一个 topic 下重复添加同一个 URL 时更新已有 tab source，并移动到该 topic 的 tab list 末尾。
- 支持在一级知识点详情页内拖拽整理 topic 和 tab source。
- 支持搜索主页一级知识点，以及搜索当前详情页内的 topic 和 tab source。
- 数据纳入现有本地 JSON import/export。
- 全部数据继续保存在 `chrome.storage.local`，不引入服务端、账号或远程同步。

## 非目标

- 不替代或改造现有 Tab Stash。
- 不把 Tab Atlas 数据写入现有 `data.tabTree`。
- 不与 Chrome bookmarks 同步。
- 不实现跨浏览器自动同步。
- 不支持超过 3 层的知识树。
- 不支持跨一级知识点拖拽。
- 不在 MVP 支持首页一级知识点拖拽排序。
- 不实现显式关系类型，例如“并列”“递进”“依赖”“父子以外的引用”。
- 不实现标签系统、批量操作、Markdown 富文本备注或 AI 总结网页。
- 不在 MVP 中新增右键菜单“Add current page to Tab Atlas”；该能力作为后续增强。

## 产品边界

`manifest.json` 继续固定：

```json
"chrome_url_overrides": { "newtab": "index.html" }
```

打开新标签页时仍默认进入 Dashboard。Tab Atlas 是 Tab Hub app shell 中与 Dashboard、Tab Stash 并列的 feature 入口。

```text
Dashboard | Tab Stash | Tab Atlas | Settings
```

功能定位：

```text
Dashboard -> 管理当前打开的 tabs
Tab Stash -> 临时链接收纳，浅层 folder -> tabs
Tab Atlas -> 用 tabs 构建长期知识地图，多层 topic -> tabs
```

Tab Atlas 默认开启。如果用户在 Settings 中关闭 Tab Atlas：

- 隐藏顶部导航入口。
- 隐藏未来可能增加的 Tab Atlas 相关右键菜单。
- 不删除已有 `data.tabAtlas` 数据。
- 如果当前停留在 Tab Atlas 视图，应回到 Dashboard。

## 命名

产品名使用 `Tab Atlas`。

概念命名：

- `Tab Atlas`：功能名。
- `Atlas topic`：一级知识点，是一个独立知识体系入口。
- `Topic`：二级或三级知识点。
- `Tab source`：某个知识点关联的 tab/link 资料。
- `Note`：知识点或 tab source 的备注。

UI 文案建议：

- `Tab Atlas`
- `Add topic`
- `Add tab`
- `Edit topic`
- `Edit tab`
- `Back to Atlas`
- `Search Atlas`

代码命名建议：

- feature flag：`features.tabAtlas.enabled`
- data namespace：`data.tabAtlas`
- view hash：`#tab-atlas`
- detail hash：`#tab-atlas/<topicId>`

## Feature 配置

Dashboard 是固定基础入口，不进入 feature 关闭系统。

Tab Stash 继续使用现有：

```json
{
  "features": {
    "tabTree": {
      "enabled": true
    }
  }
}
```

Tab Atlas 新增独立配置：

```json
{
  "features": {
    "tabAtlas": {
      "enabled": true
    }
  }
}
```

如果读取旧 store 时没有 `features.tabAtlas`，初始化为：

```json
{
  "enabled": true
}
```

关闭 Tab Atlas 时只修改 enabled，不删除数据。

## Storage 设计

继续使用现有主 key：

```text
tabOutStore
```

Tab Atlas 独立写入 `data.tabAtlas`，不复用 `data.tabTree`。`data.tabTree` 继续表示 Tab Stash。

整体结构：

```json
{
  "schemaVersion": 1,
  "appVersion": "1.1.0",
  "features": {
    "tabTree": {
      "enabled": true
    },
    "tabAtlas": {
      "enabled": true
    }
  },
  "settings": {
    "theme": "system"
  },
  "data": {
    "dashboard": {
      "favorites": [],
      "deferred": []
    },
    "tabTree": {},
    "tabAtlas": {}
  },
  "meta": {
    "createdAt": "2026-05-07T10:00:00.000Z",
    "updatedAt": "2026-05-07T10:00:00.000Z"
  }
}
```

## Tab Atlas 数据模型

Tab Atlas 支持多个独立一级知识点。一级知识点存放在 `rootTopicIds` 中；每个一级知识点代表一个独立 Atlas。

采用 `topics` map + `tabs` map + id 数组引用，而不是深层嵌套对象，方便拖拽移动、删除子树、import merge 和未来同步。

```json
{
  "schemaVersion": 1,
  "maxDepth": 3,
  "rootTopicIds": ["topic_1", "topic_2"],
  "topics": {
    "topic_1": {
      "id": "topic_1",
      "name": "Chrome Extension",
      "note": "Manifest V3, storage, permissions, context menu.",
      "children": ["topic_2"],
      "tabIds": ["source_1"],
      "createdAt": "2026-05-07T10:00:00.000Z",
      "updatedAt": "2026-05-07T10:00:00.000Z"
    },
    "topic_2": {
      "id": "topic_2",
      "name": "Manifest V3",
      "note": "",
      "children": [],
      "tabIds": [],
      "createdAt": "2026-05-07T10:00:00.000Z",
      "updatedAt": "2026-05-07T10:00:00.000Z"
    }
  },
  "tabs": {
    "source_1": {
      "id": "source_1",
      "title": "Chrome Extensions Docs",
      "url": "https://developer.chrome.com/docs/extensions",
      "note": "Official docs. Start here for API limits.",
      "createdAt": "2026-05-07T10:00:00.000Z",
      "updatedAt": "2026-05-07T10:00:00.000Z"
    }
  }
}
```

### Topic 规则

- Topic 必须有非空 `name`。
- Topic 的 `note` 是可选纯文本，可以为空。
- 一级 topic 的 id 出现在 `rootTopicIds`。
- 二级和三级 topic 的 id 出现在父 topic 的 `children`。
- 同一个父 topic 下，子 topic 名称不允许重复。
- `rootTopicIds` 中的一级 topic 名称不允许重复。
- 不同父 topic 下可以有同名 topic。
- Topic 最深只能到 3 层。
- 三级 topic 不能再创建子 topic。
- Topic 可以没有子 topic，也可以没有 tab source。

### Tab Source 规则

- Tab source 必须有非空 `url`。
- Tab source 的 `title` 可以为空；为空时用 URL 生成 fallback title。
- Tab source 的 `note` 是可选纯文本，可以为空。
- Tab source 只属于一个 topic，不做跨 topic 共享。
- Tab source 的 title 允许重复。
- 不同 topic 下允许保存相同 URL。
- 同一个 topic 下重复保存规范化后相同 URL 时，更新已有 tab source，并移动到该 topic 的 `tabIds` 末尾。

### 删除规则

删除 topic 时：

- 从父级 `children` 或 `rootTopicIds` 中移除该 topic id。
- 删除该 topic。
- 递归删除所有子 topic。
- 删除该 topic 及其子 topic 关联的 tab sources。

删除 tab source 时：

- 从所属 topic 的 `tabIds` 中移除 tab source id。
- 从 `tabs` map 中删除该 tab source。

## Home View

Tab Atlas 主页只展示一级知识点 list，不展开树。

每个 list item 展示：

- 一级知识点名称。
- note 摘要。
- 子知识点总数。
- tab source 总数。
- 更新时间。
- 操作：进入、编辑、删除。

主页操作：

- `Add topic`：新增一级知识点。
- `Edit`：编辑一级知识点名称和 note。
- `Delete`：删除一级知识点，需要确认，并提示会删除全部子知识点和关联 tabs。
- 点击名称或 `Open`：进入该一级知识点详情页。
- 搜索：只搜索一级知识点的 `name` 和 `note`。

主页排序：

- MVP 默认按 `updatedAt` 倒序展示。
- MVP 不支持拖拽排序一级知识点。
- 后续如果需要手动排序，可以在 `rootTopicIds` 顺序基础上增加首页拖拽。

空状态：

- 标题提示用户创建第一个知识点。
- 主按钮 `Add topic`。
- 不展示示例数据或预置 topic。

## Detail View

详情页展示某个一级知识点的完整展开树。一级知识点本身也参与展示，能有 note 和 tab sources。

```text
Chrome Extension
├── note
├── tabs
│   └── Chrome Extensions Docs
├── Manifest V3
│   ├── note
│   ├── tabs
│   └── Service worker
└── Storage
    └── chrome.storage.local
```

详情页顶部：

- `Back to Atlas`
- 当前一级知识点名称。
- 搜索输入。
- 一级知识点操作：编辑、删除、添加二级 topic、添加 tab。

每个 topic 块展示：

- topic 名称。
- topic note。
- 关联 tab sources。
- 操作：添加子 topic、添加 tab、编辑、删除。

最大深度交互：

- 一级 topic 可以添加二级 topic。
- 二级 topic 可以添加三级 topic。
- 三级 topic 不能添加子 topic，只能添加 tab source。
- 三级 topic 上不展示 `Add subtopic`。
- 如果通过快捷入口触发超过最大深度的操作，显示轻提示 `Maximum depth is 3`，不改变数据。

Tab source 展示：

- title。
- URL 或 domain/path 摘要。
- note。
- 操作：打开、编辑、删除、拖拽。

详情页默认完全展开，不持久化展开/收起状态。MVP 不做折叠，因为 Tab Atlas 的核心价值是看清知识结构。

## 表单

### Topic 表单

字段：

- `name`：必填。
- `note`：可选多行纯文本。

校验：

- name 去掉首尾空白后不能为空。
- 同一个父 topic 下，不能与已有同级 topic 重名。
- 新增一级 topic 时，不能与已有一级 topic 重名。
- 编辑 topic 时，允许保持原名；改名后仍需满足同级唯一。

保存：

- 新增 topic 默认追加到同级末尾。
- 编辑 topic 更新 `updatedAt`。
- topic 变更需要向上更新所属一级 topic 的 `updatedAt`，用于主页排序。

### Tab Source 表单

字段：

- `url`：必填。
- `title`：可编辑，可以为空。
- `note`：可选多行纯文本。

新增流程：

1. 用户在某个 topic 下点击 `Add tab`。
2. 输入 URL。
3. 规范化并校验 URL。
4. 对 `http:` 和 `https:` 尝试获取页面标题。
5. 打开确认状态，展示 title、url、note。
6. 用户确认后保存。

编辑流程：

- 编辑 title、url、note。
- URL 改动后重新做规范化和同 topic URL 去重。
- 如果编辑后的 URL 与同 topic 下其他 tab source 重复，合并到已有项，或阻止保存并提示。MVP 建议阻止保存，避免编辑时意外覆盖备注。

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
- 使用 `new URL()` 解析。
- 保存完整 URL，保留 path、query、hash。

标题获取规则：

- `http:` 和 `https:`：可复用现有临时后台 tab 获取标题能力。
- `chrome:`, `chrome-extension:`, `about:`, `file:`：不主动创建临时 tab 获取标题，使用 URL fallback，用户可编辑。
- 标题获取失败、超时或被浏览器阻止时，不阻止保存。

打开规则：

- 点击 tab source 调用 `chrome.tabs.create({ url })`。
- 如果 Chrome 拒绝打开某些 URL，显示 toast。
- 可尝试将 URL 复制到剪贴板作为 fallback。

## 拖拽规则

MVP 支持在一级知识点详情页内部拖拽。

允许：

- 二级 topic 在当前一级 topic 下排序。
- 三级 topic 在同一个二级 topic 下排序。
- 三级 topic 移动到当前一级 topic 下的其他二级 topic 下。
- tab source 在同一个 topic 内排序。
- tab source 移动到当前一级 topic详情页内任意 topic 的 tab list。

禁止：

- 跨一级知识点拖拽。
- 首页一级知识点之间拖拽排序。
- 把二级 topic 拖到二级 topic 或三级 topic 下面。
- 把三级 topic 拖到一级 topic 下面成为二级 topic。
- 把任何 topic 拖到自己的后代下面。
- 任何会导致深度超过 3 的拖拽。
- 把 tab source 拖到 Tab Stash 或 Dashboard。

拖拽落点：

- topic 可以落在合法父级的 topic list 中。
- tab source 可以落在任意 topic 的 tab list 中。
- 非法落点不改变数据，并显示轻提示。

MVP 不要求 topic 和 tab source 混排。每个 topic 内部可以固定展示：

```text
Topic header
Topic note
Tab source list
Child topic list
```

tab source 在 `tabIds` 中排序，child topic 在 `children` 中排序。

## 搜索

Home 搜索：

- 搜索一级 topic 的 `name` 和 `note`。
- 不搜索子树。
- 搜索结果仍以一级 topic list 形式展示。

Detail 搜索：

- 搜索当前一级 topic 子树内的：
  - topic `name`
  - topic `note`
  - tab source `title`
  - tab source `url`
  - tab source `note`

展示规则：

- 详情页默认完全展开。
- 搜索时可以只展示命中的 topic、命中的 tab source，以及必要祖先 topic。
- 清空搜索后恢复完整树。
- MVP 不要求复杂高亮；如果实现成本低，可以高亮命中文本。

## Import / Export

Export：

- 现有 JSON 备份增加 `data.tabAtlas`。
- 文件名继续沿用：

```text
tab-hub-backup-YYYY-MM-DD.json
```

Replace import：

- 直接替换整个 `tabOutStore`，包括 `data.tabAtlas`。

Merge import：

- 一级 topic 按同级名称合并。
- 同一父 topic 下的子 topic 按名称合并。
- 同一个 topic 下的 tab source 按规范化 URL 合并。
- 合并 tab source 时，导入版本更新 title、url、note，并移动到该 topic 的 `tabIds` 末尾。
- 不同 topic 下相同 URL 不合并。
- tab source title 重复不影响导入，因为 title 不参与唯一性判断。
- 如果导入数据中同一个父 topic 下存在重名 topic，normalize 时保留第一个，后续重名 topic 自动重命名或提升为 `Name (imported)`。MVP 建议自动追加后缀，避免静默丢数据。

Import summary 需要增加 Tab Atlas 统计：

- 新增一级 topics 数。
- 新增子 topics 数。
- 新增 tab sources 数。
- 更新 tab sources 数。

## 数据 normalize 与恢复

轻度损坏自动修复：

- 缺少 `tabAtlas` 时创建空结构。
- `rootTopicIds` 不是数组时置为空数组。
- `topics` 或 `tabs` 不是对象时置为空对象。
- topic 缺少 `children` 或 `tabIds` 时置为空数组。
- topic 或 tab 缺少时间戳时补当前时间。
- `children` 指向不存在 topic 时移除引用。
- `tabIds` 指向不存在 tab source 时移除引用。
- 超过 3 层的 topic 不继续展示；normalize 时可以提升为最近合法层级或自动丢入该 Atlas 下的 `Imported overflow` topic。MVP 建议创建 `Imported overflow`，避免丢数据。
- 同级重名 topic 自动追加后缀，例如 `Storage (2)`。

严重损坏恢复：

- 如果 `data.tabAtlas` 不是对象，创建新的空 Tab Atlas。
- 将原始损坏数据保存到 recovery key，例如 `tabAtlasRecovery:<timestamp>`。
- 不阻塞 Dashboard 和 Tab Stash。

## 错误处理

- 空 topic 名称：表单内提示，不关闭 modal。
- 同级 topic 重名：表单内提示，不关闭 modal。
- 空 tab URL：表单内提示，不关闭 modal。
- URL 无法解析：表单内提示，不关闭 modal。
- 不支持的 scheme：表单内提示，不关闭 modal。
- 标题获取失败：使用 URL fallback title。
- Storage 写入失败：保留表单状态并提示保存失败。
- 删除 topic：必须确认，并说明会删除子知识点和关联 tabs。
- 非法拖拽：不改变数据，并轻提示。
- 打开 URL 被 Chrome 阻止：toast 提示，并尝试复制 URL。

## UI 形态

Tab Atlas 应保持工具型、信息密度适中的风格，和现有 Dashboard / Tab Stash 一致。

主页建议使用 list，而不是卡片墙：

```text
Tab Atlas
[Search Atlas...] [Add topic]

Chrome Extension
Manifest V3, storage, permissions, context menu.
12 topics · 38 tabs · Updated today                    Open  Edit  Delete

AI Agents
Agent runtime, planning, tool use, evals.
8 topics · 21 tabs · Updated yesterday                 Open  Edit  Delete
```

详情页建议使用缩进树 + topic section：

```text
Back to Atlas
Chrome Extension                                  Edit  Delete
Manifest V3, storage, permissions, context menu.

Tabs
- Chrome Extensions Docs
  Official docs. Start here for API limits.

Topics
  Manifest V3
    note...
    Tabs
    - Service worker lifecycle

  Storage
    note...
    Tabs
    - chrome.storage.local
```

按钮和交互应避免大段解释性文本。空状态可以简洁说明用途，但不需要在页面里长篇介绍功能。

## 权限

MVP 不需要新增权限。

继续使用现有能力：

- `tabs`：读取当前 tab 信息、打开 tab、临时获取 title。
- `storage`：保存本地数据。
- `favicon`：如需展示 favicon，可继续用 Manifest V3 `_favicon` URL。

右键加入 Tab Atlas 不进 MVP；后续实现时再复用已有 `contextMenus` 权限和 tree picker 思路。

## 测试策略

纯函数或轻量脚本验证：

- 创建空 Tab Atlas。
- 新增一级 topic。
- 新增二级 topic。
- 新增三级 topic。
- 阻止创建四级 topic。
- 阻止同级 topic 重名。
- 允许不同父级 topic 同名。
- 新增 tab source。
- 允许 tab source title 重复。
- 同 topic 重复 URL upsert。
- 不同 topic 相同 URL 不合并。
- 删除 topic 子树和关联 tabs。
- 删除 tab source。
- 合法拖拽 topic。
- 阻止非法拖拽 topic。
- 合法拖拽 tab source 到其他 topic。
- Home 搜索。
- Detail 搜索。
- normalize 损坏数据。
- import merge 同名 topic。
- import merge 同 topic URL。

手动验收：

- 新 tab 默认仍进入 Dashboard。
- Tab Atlas 默认显示在导航中。
- Settings 可以关闭 Tab Atlas，关闭后入口隐藏。
- 关闭后再开启，原数据仍存在。
- Tab Atlas 主页只显示一级知识点 list，不展开。
- 新增、编辑、删除一级知识点。
- 点击一级知识点进入详情页。
- 详情页完整展开 3 层知识树。
- 一级、二级、三级 topic 都可以添加 tab source。
- 一级、二级 topic 可以添加子 topic。
- 三级 topic 不显示添加子 topic 操作。
- Topic 和 tab source 的 note 能保存并刷新后保留。
- 详情页内部拖拽 topic 和 tab source 后刷新顺序保留。
- 搜索能查到 topic note 和 tab note。
- Export 包含 Tab Atlas 数据。
- Import merge / replace 能恢复 Tab Atlas 数据。

## 实施顺序建议

1. 扩展 store normalize，新增 `features.tabAtlas` 和 `data.tabAtlas` 默认结构。
2. 为 Tab Atlas 增加纯数据操作函数：create、update、delete、move、search、normalize、merge。
3. 将 export/import 统计与 merge 逻辑扩展到 `data.tabAtlas`。
4. 在 app shell 中增加 Tab Atlas 导航、Settings 开关和路由 hash。
5. 实现 Tab Atlas Home view。
6. 实现一级 topic 新增、编辑、删除和详情页进入。
7. 实现 Detail view 的完整展开树。
8. 实现 topic 和 tab source 表单。
9. 实现 URL normalize、title fallback 和 tab 打开。
10. 实现详情页内部拖拽。
11. 实现 Home / Detail 搜索。
12. 补充 README 和 AGENTS.md 的安装介绍中对 Tab Atlas 的说明。
13. 做手动验收和必要的轻量测试脚本。

## 后续增强

- 首页一级 topic 手动排序。
- 右键菜单 `Add current page to Tab Atlas`，并选择目标 topic。
- 最近使用 topic 快捷选择。
- 折叠/聚焦某个 topic。
- 更丰富的搜索高亮。
- Markdown note 渲染。
- 批量移动 tab sources。
- 从当前打开 tabs 批量加入某个 topic。
- 与 Chrome bookmarks 的只读导入。
- 更明确的关系类型，例如依赖、递进、并列。
