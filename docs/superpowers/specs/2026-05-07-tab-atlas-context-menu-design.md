# Tab Atlas 右键快捷添加设计

## 背景

`Tab Atlas` 已经作为独立功能落地，用于把 tabs 沉淀到最多 3 层的知识 topic 树中。当前用户需要先进入 Tab Atlas 页面，再在某个 topic 下手动添加 tab source。这个流程适合整理已有资料，但不适合浏览网页时即时捕获。

现有 `Tab Stash` 已支持右键菜单 `Add current page to Tab Stash`。但 Tab Atlas 的目标是把网页保存到知识 topic 中，因此右键入口应该保持轻量：在当前网页上直接弹出一个选择 topic 的短任务弹窗，不跳转到新的 extension page。

## 目标

- 在浏览器页面右键菜单中新增 `Add current page to Tab Atlas`。
- 点击后在当前网页注入一个 Tab Atlas 添加弹窗。
- 弹窗展示当前 page title，并允许选择已有 L1/L2/L3 topic。
- 弹窗支持为即将添加的 tab source 输入可选 note。
- 弹窗不支持搜索 topic。
- 弹窗不支持创建新的 topic。
- 如果 Atlas 还没有任何 L1 topic，点击右键入口时自动创建一个名为 `Default`、note 为空的 L1 topic。
- 添加到同一 topic 中已存在的 URL 时更新已有 tab source，并移动到该 topic 内容列表末尾。
- 添加成功后关闭弹窗，并给出短暂成功状态。
- Tab Atlas 关闭时隐藏右键菜单。

## 非目标

- 不打开 `atlas-picker.html` 或任何新的 tab/window。
- 不在原生右键菜单中展开完整 Atlas topic 树。
- 不支持从右键流程创建 topic。
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

点击后在当前网页上显示 modal：

```text
Tab Atlas
Add current page

[当前页面标题]

Topic
[L1 agent              v]

Note
[Why is this useful here?]

                         [Cancel] [Add]
```

交互原则：

- topic 使用自定义 picker 展示，按树的 DFS 顺序列出所有 topic。
- 展开候选列表时保留层级缩进，如 `L1 agent`、缩进的 `L2 topic a`、更深缩进的 `L3 topic d`。
- 有子 topic 的 topic 行显示展开/收起箭头，类似浏览器收藏夹树；点击箭头只切换该分支，不选择 topic。
- 选中具体 topic 后，trigger 折叠态只显示无缩进文案，如 `L3 topic d`。
- 默认选中最近成功添加过的 topic。
- 如果没有 recent topic，则选中第一个 L1 topic。
- `Note` 是可选项，不填也能添加。
- `Add` 在没有任何 topic 时禁用。
- `Esc`、点击遮罩、点击关闭按钮、点击 `Cancel` 都会关闭弹窗。
- 成功后显示 `Added to Tab Atlas`，随后关闭弹窗。

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
- 打开弹窗时优先选中第一个有效 recent topic。
- 如果没有 recent topic，则选中第一个 L1 topic。
- 如果没有任何 L1 topic，则先自动创建 `Default` L1 topic，再打开弹窗并选中它。

## 默认 L1 Topic

当 Atlas 中没有任何 L1 topic 时，右键入口会自动创建：

```json
{
  "name": "Default",
  "note": "",
  "children": [],
  "tabIds": [],
  "items": [],
  "expanded": true
}
```

行为：

- 自动创建只发生在没有任何可用 L1 topic 时。
- 自动创建发生在弹窗注入前，因此弹窗打开时 topic picker 里会显示 `L1 Default`。
- 默认 topic 不会自动写入 note。
- 用户仍需要点击 `Add` 才会把当前页面保存到 `Default` topic。

## 添加行为

添加当前页面到 topic 时：

1. 从右键点击所在 tab 获取当前页面 `url` 和 `title`。
2. background 读取并 normalize `tabOutStore`。
3. 如果没有任何 L1 topic，自动创建 `Default` L1 topic 并保存。
4. 在当前网页注入 modal，由 modal 发送 `tab-out:add-current-page-to-atlas` runtime message。
5. background 重新读取并 normalize `tabOutStore`。
6. normalize URL，使用和 Tab Atlas app 一致的 URL 比较规则。
7. 找到目标 topic。
8. 如果该 topic 已有同 URL tab source：
   - 更新 title。
   - 更新 note 为弹窗当前 note。
   - 更新 `updatedAt`。
   - 将该 tab source 移到 topic 的 `items` 末尾。
9. 如果不存在：
   - 创建新的 `source_*`。
   - 写入 title、url、note、createdAt、updatedAt。
   - 将 `{ "type": "tab", "id": "source_*" }` push 到目标 topic `items` 末尾。
10. 更新 topic branch 的 `updatedAt`。
11. 更新 `recentTopicIds`。
12. 保存 `tabOutStore`。

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
const TAB_ATLAS_ADD_CURRENT_PAGE_MESSAGE = 'tab-out:add-current-page-to-atlas';
```

`background.js` 负责：

- 在安装、启动、storage 变化后同步 context menu。
- 当 `features.tabAtlas.enabled === false` 时移除 Tab Atlas menu。
- 点击 `TAB_ATLAS_CONTEXT_MENU_ID` 时，如果没有任何 L1 topic，自动创建 `Default` L1 topic。
- 点击 `TAB_ATLAS_CONTEXT_MENU_ID` 时读取 store，拉平成 topic options，并向当前页面注入 modal。
- 如果当前页面不允许注入脚本，只记录 warning，不打开 fallback page。
- 接收 modal 发出的 runtime message，执行添加或更新 tab source。

注入弹窗使用 Shadow DOM，避免页面 CSS 污染弹窗样式，也避免弹窗 CSS 污染页面。

## 状态和错误

关闭状态：

```text
Tab Atlas is turned off in Settings.
```

目标 topic 无效：

```text
Choose a valid topic
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

- `Esc` 关闭弹窗。
- topic picker、note textarea 和 action buttons 支持 Tab 聚焦。
- picker 展开后，`ArrowUp` / `ArrowDown` 在可见 topic 间移动，`ArrowLeft` 收起当前分支，`ArrowRight` 展开当前分支。
- `Enter` 提交当前表单。
- 关闭按钮提供 `aria-label="Close"`。
- 错误和成功状态在弹窗内以文本显示。

## 测试计划

静态检查：

```bash
node --check extension/background.js
node --check extension/app.js
node --check extension/popup.js
git diff --check
```

手工验证：

- Tab Atlas 开启时右键菜单出现。
- Tab Atlas 关闭时右键菜单消失。
- 从普通网页右键打开弹窗，不跳转新页面。
- 弹窗能看到当前页面 title。
- topic picker 能列出 L1/L2/L3 topic。
- 选择 L1/L2/L3 topic 后添加成功。
- 同 topic 重复 URL 更新已有 tab source，并移动到该 topic 内容末尾。
- note 能保存和更新。
- 没有 L1 topic 时，右键入口自动创建 `Default` L1 topic，并在弹窗中选中它。
- reload extension 后 context menu 能重新同步。
- import/export 后 `recentTopicIds` 不包含不存在的 topic。

## 后续增强

- 右键菜单二级展示最近 3 个 topic，点击可直接保存。
- 弹窗中提供 `Open in Tab Atlas`，但仍不在添加流程中强制跳转。
- 支持保存当前窗口所有 tabs 到同一 topic。
- 支持从 Dashboard open tab 行直接 `Add to Tab Atlas`。
