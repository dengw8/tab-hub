# 常用网站功能设计

## 背景

`Tab Out` 目前的新标签页重点放在“查看和整理当前已打开标签页”，并提供 `Saved for later` 作为延后处理能力。当前产品里没有“用户自定义常用网站入口”，因此每次打开新标签页时，用户仍需要手动输入地址、依赖浏览器历史，或把常用站点固定在浏览器书签栏。

本次目标是在 **new tab 页面内** 增加一个由用户自行维护的“常用网站”区块。该能力必须满足以下约束：

- 不内置任何默认网站
- 配置入口直接放在插件内，而不是依赖 Chrome 的独立 options 页面
- 每个站点只要求填写 URL
- 点击站点后在当前 new tab 中打开
- 顺序支持用户手动拖拽调整
- 数据保存在本地，不引入任何服务端或外部依赖

## 目标

- 让用户可以在 `Tab Out` 的新标签页中维护自己的常用网站集合
- 让“打开常用站点”成为进入浏览器后的第一步操作，而不是离开新标签页再找目标页面
- 保持现有产品“纯本地、零配置依赖、轻量 UI”的定位

## 非目标

- 不预置 Gmail、GitHub、YouTube 等默认站点
- 不与 Chrome 书签同步
- 不支持文件夹、分组、标签、搜索
- 不支持自定义名称、图标 URL、颜色或描述
- 不支持用户级“默认在新标签/当前标签页打开”设置，本期固定为当前标签页打开
- 不支持跨设备同步，本期仅依赖 `chrome.storage.local`

## 用户故事

1. 作为用户，我希望在新标签页中直接添加一个常用网站 URL，这样以后打开新标签页时可以一键进入。
2. 作为用户，我希望在页面里编辑或删除某个常用网站，而不必打开额外设置页。
3. 作为用户，我希望拖拽调整顺序，让最常用的网站排在最前面。
4. 作为用户，我希望点击常用网站后直接占用当前 new tab，减少多开一个标签页。
5. 作为用户，我希望即使没有配置任何网站，也能看到清晰的空状态和添加入口。

## 方案选型

### 方案 A：顶部独立区块 + 弹窗表单 + 拖拽排序

这是推荐方案。

- 在 `header` 下方增加一个独立的“常用网站”区块
- 区块内部展示站点列表、添加入口和管理操作
- 添加/编辑使用轻量 modal 完成
- 排序使用浏览器原生 HTML5 Drag and Drop
- 数据存储到 `chrome.storage.local`

优点：

- 符合用户已确认的交互偏好
- 不需要额外页面或权限
- 视觉层级清晰，不和现有 open tabs 混在一起
- 技术实现简单，适配现有纯前端扩展架构

缺点：

- 需要新增 modal 和拖拽交互，前端状态会增加一些复杂度

### 方案 B：作为 open tabs 区域中的一张特殊卡片

- 将“常用网站”渲染成和 domain 卡片相似的一张特殊卡片

优点：

- 视觉复用度高

缺点：

- 容易和“当前已打开 tabs”概念混淆
- 配置型内容和实时标签分组在信息架构上不属于同一层

### 方案 C：右侧栏管理

- 把“常用网站”放到 `Saved for later` 右侧栏的顶部

优点：

- 主区域变更较少

缺点：

- 右栏目前是任务/清单语义，不适合高频导航入口
- 在无 `Saved for later` 内容时会造成布局条件复杂化

结论：采用 **方案 A**。

## 信息架构

新标签页结构调整如下：

1. Header
2. Tab Out duplicate banner（如果有）
3. 常用网站区块
4. Open tabs + Saved for later 主体区
5. Footer

这样“常用网站”位于页面上方，强调它是“进入浏览器后的快捷入口”，而不是整理标签页后的附加功能。

## 数据设计

在 `chrome.storage.local` 中新增 key：`favorites`

数据结构：

```json
[
  {
    "id": "fav_1712345678901",
    "url": "https://github.com/",
    "createdAt": "2026-04-27T10:00:00.000Z"
  }
]
```

说明：

- `id`：稳定主键，用于编辑、删除、拖拽排序
- `url`：用户输入并规范化后的 URL
- `createdAt`：保留创建时间，便于未来扩展，但本期不在 UI 展示

列表顺序即展示顺序；拖拽排序后直接将数组按新顺序整体写回存储。

## URL 规范化与校验

由于用户只输入 URL，本期必须对输入做足够友好的处理。

### 规范化规则

- 去掉首尾空白
- 若缺少协议，默认补 `https://`
- 保留用户填写的路径、查询参数和 hash
- 对可被 `new URL()` 正常解析的值，使用解析后的完整 URL 作为存储值

### 拒绝规则

- 无法被 `URL` 构造函数解析
- 协议属于 `chrome://`、`chrome-extension://`、`about:`、`edge://`、`brave://`
- 空字符串

### 去重规则

本期以“规范化后的完整 URL 完全一致”为重复判断标准。

- 新增时若 URL 已存在，阻止保存并提示“Already added”
- 编辑时若改成另一个已有 URL，也阻止保存

不做 hostname 级去重，因为同一站点的不同路径可能是用户刻意收藏的不同入口。

## 显示规则

每个站点项显示：

- favicon
- 自动生成的名称
- 辅助操作按钮（编辑、删除）

### 名称生成

显示名称不单独存储，渲染时实时计算：

1. 优先复用现有 `friendlyDomain()` 结果
2. 若无命中，则根据 hostname 做去前缀、首字母大写处理
3. 不显示完整 URL，除非 hostname 不可读

示例：

- `https://github.com/` -> `GitHub`
- `https://mail.google.com/mail/u/0/#inbox` -> `Gmail`
- `https://linear.app/my-team` -> `Linear`

### 图标

复用现有 favicon 方案：

```text
https://www.google.com/s2/favicons?domain=<hostname>&sz=16
```

若图标加载失败，则隐藏图标，不影响点击和布局。

## UI 设计

### 区块形态

顶部新增一张独立卡片，延续现有视觉语言：

- 使用 `card-bg`、`warm-gray` 边框、圆角和微弱 hover
- 标题建议为 `Common sites`
- 右侧放 `Add site` 按钮

### 有数据时

- 以 2 到 4 列的紧凑网格展示常用网站项
- 每项是一个可点击块，包含 favicon 和名称
- hover 时显示更明显背景
- 每项右上角或尾部有轻量的编辑/删除控件

### 无数据时

- 显示一段简短说明，例如 “Add the sites you open all the time.”
- 提供主按钮 `Add your first site`

### 弹窗

modal 包含：

- 标题：新增时 `Add site`，编辑时 `Edit site`
- 一个 URL 输入框
- 一个行内错误提示区域
- 底部按钮：`Cancel` / `Save`

本期不做复杂表单，不增加多字段。

## 交互流程

### 新增

1. 用户点击 `Add site`
2. 打开 modal
3. 输入 URL
4. 点击 `Save`
5. 前端做规范化、校验、去重
6. 保存到 `chrome.storage.local`
7. 关闭 modal
8. 刷新常用网站区块
9. toast 提示 `Site added`

### 编辑

1. 用户点击某项的编辑按钮
2. modal 预填当前 URL
3. 保存后覆盖对应项的 `url`
4. 保持原排序和原 `id`
5. toast 提示 `Site updated`

### 删除

1. 用户点击某项的删除按钮
2. 直接删除，不增加二次确认弹窗
3. toast 提示 `Site removed`

理由：删除的是本地快捷入口，不是关闭真实标签页，也不是删除书签，误操作成本较低。

### 点击打开

1. 用户点击网站项主体
2. 当前 new tab 导航到目标 URL

实现优先级：

- 首选使用普通 `<a href="...">`，不设置 `target="_blank"`
- 若某些布局结构导致整块点击难以保证，则退回 `window.location.assign(url)`

### 拖拽排序

1. 用户拖拽某个常用网站项
2. 拖到目标位置后释放
3. 前端更新本地数组顺序
4. 写回 `chrome.storage.local`
5. 重新渲染或局部更新顺序
6. toast 提示 `Order updated`

为了降低实现复杂度，本期只支持鼠标拖拽，不额外覆盖键盘排序或触屏长按拖动。

## 技术设计

### HTML

在 `index.html` 中新增：

- 常用网站区块容器
- modal 容器
- modal 背景层

新增 DOM id 建议：

- `favoritesSection`
- `favoritesGrid`
- `favoritesEmpty`
- `favoriteModal`
- `favoriteForm`
- `favoriteUrlInput`
- `favoriteError`

### JavaScript

在 `app.js` 中新增以下职责：

#### 存储层

- `getFavorites()`
- `saveFavorites(favorites)`
- `addFavorite(url)`
- `updateFavorite(id, url)`
- `removeFavorite(id)`
- `reorderFavorites(fromId, toId)` 或 `moveFavorite(fromIndex, toIndex)`

#### 规则层

- `normalizeFavoriteUrl(input)`
- `isBlockedFavoriteUrl(url)`
- `getFavoriteDisplayName(url)`

#### 视图层

- `renderFavoritesSection()`
- `renderFavoriteItem(item)`
- `openFavoriteModal(mode, item?)`
- `closeFavoriteModal()`
- `renderFavoriteEmptyState()`

#### 交互层

- 使用事件代理处理：
  - 新增按钮
  - 编辑按钮
  - 删除按钮
  - modal 提交
  - modal 关闭
  - 拖拽开始 / 进入 / 放下

### 初始化顺序

`renderDashboard()` 中在渲染 open tabs 前后都可以插入 `renderFavoritesSection()`，推荐放在 header/banners 渲染完成后、主 dashboard 渲染前，以便用户进入页面第一眼就看到常用网站。

## 与现有代码的关系

### 可复用逻辑

- `friendlyDomain(hostname)` 用于站点名称生成
- favicon URL 生成逻辑可沿用现有 tab chips 实现
- `showToast(message)` 直接复用

### 不应复用的部分

- `domainGroups` 相关逻辑只针对实时 open tabs，不应混入 favorites 数据
- `Saved for later` 的 `deferred` 数据结构与语义完全不同，不应共用 key 或渲染流程

## 错误处理

- 存储读写失败：控制台打印 warning，并用 toast 提示 `Could not save site`
- URL 无效：在 modal 内显示行内错误，不关闭弹窗
- 重复 URL：在 modal 内显示行内错误，例如 `Site already exists`
- favicon 加载失败：静默降级

## 可访问性

- modal 打开时将焦点移到 URL 输入框
- `Escape` 关闭 modal
- 关闭按钮和编辑/删除按钮提供可读 `title` 或 `aria-label`
- 拖拽手柄如单独存在，应具备明确提示；若整项可拖拽，需要确保编辑/删除按钮不会触发拖拽误操作

本期不额外实现完整键盘拖拽排序，但 modal 和核心按钮交互需要可用。

## 测试与验证

本项目当前没有自动化测试基础设施，本功能以手工验证为主。

最少验证路径：

1. 首次打开 new tab，显示空状态
2. 添加不带协议的 URL，自动补 `https://`
3. 添加非法 URL，出现错误提示
4. 添加重复 URL，被阻止
5. 点击站点，在当前标签页打开
6. 编辑 URL，展示名称同步变化
7. 删除站点，区块立即更新
8. 拖拽排序后刷新 new tab，顺序保持不变
9. `chrome.storage.local` 无数据或读写异常时页面不崩溃

## 迭代边界

为控制范围，本期只交付：

- new tab 内管理常用网站
- URL-only 表单
- 当前标签页打开
- 鼠标拖拽排序

明确留到后续迭代的可能增强项：

- 自定义名称
- 导入浏览器书签
- 一键从当前打开标签页加入常用网站
- 新标签页打开 / 当前页打开切换
- 同步存储到 `chrome.storage.sync`

## 实施建议

实施时建议先分三步进行：

1. 先完成数据层和基础渲染，确保增删改查可用
2. 再补 modal 校验与 toast 提示
3. 最后加拖拽排序，避免一开始把交互状态耦合得太重

这样可以保证即使拖拽部分需要微调，基础功能也已经稳定可用。
