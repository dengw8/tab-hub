# Open Tabs Session Transfer 技术方案

## 背景

Tab Hub 当前已经支持通过 toolbar popup 导出和导入 `tabOutStore`，用于在 Chrome、Edge、Edge Beta 之间迁移 Tab Hub 自己的数据。这个能力覆盖 Common sites、Saved for later、Tab Stash 和 Tab Atlas，但不覆盖“当前浏览器已经打开的 tabs”。

用户希望一键导出当前浏览器已经打开的 tabs，并导入到另一个浏览器中。关键要求是保留浏览器原生 tab group：如果导出前有 3 个 tabs 在分组 `A` 中，导入后这 3 个 tabs 仍应在目标浏览器的原生分组 `A` 中。

这个功能要保持 Tab Hub 的 local-first 边界：

- 不引入服务器、账号、远程同步或第三方服务。
- 使用本地 JSON 文件迁移。
- 支持 Edge -> Chrome 和 Chrome -> Edge 双向互导。
- 在目标浏览器不支持原生分组时，仍尽量恢复 tabs，并用低打扰提示说明分组未恢复。

## 市场和必要性

市面上已有类似能力，但 Tab Hub 仍有开发必要。

已有能力：

- Chrome 官方支持 tab groups，并可在同一 Google 账号下同步 tab group 变化。参考：<https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en-CA>
- Edge 官方支持 tab groups，可手动或自动组织、命名和设置颜色。参考：<https://www.microsoft.com/en-us/edge/features/tab-groups>
- Tabox 支持保存 open tabs/tab groups、导入导出和 Google Drive 同步。参考：<https://chromewebstore.google.com/detail/tabox-save-and-share-tab/bdbliblipiempfdkkkjohnecmeknnpoa>
- Nice Tab Manager 支持保存浏览器原生 tab groups，并恢复为原生 tab groups。参考：<https://chromewebstore.google.com/detail/nice-tab-manager/fonflmjnjbkigocpoommgmhljdpljain>
- Tab Deck 支持 session 和 tab group 恢复。参考：<https://www.tabdeck.so/>

Tab Hub 的机会点：

- Tab Hub 不做账号和云同步，强调本地 JSON 迁移。
- Chrome 原生同步依赖 Google 账号，不解决 Chrome -> Edge 这种跨浏览器迁移。
- 现有 Tab Hub toolbar popup 已经有 Data transfer 入口，新增 open tabs session transfer 的产品位置自然。
- 这个功能可以是轻量迁移工具，不需要扩展成完整 session manager。

结论：有必要开发，但第一版范围应克制。目标是“当前浏览器现场的一次性迁移”，不是长期 session 管理、云同步或收藏系统。

## 目标

- 在 toolbar popup 中新增一键导出当前打开 tabs 的入口。
- 支持导出所有普通浏览器窗口中的可恢复 tabs。
- 支持导出每个窗口内的 tab 顺序、active tab、pinned 状态和原生 tab group 关系。
- 支持导出 tab group 的名称、颜色和折叠状态。
- 支持从 Edge 导出的文件导入到 Chrome。
- 支持从 Chrome 导出的文件导入到 Edge。
- 支持 Edge Beta 和 Chrome Beta，只要目标浏览器提供对应 Chromium extension API。
- 导入时优先恢复为目标浏览器的原生 tab groups。
- 目标浏览器不支持分组时，仍打开 tabs，保持窗口顺序和组内连续顺序。
- 对 unsupported URLs 做跳过或转换，不中断整个导入。
- 导入提示保持短小，不逐条弹出 warning，不显示大型结果弹窗。

## 非目标

- 不做远程同步。
- 不接入 Google Drive、Microsoft Account、OneDrive、WebDAV 或其他云服务。
- 不保存 cookie、登录态、表单状态、页面历史栈、滚动位置或页面内临时状态。
- 不导出 incognito/private 窗口。
- 不恢复 Chrome/Edge saved tab group 的账号同步元数据。
- 不恢复 `chrome.tabGroups.TabGroup.shared` 之类跨浏览器语义不稳定的字段。
- 不默认把导入失败或未分组的数据写入 Tab Stash。
- 不合并到现有窗口，第一版始终新建窗口恢复。
- 不做自动 dedupe；浏览器现场迁移应保留重复 tabs。
- 不把这个功能并入 `tabOutStore` 的 merge/replace 流程。

## 推荐交互

Toolbar popup 的 Data transfer 区域拆成两个紧凑分组：

```text
Data transfer
Move Tab Hub data and open tabs with local JSON files.

[Export data] [Import merge] [Replace data]
[Export open tabs] [Import open tabs]
```

导出：

- 用户点击 `Export open tabs`。
- popup 读取当前所有普通窗口和 tabs。
- 生成 `tab-hub-open-tabs-YYYY-MM-DD.json`。
- popup 显示短提示：

```text
Exported 42 tabs in 3 windows.
```

导入：

- 用户点击 `Import open tabs`。
- 选择 JSON 文件。
- 如果文件有效且 tab 数不大，直接导入。
- 如果将打开超过 50 个 tabs，显示一次短确认：

```text
Open 86 tabs in 3 windows?
```

- 导入后只显示一条 compact summary：

```text
Opened 42 tabs, restored 5 groups, skipped 3 pages.
```

低打扰原则：

- 不使用 `alert()`。
- 不在成功后弹大型 modal。
- 不逐条显示 skipped URL。
- skipped/warnings 详情只写入 console。
- popup 内只用现有 `setMessage()` / `setError()` 模式。
- 如果目标浏览器不支持原生分组，只显示一句摘要：

```text
Opened 42 tabs without native groups.
```

## 跨浏览器兼容策略

导出文件必须是浏览器无关格式，不能持久化浏览器当前会话里的原生 `groupId`。`groupId` 只在本浏览器本次会话中有效，Edge 导出的 `groupId` 对 Chrome 没有意义，Chrome 导出的 `groupId` 对 Edge 也没有意义。

导出时生成 Tab Hub 自己的逻辑 `groupKey`：

```text
source window 0, native group 123 -> groupKey "w0-g0"
source window 0, native group 456 -> groupKey "w0-g1"
source window 1, native group 23  -> groupKey "w1-g0"
```

tab 只保存 `groupKey`。导入时在目标浏览器重新创建原生分组，并建立 `groupKey -> target groupId` 的临时映射。

兼容矩阵：

| 导出浏览器 | 导入浏览器 | 第一版预期 |
| --- | --- | --- |
| Edge | Chrome | 恢复窗口、tab 顺序、分组名、颜色、折叠状态 |
| Chrome | Edge | 恢复窗口、tab 顺序、分组名、颜色、折叠状态 |
| Edge Beta | Chrome | 按目标浏览器 API 能力恢复 |
| Chrome | Edge Beta | 按目标浏览器 API 能力恢复 |

目标浏览器能力不按浏览器名称硬编码，而是 runtime 检测：

```js
const canGroupTabs = !!(chrome.tabs && chrome.tabs.group);
const canUpdateGroups = !!(chrome.tabGroups && chrome.tabGroups.update);
const canQueryGroups = !!(chrome.tabGroups && chrome.tabGroups.query);
const canRestoreNativeGroups = canGroupTabs && canUpdateGroups;
```

Chrome MV3 支持 `chrome.tabGroups`，Edge MV3 桌面端也支持 `tabGroups`。参考：

- <https://developer.chrome.com/docs/extensions/reference/api/tabGroups>
- <https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support>

## 不支持分组时的兜底

导入恢复分三层：

1. 完整恢复
   - 目标浏览器支持 `chrome.tabs.group` 和 `chrome.tabGroups.update`。
   - 创建新窗口，打开 tabs，按 `groupKey` 创建原生分组。
   - 恢复 group title、color、collapsed。

2. 半恢复
   - 目标浏览器能 `tabs.group`，但无法完整 `tabGroups.update`。
   - 创建原生分组，但 title/color/collapsed 不保证全部恢复。
   - 用户只看到 compact summary，详情写 console。

3. 无分组恢复
   - 目标浏览器不支持原生分组 API。
   - 仍创建窗口并打开所有可恢复 tabs。
   - 保持导出文件中的窗口顺序和 tab 顺序。由于原生 tab group 在 tab strip 中天然连续，组内 tabs 也会连续出现。
   - 不写入 Tab Stash，不创建替代数据。
   - popup 只提示：

```text
Opened 42 tabs without native groups.
```

如果未来要增强，可以增加显式选项 `Save groups to Tab Stash`，将每个 group 保存为一个 Stash folder。但这不属于第一版。

## URL 兼容和跳过规则

导入文件可能来自另一个浏览器，URL 不能全部原样创建。

允许直接恢复：

- `http:`
- `https:`
- `file:`，前提是目标浏览器允许扩展打开 file URL；失败则跳过并计数
- `about:blank`

特殊转换：

- `chrome://newtab`
- `chrome://new-tab-page`
- `edge://newtab`
- `about:newtab`

这些统一恢复为“创建一个没有 URL 的新 tab”，让目标浏览器显示自己的 new tab page。对于 Tab Hub 用户，这通常会打开目标浏览器已安装的 Tab Hub new tab。

默认跳过：

- `chrome://settings`、`chrome://extensions` 等非 newtab 的 Chrome 内部页面
- `edge://settings`、`edge://extensions` 等非 newtab 的 Edge 内部页面
- `brave://`、`vivaldi://` 等其他浏览器内部页面
- `chrome-extension://...`，因为跨浏览器 extension id 不可靠
- `devtools://...`
- 无法解析或目标浏览器 API 拒绝创建的 URL

跳过行为：

- 不中断整个导入。
- 计入 `skippedTabs`。
- popup summary 只显示 skipped 数量。
- 具体 URL 和 reason 写入 console。

## 文件格式

新增 export format，不复用 `tab-hub-backup`：

```json
{
  "format": "tab-hub-open-tabs-session",
  "formatVersion": 1,
  "exportedAt": "2026-05-20T10:00:00.000Z",
  "app": {
    "name": "Tab Hub",
    "version": "1.0.0"
  },
  "source": {
    "browser": "Microsoft Edge",
    "userAgent": "...",
    "extensionVersion": "1.0.0"
  },
  "windows": [
    {
      "key": "w0",
      "index": 0,
      "focused": true,
      "groups": [
        {
          "key": "w0-g0",
          "title": "A",
          "color": "blue",
          "collapsed": false,
          "firstTabIndex": 3
        }
      ],
      "tabs": [
        {
          "title": "Example",
          "url": "https://example.com/",
          "index": 3,
          "active": false,
          "pinned": false,
          "groupKey": "w0-g0"
        }
      ]
    }
  ]
}
```

字段规则：

- `format` 必须等于 `tab-hub-open-tabs-session`。
- `formatVersion` 第一版为 `1`。
- `windows` 只包含 normal windows，不包含 incognito/private windows。
- `groups` 按其在窗口中的首次 tab index 排序。
- `tabs` 按原窗口内 `tab.index` 升序排序。
- `groupKey` 为空或缺失表示未分组 tab。
- `color` 必须是 Chromium tabGroups 支持的颜色之一；未知值导入时映射为 `grey`。
- `title` 允许为空字符串。
- `collapsed` 缺失时默认为 `false`。

允许的 group color：

```js
['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
```

## Manifest 权限

当前 manifest 已有：

```json
"permissions": ["tabs", "activeTab", "storage", "contextMenus", "scripting", "favicon"]
```

新增：

```json
"tabGroups"
```

原因：

- `tabs` 权限用于读取 tab URL/title、创建和更新 tabs。
- `tabGroups` 权限用于读取 group title/color/collapsed，并在导入时恢复 group 属性。
- 不新增 host permissions。
- 不新增 downloads 权限，继续使用 popup 中 Blob + anchor download 的本地下载方式。

## 代码组织

第一版改动范围控制在：

- `extension/manifest.json`
- `extension/popup.html`
- `extension/popup.js`
- `extension/background.js`
- `extension/popup.css`
- `README.md`，只更新用户可见功能说明

不修改：

- `tabOutStore` schema
- Tab Stash normalizer
- Tab Atlas normalizer
- Dashboard open tabs grouping 逻辑

职责划分：

- `popup.html`
  - 新增 `Export open tabs` 和 `Import open tabs` 按钮。
  - 复用一个 hidden file input，或新增独立 input，避免和 Tab Hub data import mode 混淆。

- `popup.js`
  - 执行 open tabs session 导出。
  - 读取导入文件，做轻量格式检查。
  - 超过阈值时做一次短确认。
  - 发送 runtime message 给 background 执行导入。
  - 显示 compact summary。

- `background.js`
  - 接收 `tab-hub:import-open-tabs-session` message。
  - 做最终格式校验和 URL 过滤。
  - 创建窗口和 tabs。
  - 按能力恢复原生 tab groups。
  - 返回统计。

导入逻辑放在 background 的原因：

- popup 生命周期短，用户点击后可能关闭。
- background 已经负责跨页面操作和 service worker 流程。
- 批量创建窗口和 tabs 是浏览器级副作用，放 background 更清晰。

## 导出流程

1. 用户点击 `Export open tabs`。
2. `popup.js` 调用 `chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })`。
3. 过滤 incognito/private window。
4. 调用 `chrome.tabGroups.query({})` 获取所有 group。
5. 按 `windowId` 建立 group map。
6. 对每个 normal window：
   - tabs 按 `index` 排序。
   - groups 按窗口内首次 tab index 排序。
   - 为每个 native group 生成逻辑 `groupKey`。
   - 为每个 tab 写入 `groupKey`。
7. 生成 envelope。
8. 调用现有 `downloadJsonFile()` 下载。
9. popup 显示短提示。

导出时不主动跳过内部 URL，因为导出文件应尽量真实记录来源现场。导入时再根据目标浏览器能力和 URL scheme 决定恢复、转换或跳过。

## 导入流程

1. 用户点击 `Import open tabs` 并选择 JSON。
2. `popup.js` 解析 JSON。
3. 检查 `format` 和 `formatVersion`。
4. 统计将创建的 window 数、tab 数、group 数。
5. 如果 tab 数超过 50，显示一次短确认。
6. `popup.js` 发送 runtime message：

```js
{
  type: 'tab-hub:import-open-tabs-session',
  session: payload
}
```

7. `background.js` 再次校验 payload。
8. 对每个 window：
   - 过滤和转换 tabs。
   - 如果没有可恢复 tabs，跳过该 window。
   - 创建新 normal window。
   - 按原顺序创建 tabs。
   - 尽量恢复 pinned 状态。
   - 记录 source tab -> target tab id 映射。
   - 按 groupKey 收集 target tab ids。
   - 如果支持原生分组，为每个 group 调用 `chrome.tabs.group()`。
   - 调用 `chrome.tabGroups.update()` 恢复 title/color/collapsed。
   - 恢复 active tab。
9. 返回 import summary。
10. `popup.js` 显示一条 compact summary。

如果导入过程中部分 tabs 失败：

- 不回滚已经创建的窗口和 tabs。
- 继续导入后续 tabs。
- 返回 skipped/failed 计数。

## 分组恢复细节

完整恢复路径：

```js
const targetGroupId = await chrome.tabs.group({
  tabIds,
  createProperties: { windowId }
});

await chrome.tabGroups.update(targetGroupId, {
  title,
  color,
  collapsed
});
```

注意事项：

- `chrome.tabs.group()` 只能对同一窗口内的 tabs 分组，所以导出文件的 groups 必须属于单个 window。
- 空 group 不恢复。
- 如果 group 只有一个 tab，仍恢复为原生 group。
- 如果某些 tabs 因 URL 不支持被跳过，该 group 用剩余可恢复 tabs 恢复。
- 如果 group 的所有 tabs 都被跳过，该 group 不创建。
- 如果 pinned tab 分组失败，优先保留 tab 打开状态，分组失败只计入 warning。实现时可以先尝试按普通逻辑恢复，失败后从该 group 的 tabIds 中移除失败 tab 并重试一次。

## 导入统计

background 返回：

```js
{
  ok: true,
  summary: {
    windowsCreated: 2,
    tabsOpened: 42,
    groupsRestored: 5,
    groupsOpenedUngrouped: 0,
    skippedTabs: 3,
    failedTabs: 0,
    warnings: 1,
    nativeGroupsSupported: true
  },
  details: {
    skippedTabs: [
      {
        "url": "edge://settings",
        "reason": "Browser internal page cannot be restored across browsers"
      }
    ],
    warnings: [
      "Could not restore collapsed state for group A"
    ]
  }
}
```

popup 只展示 `summary` 生成的短文案。`details` 只写 console。

文案规则：

- 成功且无跳过：

```text
Opened 42 tabs, restored 5 groups.
```

- 有跳过：

```text
Opened 42 tabs, restored 5 groups, skipped 3 pages.
```

- 不支持原生分组：

```text
Opened 42 tabs without native groups.
```

- 没有可恢复 tabs：

```text
No restorable tabs found in this file.
```

## 验证和安全

导入文件只当作数据处理，不执行文件中的任何内容。

校验规则：

- `format` 必须匹配。
- `formatVersion` 必须是支持版本。
- `windows` 必须是数组。
- 每个 window 的 `tabs` 必须是数组。
- URL 必须是字符串。
- group title 转字符串并限制长度，例如 120 个字符。
- tab title 转字符串并限制长度，例如 300 个字符。
- 单次导入超过 50 tabs 时要求一次短确认；超过 1000 tabs 时拒绝导入并提示文件过大。

错误处理：

- JSON 无法解析：`Choose a valid Tab Hub open tabs file`。
- 格式不匹配：`Choose a Tab Hub open tabs export file`。
- 浏览器 API 失败：返回 compact error，例如 `Could not import open tabs`，具体错误写 console。

## 测试计划

自动检查：

```bash
for f in extension/*.js; do node --check "$f" || exit 1; done
git diff --check
```

手动验证：

- Chrome 中创建 1 个窗口，分组 `A` 包含 3 个 tabs，导出后在 Edge 导入，确认 3 个 tabs 仍在原生分组 `A` 中。
- Edge 中创建 1 个窗口，分组 `A` 包含 3 个 tabs，导出后在 Chrome 导入，确认 3 个 tabs 仍在原生分组 `A` 中。
- 验证 group color 恢复。
- 验证 group collapsed 状态尽量恢复。
- 验证多个窗口导入后仍是多个窗口。
- 验证未分组 tabs 和已分组 tabs 的相对顺序。
- 验证 `chrome://newtab` 和 `edge://newtab` 被恢复为目标浏览器的新 tab。
- 验证 `chrome://extensions`、`edge://settings`、`chrome-extension://...` 被跳过，summary 只显示 skipped 数量。
- 临时模拟 `chrome.tabGroups` 不可用，确认 tabs 仍打开且 summary 为 without native groups。
- 验证导入大量 tabs 时只出现一次短确认。
- 验证 popup 里不会出现长列表 warning。

## 实施顺序

1. 在 `manifest.json` 增加 `tabGroups` 权限。
2. 在 popup Data transfer 区域增加 open tabs 导出/导入按钮。
3. 在 `popup.js` 增加 open tabs session export envelope 和下载逻辑。
4. 在 `popup.js` 增加 open tabs import file parsing、短确认和 summary 文案。
5. 在 `background.js` 增加 import message handler。
6. 在 `background.js` 实现 URL 分类、窗口创建、tab 创建、group 恢复和兜底。
7. 更新 `popup.css`，保持按钮布局紧凑。
8. 更新 `README.md`，说明 open tabs session export/import 支持 Chrome/Edge 双向迁移和 tab groups。
9. 运行自动检查。
10. 手动验证 Chrome <-> Edge 双向迁移。

## 验收标准

- Edge 导出的 open tabs JSON 可在 Chrome 导入。
- Chrome 导出的 open tabs JSON 可在 Edge 导入。
- 支持分组的目标浏览器中，group title/color/collapsed 尽量恢复。
- 不支持分组或 group API 失败时，tabs 仍按窗口和顺序打开。
- unsupported URLs 不会中断导入。
- 导入结果只出现一条短提示，不展示大面积 warning。
- 不修改 `tabOutStore` 数据模型。
- 不引入网络请求、账号或远程同步。
