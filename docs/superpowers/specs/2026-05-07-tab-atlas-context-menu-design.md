# Tab Atlas 右键快捷添加设计

## 背景

`Tab Atlas` 已经作为独立功能落地，用于把 tabs 沉淀到最多 3 层的知识 topic 树中。当前用户需要先进入 Tab Atlas 页面，再在某个 topic 下手动添加 tab source。这个流程适合整理已有资料，但不适合浏览网页时即时捕获。

现有 `Tab Stash` 已支持右键菜单 `Add current page to Tab Stash`。但 Tab Stash 是浅层 folder -> tabs，适合直接在原生右键二级菜单中选择 folder；Tab Atlas 是多层知识树，选择目标 topic、搜索、写 tab note、创建 topic、处理 L3 限制都需要更多上下文，因此不适合把完整操作塞进原生 context menu。

本设计为 Tab Atlas 增加右键快捷入口：用户在任意网页右键后，可以快速把当前页面保存到某个 Atlas topic。

## 目标

- 在浏览器页面右键菜单中新增 `Add current page to Tab Atlas`。
- 点击后打开轻量 picker，而不是展开完整 topic 树原生 submenu。
- picker 中展示当前 tab 的 title 和 URL。
- picker 支持搜索并选择任意已有 topic，包含 L1、L2、L3。
- picker 支持为即将添加的 tab source 输入可选 note。
- picker 支持在添加过程中创建 topic。
- 创建 topic 时仍遵守最大 3 层限制。
- 添加到同一 topic 中已存在的 URL 时更新已有 tab source，并移动到该 topic 内容列表末尾。
- 添加成功后关闭 picker，并给出明确成功状态。
- Tab Atlas 关闭时隐藏右键菜单，并在 picker fallback 中显示关闭状态。

## 非目标

- 不在原生右键菜单中展开完整 Atlas topic 树。
- 不支持从右键菜单直接创建 L2/L3 topic。
- 不支持一次保存到多个 topic。
- 不支持批量保存当前窗口所有 tabs。
- 不支持自动摘要网页内容。
- 不引入远程服务、账号或同步。
- 不改变 Tab Stash 右键菜单行为。

## 推荐交互

右键菜单保持一个入口：

```text
Add current page to Tab Atlas
```

点击后打开 `atlas-picker.html` popup window。窗口宽度建议 480px，高度建议 640px。它不是 toolbar popup，而是和现有 `tree-picker.html` 类似的短任务窗口。

picker 首屏结构：

```text
Tab Atlas
Add current page

[当前页面标题]
[当前页面 URL]

[Search topics...]

Note
[Why is this useful here?]

Topics
▾ L1 agent
  ▾ L2 topic a
      L3 topic d
  L2 topic b

[Create topic]                  [Add to topic]
```

交互原则：

- topic tree 默认展开，方便用户看层级。
- 搜索时只显示匹配 topic 及其祖先路径。
- 单击 topic 行选中目标 topic。
- 选中的 topic 行显示高亮和层级 badge。
- `Add to topic` 在未选中 topic 时禁用。
- `Note` 是可选项，不填也能添加。
- 成功后显示短暂状态并关闭窗口。

## 默认选择

为了减少重复操作，Tab Atlas 记录最近成功添加过的 topic：

```json
{
  "data": {
    "tabAtlas": {
      "recentTopicIds": ["topic_a", "topic_b"]
    }
  }
}
```

规则：

- 成功添加后，将目标 topic id 移到 `recentTopicIds` 开头。
- 最多保留 5 个 id。
- normalize 时过滤不存在的 topic id。
- 打开 picker 时优先选中第一个有效 recent topic。
- 如果没有 recent topic，则选中第一个 L1 topic。
- 如果没有任何 topic，则进入空态。

## 空态

当 Atlas 中没有 topic：

```text
No topics yet.
Create your first topic to save this page into Tab Atlas.

[Topic name]
[Note optional]
[Create topic and add]
```

行为：

- 创建的是 L1 topic。
- 成功后立刻把当前页面作为 tab source 添加到这个 L1 topic。
- 如果 topic 名称为空，显示 `Enter a topic name`。
- 如果 L1 已存在同名 topic，显示 `Topic name already exists here`。

## 创建 Topic

picker 中提供 `Create topic` 入口，用于在不中断保存流程的情况下创建目标 topic。

创建表单字段：

- `Parent topic`：可选；默认当前选中的 topic。
- `Topic name`：必填。
- `Topic note`：可选。

规则：

- 如果当前选中的是 L1 或 L2，则默认在其下创建子 topic。
- 如果当前选中的是 L3，则禁用“在其下创建”，并提示 `Maximum topic depth reached`。
- 用户可以切换父 topic。
- 父 topic 为空时创建 L1 topic。
- 同一个父 topic 下 topic 名称不允许重复。
- 创建成功后自动选中新 topic。
- 用户仍需点击 `Add to topic` 完成添加，除非处于“无 topic 空态”的 `Create topic and add` 流程。

## 添加行为

添加当前页面到 topic 时：

1. 从 `chrome.storage.session` 读取 pending current page。
2. normalize URL，使用和 Tab Atlas app 一致的 URL 比较规则。
3. 找到目标 topic。
4. 如果该 topic 已有同 URL tab source：
   - 更新 title。
   - 更新 note 为 picker 当前 note。
   - 更新 `updatedAt`。
   - 将该 tab source 移到 topic 的 `items` 末尾。
5. 如果不存在：
   - 创建新的 `source_*`。
   - 写入 title、url、note、createdAt、updatedAt。
   - 将 `{ "type": "tab", "id": "source_*" }` push 到目标 topic `items` 末尾。
6. 更新 topic branch 的 `updatedAt`。
7. 更新 `recentTopicIds`。
8. 保存 `tabOutStore`。

添加后不关闭原网页 tab。这个操作是“保存到知识地图”，不是“整理并关闭当前 tab”。

## 数据模型补充

Tab Atlas 基础模型保持不变，只新增 `recentTopicIds`：

```json
{
  "schemaVersion": 1,
  "maxDepth": 3,
  "rootTopicIds": [],
  "topics": {},
  "tabs": {},
  "recentTopicIds": []
}
```

兼容规则：

- 旧数据缺少 `recentTopicIds` 时初始化为空数组。
- import/export 自动包含该字段。
- import merge 时，target recent 优先保留本机最近项，再追加 imported recent 中仍存在的 topic id，最多 5 个。

## Background 设计

新增常量：

```js
const TAB_ATLAS_CONTEXT_MENU_ID = 'tab-out-add-current-page-atlas';
const TAB_ATLAS_PENDING_ADD_KEY = 'tabAtlasPendingAdd';
```

`background.js` 负责：

- 在安装、启动、storage 变化后同步 context menu。
- 当 `features.tabAtlas.enabled === false` 时移除 Tab Atlas menu。
- 点击 `TAB_ATLAS_CONTEXT_MENU_ID` 时，将当前 tab title/url/favicon/sourceTabId/capturedAt 写入 `chrome.storage.session`。
- 打开 `atlas-picker.html`。

pending payload：

```json
{
  "url": "https://example.com/",
  "title": "Example",
  "favIconUrl": "",
  "sourceTabId": 123,
  "capturedAt": "2026-05-07T10:00:00.000Z"
}
```

## Picker 设计

新增文件：

```text
extension/atlas-picker.html
extension/atlas-picker.js
```

样式优先复用现有 `style.css` 中的 picker、topic tree、button、input 风格；必要时补少量 `.atlas-picker-*` class。

`atlas-picker.js` 负责：

- 读取 pending current page。
- 读取并 normalize `tabOutStore`。
- 渲染 topic tree、搜索结果、空态、关闭态。
- 管理 selected topic、note、create topic 表单。
- 执行 add/upsert tab source。
- 保存 store。
- 成功后关闭窗口。

为了降低重复，picker 可以复制当前 `tree-picker.js` 的 store normalize 基础结构，但 Atlas 相关 helper 必须和 `app.js` 保持同一行为：

- `normalizeTabAtlas`
- `normalizeTreeUrl`
- `getComparableAtlasUrl`
- `assertUniqueAtlasTopicName`
- `upsertAtlasTabSource`
- `touchAtlasTopicBranch`

如果后续继续增长，应把这些 shared helper 拆到公共文件；本次可以先保持纯 extension、无 build step 的文件级复用。

## 状态和错误

关闭状态：

```text
Tab Atlas is turned off in Settings.
```

pending 缺失：

```text
Could not find the current page. Try the context menu again.
```

URL 不支持：

```text
This page URL cannot be saved.
```

重复 topic 名：

```text
Topic name already exists here
```

最大层级：

```text
Maximum topic depth reached
```

添加失败：

```text
Could not add this page to Tab Atlas
```

成功：

```text
Added to Tab Atlas
```

## 可访问性和键盘

- `Esc` 关闭 picker。
- topic list 使用 button 行，支持 Tab 聚焦。
- `Enter` 选中 topic 或提交当前表单。
- 搜索框 autofocus。
- 选中 topic 使用 `aria-selected="true"`。
- create topic form 的错误写入可被屏幕阅读器读取的状态区域。

## 测试计划

静态检查：

```bash
node --check extension/background.js
node --check extension/atlas-picker.js
git diff --check
```

手工验证：

- Tab Atlas 开启时右键菜单出现。
- Tab Atlas 关闭时右键菜单消失。
- 从网页右键打开 picker，能看到当前页面 title 和 URL。
- 选择 L1/L2/L3 topic 后添加成功。
- 同 topic 重复 URL 更新已有 tab source，并移动到该 topic 内容末尾。
- note 能保存和更新。
- 没有 topic 时可以创建 L1 topic 并添加当前页面。
- 在 L2 下创建 L3 topic 后可以保存。
- L3 下创建子 topic 被禁止，并显示 `Maximum topic depth reached`。
- 搜索 topic 后仍能添加到正确 topic。
- reload extension 后 context menu 能重新同步。
- import/export 后 `recentTopicIds` 不包含不存在的 topic。

## 后续增强

- 右键菜单二级展示最近 3 个 topic，点击可直接保存。
- picker 中支持 `Open in Tab Atlas`，添加后跳转到目标 topic 详情页。
- 支持保存当前窗口所有 tabs 到同一 topic。
- 支持从 Dashboard open tab 行直接 `Add to Tab Atlas`。
