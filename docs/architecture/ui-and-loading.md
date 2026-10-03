# 界面、加载与输入上下文

初始源码基线：`2073ae74747431aab8d529803d4e9f8197262388`。当前行为随本仓库实现维护。
本页介绍[系统总览](system-overview.md)与[功能索引](feature-map.md)中的界面领域。完整运行归属见[运行状态与恢复](run-state-and-recovery.md)，写入证据见[Auto 编辑与撤销](auto-edit-undo.md)。
源码行为、局部测试覆盖和浏览器交互验收分别说明；测试入口用于定位相应验证范围。

## 1. 两个执行世界与两种安装入口

Isolated world 是扩展的隔离 JavaScript 环境，负责面板、状态协调和消息；MAIN world 是 Overleaf 页面环境，负责接触编辑器及页面能力。
两者共享页面 DOM，却拥有各自的 JavaScript 全局环境。WAR（web-accessible resources）允许页面加载指定扩展资源，本身不负责执行脚本。

```text
content-entry.mjs                         ← canonical source inclusion
  ├─ moduleRegistryKernel / shared / content / vendor
  ├─ legacyGlobalRegistry.create(globalThis)
  └─ ContentRuntime.init(dependencies)
          ↑ 构建为 generated/content.bundle.js
          ├─ Direct: manifest.content_scripts
          └─ Managed: bootstrap.registerManagedRuntime
                      → runtimeContext.js + runtime/<bundle>
ContentRuntime
  └─ PageBridgeClient.start / call
      → PAGE_WORLD_SCRIPTS / OPTIONAL_OT_SCRIPTS
      → MAIN world pageBridge.dispatch
```

源码纳入入口为 [content-entry.mjs](../../extension/entries/content-entry.mjs)。[buildContentBundle](../../scripts/build-content-bundle.mjs) 按入口读取经典模块，在隔离包装中构建 IIFE，再生成 bundle 和 metadata/source digest。
因此修改入口里的 import 会改变产物；直接修改生成 bundle 会被后续构建覆盖。该摘要覆盖 content 构建输入，不能独自证明 Native、MAIN world 与当前浏览器加载副本一致。

| 注入面 | 当前入口 | 修改时检查 |
| --- | --- | --- |
| Direct unpacked | [manifest.json](../../extension/manifest.json) 的 `content_scripts` | 当前仅列一个 content bundle；CSS 列表另行维护 |
| Managed runtime | [bootstrap/background.js](../../extension/bootstrap/background.js) 的 `registerManagedRuntime` 读取 [runtime-manifest.json](../../extension/runtime-manifest.json) | 动态注册前校验 manifest，并按已授权站点筛选 matches |
| Managed 路径适配 | [runtimeContext.js](../../extension/bootstrap/runtimeContext.js) | 设置 `__CODEX_OVERLEAF_RUNTIME_PREFIX__ = 'runtime/'`，页面资源 URL 依此加前缀 |
| 页面资源 | Direct WAR 与 [bootstrap manifest](../../extension/bootstrap/manifest.template.json) | Direct 显式条目、Managed `runtime/src/shared/*` 和 `runtime/src/page/*` 等覆盖范围 |

### Registry 与组合根

[ModuleRegistry.define/resolve](../../extension/src/content/moduleRegistryKernel.js) 保存命名定义、解析显式依赖、缓存实例；缺依赖、循环依赖或无有效导出时抛出受控错误。
当前迁移仍兼容旧 `CodexOverleaf*` 全局发布。`define` 通过 getter 延迟解析；[LegacyGlobalRegistry.create](../../extension/src/content/legacyGlobalRegistry.js) 读取 `REQUIRED_MODULES/SUPPORT_MODULES`，构造给 runtime 的 `modules`。
`SUPPORT_MODULES` 中缺失导出同样进入错误集合，名称中的 support 不能解释为可随意缺失。
共享模块仍需遵守初始化顺序：[content-entry](../../extension/entries/content-entry.mjs) 在 `UndoOperations` 之前加载 `StaleGuard`，前者使用其补丁坐标映射；`WritebackSettlement` 将 `UndoOperations` 声明为显式 registry 依赖。修改恢复材料时需同时检查 CommonJS 与浏览器两条装配路径。
[ContentRuntime.init](../../extension/src/content/contentRuntime.js) 是组合入口，向各 controller 注入 getter/callback；该文件仍包含业务流程，不能将其所有内容都归类为纯装配。
runtime 对重复初始化设有标记；发现旧 panel 已在 DOM、runtime 尚未登记时，返回 `stale-panel-before-runtime-init`。这条守卫不能证明所有旧页面都已自动恢复。
异步初始化先加载全局偏好、账号作用域与持久状态，再建立队列、面板和恢复流程；项目列表路由立即挂 dashboard shell，后续填充列表。

### MAIN world 的独立装配

[PageBridgeClient](../../extension/src/content/pageBridgeClient.js) 的 `PAGE_WORLD_SCRIPTS`、`OPTIONAL_OT_SCRIPTS` 与 `injectPageBridge` 是顺序 owner，runtime 只创建并启动 client。
`injectPageBridge` 在 capability 模块之前尝试 OT 可选依赖；这部分失败可继续保留不可用回退，其他必需脚本加载失败使 `call` 返回 bridge unavailable。
`injectScriptOnce` 生成资源 URL，等待 load/error/timeout；列表第三项 `force` 会影响已有脚本节点处理。完成脚本装配后还要 `initializeCapability` 握手。
方法策略来自 [pageRpcContract.METHODS](../../extension/src/shared/pageRpcContract.js)，真正分派位于 [pageBridge.dispatch](../../extension/src/pageBridge.js)；新方法需要同时定义身份、超时、取消和重放语义。
`pageBridge` 用产品版本与 `pageRpcContract.REVISION` 共同判断是否已经安装；两者相同会保留旧实例。Page 实现变化需要重新构造 router 等闭包时，应同步更新共享 revision，使同版本重新注入也加载新行为；client 的响应校验使用同一常量。这不替代实际扩展重载和页面刷新验收。
身份策略须逐方法读取。当前 `ensureReviewing/ensureEditing` 的项目身份仍为 optional，`dispatch()` 仅在传入身份时执行相应守卫；修改页面模式时须核对调用方是否传入捕获的项目身份，参见[Auto 编辑与撤销](auto-edit-undo.md)。

## 2. Panel 与 Settings：DOM 是状态的投影

投影指“把已有状态显示成控件、标签和卡片”。例如按钮勾选状态像仪表指针，持久 owner 决定读数；重建 DOM 时应重新投影，不能借机改写运行历史。

| 表面 | 创建/布局 owner | 行为与数据来源 |
| --- | --- | --- |
| Panel 外壳、launcher、拖动宽度 | [PanelRenderer.create](../../extension/src/content/panelRenderer.js) | runtime `ensurePanelOpen` 提供操作 callbacks；renderer 管理监听器与宽度 |
| `diagnosticsSlot` | [DiagnosticsPanel](../../extension/src/content/diagnosticsPanel.js) | DiagnosticsController 执行检查，结果展示不拥有底层环境状态 |
| `settingsSlot` | [SettingsPanel.create](../../extension/src/content/settingsPanel.js) | 设置 coordinator、全局偏好及对应领域 owner |
| `sessionSlot` | [SessionPanel](../../extension/src/content/sessionPanel.js) | SessionManager、共享会话状态与当前活动会话 |
| `composerSlot` | [ComposerPanel.create](../../extension/src/content/composerPanel.js) | runtime 的提交、取消、模型、上下文、附件 callbacks |
| 时间线滚动与“最新”按钮 | [RunTimelineView](../../extension/src/content/runTimelineView.js)、[RunScrollLayout](../../extension/src/content/runScrollLayout.js) | 前者管理跟随意图与未读步骤，后者在布局变化和重绘后恢复阅读位置 |
| 项目列表 dashboard | [RecentProjects](../../extension/src/content/recentProjects.js) | 账号作用域会话摘要和 SPA route，不应先闪现项目 composer |

侧边入口的启用偏好由 `PanelRenderer.setLauncherVisible/initializeLauncherVisibility` 独立读写扩展 `chrome.storage.local['codex-overleaf:launcher-visible']`，并监听 storage 变化；它不经过会话持久化或 GlobalPreferencesController。
`isLauncherVisible` 返回入口是否启用；实际显示还要求面板关闭。入口点击经 runtime `ensurePanelOpen` 打开面板，关闭按钮经 `closePanel` 调用 `setVisible`，开合状态保存在 DOM 的 `is-open` class 中。
runtime `init` 在加载状态后调用 `ensurePanelOpen`，因此页面刷新会重新打开面板；关闭入口偏好只影响面板关闭后的按钮显示。[popupInstallGuidance](../../test/popupInstallGuidance.test.js) 验证 Popup 的开关消息不改变面板开合，[p1BrowserRegressions](../../test/p1BrowserRegressions.test.js) 检查实际显隐条件；刷新组合行为另需浏览器验收。

`RunTimelineView.bindLogAutoFollow` 从 wheel、touch、pointer 和键盘事件捕获阅读意图，`logAutoFollow` 决定新输出是否继续滚到底部；`scrollLogToBottom` 合并同一帧的滚动请求，并在绘制时复核意图。
“最新”按钮由 `ensureJumpToLatestButton` 创建，点击后调用 `scrollLogToBottom({ force: true })`，重新启用跟随并清空未读步骤数。计数来自离开底部后的离散步骤，原行上的 streaming 增量不会逐块累加。
阅读锚点类似书签：[RunScrollLayout.captureAnchor/snapshot/restore](../../extension/src/content/runScrollLayout.js) 保存可见段落相对容器的偏移，重绘后按运行 ID 与段落索引重绑节点；缺少对应节点时回退到保存的滚动偏移。`renderRunHistory` 仅在 `preserveScroll:true` 且已退出跟随时采用此恢复路径，其他重绘默认强制滚到底部。
[p2UiRegression](../../test/p2UiRegression.test.js) 使用伪 scroller、帧队列和 observer 检查跟随意图、布局收缩与锚点恢复；长流输出、折叠重排、宽度变化和真实滚轮交互仍需浏览器验证。

[SettingsWorkbench.mount](../../extension/src/content/settingsWorkbench.js) 把现有设置 group DOM 移入原生 `<dialog>`，分类由 `CATEGORIES/GROUP_PAGES` 控制，显示范围由 `PROJECT_GROUPS` 等决定。
移动保留已有节点、监听器和草稿；新增控件仍应在 SettingsPanel 中定义读写接口。新增导航按钮不自动建立持久化字段。
`All settings` 与 `This project` 是可见项过滤器；切换过滤器不迁移字段所属作用域。
`show` 使用 `showModal()`，保存进入前焦点；`hide` 关闭后尝试恢复焦点。`requestClose` 先经过 Provider close guard，再通知原关闭回调。
dialog 的 `cancel` 只处理目标为 dialog 的事件，避免文件选择器取消事件误关设置；分类切换和关闭都须保留此生命周期约束。
Provider 通过 `revealProviders` 嵌入工作台；相关编辑器由 [ProviderSettingsDialog](../../extension/src/content/providerSettingsDialog.js) 与 [ProviderSettingsCoordinator](../../extension/src/content/providerSettingsCoordinator.js) 管理。
普通主题选项仍以已有 select 为值入口，Workbench 的主题卡片触发其 input/change；新增视觉代理控件应继续接入既有状态通路。

### 历史查看、清理与结果动作

新建、切换、重命名和单会话删除经 PanelRenderer/SessionPanel 的 runtime callbacks 进入 `SessionManager`。空会话复用、容量确认、手动标题与最后会话重置见[会话生命周期](run-state-and-recovery.md#session-lifecycle)。

[PanelMaintenance.openChangeHistory](../../extension/src/content/panelMaintenance.js) 打开设置历史卡，交给 [ChangeHistoryView.load](../../extension/src/content/changeHistoryView.js) 读取 auditLogs 和 sessions。
后者捕获账号、项目、容器与请求 generation，异步返回后复核；超时或读取失败显示错误及重试入口，不能把失败投影成“没有历史”。历史行通过 runtime 的 `jumpToHistoryRun` 跳转到所属会话与运行。

| 清理入口 | 实际 owner 与范围 | 独立结果与限制 |
| --- | --- | --- |
| 设置中的清空历史 | `PanelMaintenance.clearAllHistoryWithConfirm` → `StorageDb.clearAllStores`，随后重置项目名称缓存、重建会话状态并保存 | 入口检查当前页面 `currentRunView`，通过 destructive confirm 后执行；该入口未调用 Native `codex.history.clearPlugin` |
| 共享历史启用时的清空实现 | [SharedSessionBridge.decorate](../../extension/src/shared/sharedSessionBridge.js) 将会话清理交给 `erase('clear-account')`；同时删除当前账号的站点 legacy 会话备份 | 其他账号的 legacy 会话备份保留；辅助 stores 仍调用站点本地 `clearStore`，其范围不能按会话的账号隔离推定 |
| legacy 存储实现 | [StorageDb.clearAllStores](../../extension/src/shared/storageDb.js) 在当前站点 IndexedDB 事务中清空 `STORES` | 与后台共享账号会话库是不同存储边界；控件位于项目设置过滤器也不会缩小此范围 |
| dashboard 的逐项目清理 | [ProjectSessionCleanup.clearProjectSessions](../../extension/src/content/projectSessionCleanup.js) 按 projectId 查询、按已解析账号过滤，检查近期 running 记录，再确认并写墓碑、删除会话及请求 Native 历史清理 | 会话删除数和 Native 历史清理失败分别统计；剩余记录仍可显示并重试。账号缺失时过滤条件有放行分支，不能从此函数单独推定始终账号隔离 |

清空后的内存归一化还有独立限制：该入口未同时清除旧 `state.session/task`，旧活动会话可被重建；共享墓碑又可能拒绝其再次保存，而 UI 仍显示清理完成。内存重现与持久库是否写入分别判断，详见[清空历史后的状态](run-state-and-recovery.md#clear-history-state)。
这些动作面向插件历史与恢复材料，Overleaf 文件写入、撤销属于其他入口；清理前应分别核对账号共享库、站点辅助库及 Native 历史的范围。
[p0ProductExperience](../../test/p0ProductExperience.test.js) 的清空历史用例和 [dashboardSessions](../../test/dashboardSessions.test.js) 的逐项目清理用例主要检查源码调用结构，不能替代实际持久删除、部分失败与跨标签交互验收。

结果卡按钮由 [RunTimelineView.renderRunCard](../../extension/src/content/runTimelineView.js) 装配 [RunResultActions.configureResultActions](../../extension/src/content/runResultActions.js)。
其中 `configureForkButton` 在记录有 turnId、非 running、非 forkSnapshot 且具有 callback 时启用，再调用 [SessionForkController.forkRunFromNode](../../extension/src/content/sessionForkController.js)。
分叉从所选节点复制历史并建立新 Native thread；来源线程优先级、撤销材料剥离、保存失败补偿及持久化字段缺口见[会话分叉与恢复材料隔离](run-state-and-recovery.md#61-会话分叉与恢复材料隔离)。
Native 分叉等待后的回调缺少当前作用域复核，旧 `previousState` 可能覆盖等待期间的新视图；导航与异步返回的限制见[分叉等待与视图切换](run-state-and-recovery.md#fork-async-state)。
[sessionForkController](../../test/sessionForkController.test.js) 使用真实 controller 与 SessionState，Native 和保存通过依赖替身提供；不能由该测试推定按钮、Native fork 与刷新恢复已联合通过。

## 3. 配置作用域：按写入路径判断

| 作用域 | 代表字段与 owner | 修改后的影响 |
| --- | --- | --- |
| 全局偏好 | [GlobalPreferences](../../extension/src/shared/globalPreferences.js)：theme、locale、preloadProjectContext、skills 总开关及逐项开关 | 通过 [GlobalPreferencesController](../../extension/src/content/globalPreferencesController.js) 发字段 patch、接收 revision 与 storage 事件 |
| 当前项目 | [ProjectSettingsCoordinator](../../extension/src/content/projectSettingsCoordinator.js)：custom instructions、governance；OT 按 project map 保存 | 对应项目后续提交读取这些值 |
| 项目 Provider 选择 | [ProjectProviderSelection.commit](../../extension/src/content/projectProviderSelection.js) | 更新项目及各会话未来默认选择；Provider/revision 变化会重置未来线程绑定，保留已有 runs/pendingInputs |
| 活动会话 | [SessionState](../../extension/src/shared/sessionState.js)：task、mode、requireReviewing、focusFiles、selectionContext 等 | `readPanelInputs/updateActiveSession` 更新当前会话；Track 的实际写入属于此路径 |
| 面板/项目状态字段 | runtime 的 `state.autoRecompile`、panelWidth、composerAttachments | 查 read/persist/load 路径，不能仅按控件位置推断全局或逐会话保存 |
| 已提交运行 | [RunExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js) | 捕获模式、模型、Provider revision、Track/compile、选区等；后续控件变化不应重解释该快照 |

`persistPanelInputs` 先交给全局 controller；识别到全局字段就返回该 patch Promise。普通 task 输入走 debounce 保存，明确控件变更继续读取并持久化。
全局 controller 将 pending patch 投影到本地视图，再接收递增 revision；失败时移除 pending patch 并报告错误。此结构旨在阻止旧会话 autosave 回滚全局偏好。
语言存在三条呈现通路：[i18n](../../extension/src/shared/i18n.js) 的 `tr` 键、runtime 的 `tx(en, zh)`、Popup 的 `utx`。修改翻译需同时检查实际消费者。
[ThemeController.applyTheme/watchAuto](../../extension/src/content/themeController.js) 负责主题效果；全局存储拥有偏好，CSS 与 dialog/浮动工具栏负责正确继承和显示。

### 已提交输入、运行中草稿与编辑重发

三类状态类似已寄出的信、桌上的草稿和等待寄出的信：已提交运行消费 execution snapshot，当前 textarea 的新输入写入活动会话 `task`，排队项保留自己的 text/payload。运行结束、切换会话和重新绘制时，须分别定位各自 owner。

```text
textarea input → persistPanelInputs → readPanelInputs → updateActiveSession → debounce save
提交 → safeRunTask
  ├─ 无当前运行：runTask 等待旧镜像 → 捕获输入 → 准备 Provider/风格 → startRunView → clearTaskComposer
  └─ 有当前运行：queueComposerInput → RunQueueScheduler coordinator → pendingInputs
结果卡 Edit & resend → refillComposerForRetry → prepareRetryReplacement → 会话草稿
```

[contentRuntime](../../extension/src/content/contentRuntime.js) 的 `syncComposerSendAvailability` 在运行中且无文字时呈现取消，有文字时呈现排队发送；`safeRunTask` 将活动运行期间的提交交给队列协调器。
`runTask` 在前次 `pendingMirror` 等待结束后、Provider/风格异步加载前捕获输入。准备期间仅复核账号和项目，`startRunView` 采用届时的活动会话；点击发送不等于会话归属已经固定。
建立 run 后还等待 audit 草稿等步骤，才调用 `clearTaskComposer` 清文字、选区、技能调用及附件；该顺序不能推广为任意提交等待期间的新输入都会保留。等待窗口与运行建立后的身份规则见[运行状态与恢复](run-state-and-recovery.md)。
[PendingInputView.pullBack](../../extension/src/content/pendingInputView.js) 只回填 queued 项，已有非空草稿时提示并返回；实际移除队列项与持久化由回调完成，UI 回填动作本身不提供事务提交证明。队列准入、推进和保存边界见[运行状态与恢复](run-state-and-recovery.md)。

[RunTimelineView.configureEditButton](../../extension/src/content/runTimelineView.js) 对 cancelled/rejected 且通过 `canEditRun` 的记录提供编辑重发，当前存在运行时禁用该按钮。
[PanelMaintenance.refillComposerForRetry](../../extension/src/content/panelMaintenance.js) 回填任务并调用 runtime 的 `prepareRetryReplacement`：符合资格的 cancelled/rejected 记录在无当前运行时回到草稿，并从列表移除原卡，恢复其模式、focused files 和选区；其他符合替换条件的失败重试会记录 `pendingRetryReplacement`，在新 run 创建时解析替换。
资格规则由 [RunController.isRetryReplacementEligible/resolveRetryReplacement](../../extension/src/content/runController.js) 根据写入与恢复材料判断；附件不会随任务文字自动恢复，UI 会提示重新添加。
[runControllerContent](../../test/runControllerContent.test.js) 覆盖资格、会话归属与替换 helper；[p0ProductExperience](../../test/p0ProductExperience.test.js) 另有恢复按钮路由断言。运行中输入、异步提交、队列回填及刷新仍需组合用例，不能只运行纯 helper 就宣称草稿全生命周期通过。

## 4. 模型目录：请求返回顺序与用户选择分开处理

[ModelPicker.loadModelOptions](../../extension/src/content/modelPicker.js) 发出 `codex.models`，请求携带当前 Provider selection；`modelLoadGeneration` 每次加载递增。
成功响应先检查 generation，再检查响应 providerId；自定义 Provider 还比较 providerRevision。旧请求的迟到结果可返回 `{ stale: true }`，不进入目录重绘。
目录元数据由 [Models](../../extension/src/shared/models.js) 与 [ModelPickerSupport](../../extension/src/content/modelPickerSupport.js) 归一化，再渲染 model/reasoning/speed select 及其可视选择按钮。
内建目录缺项或处于 fallback 时，`retainSelectedModel/preserveSelectedCapabilities` 可保留用户显式选择并标为 unverified；这仅保留选择，不能证明远端支持该能力。
自定义 Provider 响应先通过身份/revision 检查，匹配身份但没有可用目录时进入 unavailable；不能把内建 fallback 模型填入自定义 Provider。
**错误包例外。** Native 的 `providerErrorResponse` 不含 result；当前 `loadModelOptions` 在判断 ok 前比较 `Number(response?.result?.providerRevision)`，该值为 NaN 时会先返回 stale。此类错误包不会进入后面的 unavailable/fallback 分支。
排查配置删除或 revision 冲突时，须先检查这段先行守卫，再读 `shouldUseBuiltInFallback`；现有 custom 空目录测试带匹配 revision，不能覆盖无 result 错误包。
模型按钮点击更新 select，再调用 `persistPanelInputs`；Speed 先写入 `state.speedTier` 再渲染能力，避免重绘把刚选值还原。
Provider 显式 Use/Use Built-in 路径切换到不同 Provider 时，会经过 `ProjectProviderSelection.confirmSwitch` 的运行守卫；不能据此推定所有 UI 入口都阻止活动期间切换。
Save and use 可经 `providerSwitchApproved:true` 跳过该确认，删除当前 Provider 的回退也有独立路径，同 ID 的 revision 变化另行处理。应沿 dialog → coordinator → reconcile → commit 核对，API revision、凭据和运行解析还需检查 Native owner。

## 5. 选区、文件上下文与附件

### 选区引用与选区编辑

[SelectionContextView.attach](../../extension/src/content/selectionContextView.js) 捕获 projectId、sessionId、generation，调用 `getSelectionContext` 后以及打开 composer 后分别复核归属。
[SelectionContext.normalize](../../extension/src/shared/selectionContext.js) 校验项目相对路径、非空文本、范围、文档 hash；上限 `MAX_TEXT=20000` 按 JavaScript 字符串长度计算。
范围满足 \(0\le from<to\) 与 \(to-from=|text|\)，并携带 `documentHash`，用于说明选区来自哪个文档版本。
`reference` 模式附加参考内容；`edit` 模式显示“仅此处”，runtime 的 `setSelection` 同时把会话模式设为 Auto。实际局部修改限制还依赖 [selectionScope](../../native-host/src/selectionScope.js)，标签本身不提供执行保证。
Native 的 `prepareSelectionScope` 在 edit 模式读取镜像中的整份文件，要求其 SHA-256 等于 `documentHash`，且 `before.slice(from, to)` 等于选区文本。整份文档摘要像版本指纹，即使变化发生在选区之外，也会以 `selected_context_unresolved` 拒绝本次选区编辑并要求重选。
`filterSelectionChanges` 要求每项均为同一路径的文本 write、`previousContent` 等于基线，并保留选区前缀与后缀；可接受结果满足 \(after=prefix+replacement+suffix\)。该函数使用 `items.every` 整组判定，任一项越界会令 `changes` 为空，并将整组映射为 `selection_scope_violation`，合法项也不会单独保留。
验证选区执行约束时，应覆盖“选区外发生变化但选区文字相同”、前后缀变化、跨文件修改，以及合法项与越界项混合返回；[sentSelectionChip](../../test/sentSelectionChip.test.js) 的历史 chip 验证不能替代 Native 范围校验。
发送后的 `renderSent` 从 run execution snapshot 渲染 chip；草稿移除选区不应删除历史 chip。页面选区探测还检查编辑器焦点、连接状态和 probe generation。

### 文件重点与任务中的 @ 文字

[ContextTray](../../extension/src/content/contextTray.js) 管理 focused files、文件列表和预加载；`getActiveFocusFiles` 读取活动会话的 `focusFiles`，chip 与提交快照均以该列表为依据。`@` 文件上下文与二进制附件各有持久化和消费路径。
runtime 的 `applyAtFileSelection` 在菜单选择文件后同时插入 `@path` 文字，并调用 `selectFocusFile` 更新列表。手工输入或删除 `@path` 只改变任务文字，不会自动增删 focus；从 chip 移除文件同样不会清理任务文字。
`selectFocusFile` 用 `.slice(-5)` 保留最近五项；通过 @ 菜单加入第六个不同文件时，最早的 focus 被替换，runtime 显示提示，原有 @ 文字仍可留在任务中。排查发送上下文应同时检查任务文字、focus 列表及执行快照，不能从文字中的文件名推断结构化 focus。
[contextTray](../../test/contextTray.test.js) 定位列表和 chip 的选择／移除路径；组合验证应覆盖手输、删字、删 chip、第六项替换及提交快照的实际字段。

文件目录由 `ContextTray.loadContextFiles` 发起：`requestContextFiles` 先以 `preferExact:false` 调用 `getProjectFileList`，返回空列表或不可用列表响应时再请求 `exactOnly:true` 的精确列表；首次调用直接抛错则由 `loadContextFiles` 显示读取失败。可用树列表先显示，随后由 `enhanceContextFilesFromExactSnapshot` 尝试精确增强；增强失败保留树列表并标 partial。
精确请求使用 `includeContent:false/includeBinaryFiles:true`，目录准确不等于正文已读取或 Native 镜像已同步。`scheduleContextPrefetch` 根据全局 `preloadProjectContext`、页面可见性和项目身份延迟安排目录读取；`resetContextProject` 清缓存、递增 `contextLoadId` 并重新安排预加载。

### 编译日志上下文与修复草稿

runtime 的 `renderAtFileMenu` 提供 `@compile-log`；`runTask` 在首次模型派发前识别该标记，再通过 [WritebackOrchestrator.resolveCompileLogContext](../../extension/src/content/writebackOrchestrator.js) 请求页面 `getCompileLog`，附带运行项目身份。
[CompileBridge.getCompileLog](../../extension/src/page/compileBridge.js) 根据缓存时间和源文件编辑戳判断新鲜度；当前调用传 `triggerIfStale:true`，过期或无可用记录时可调用 `triggerCompile`。该日志刷新路径未检查 Ask/Auto 或 Auto Compile 开关，因此不能把“Ask 不写回”理解为显式请求日志时绝不会触发编译。
页面缓存和时间戳由 `CompileBridge.create` 拥有。可用日志、错误、警告及新鲜度经 [RunController.buildCodexRunParams](../../extension/src/content/runController.js) 进入 [codexPromptAssembly](../../native-host/src/codexPromptAssembly.js)；日志不可用时记录 `selected_context_unresolved`，普通运行仍可继续派发。
[RunTimelineView.renderCompletionReport](../../extension/src/content/runTimelineView.js) 内的 `appendCompileFix` 将捕获错误与 `@compile-log` 组成草稿，调用 `PanelMaintenance.refillComposerForRetry(null, text)`。点击“修复编译错误”仅回填，实际执行仍需下一次提交。
修改该能力须联动日志新鲜度、Page RPC 身份、保存等待、输入参数及提示组装；相关定义为 [compileAdapter.test.js](../../test/compileAdapter.test.js)、[runControllerContent.test.js](../../test/runControllerContent.test.js)、[codexPromptAssembly.test.js](../../test/codexPromptAssembly.test.js)。页面请求与缓存测试使用模拟对象，不能替代真实 Overleaf 编译验收。

### 多附件异步、预算与恢复

[ComposerAttachments.createComposerAttachmentController](../../extension/src/content/composerAttachments.js) 接收 paste/drop/file input，先去重和预约预算，再等待 FileReader 与图片预览。
`pendingAttachmentKeys` 防止同一文件并发重复读取；预算计入已完成字节和 pending bytes，`finally` 释放预约，避免同时导入绕过总额判断。
`addFiles` 按顺序处理一批文件。校验或读取抛错会提前退出整次调用，后续文件不再读取；此前已经 push 到内部数组的附件仍可被 `getAttachmentsForRun` 取出，但循环后的 `renderComposerAttachments` 被跳过，tray 可能尚未显示这些附件。数量上限的 `break` 与总预算不足的 `continue` 会继续到末尾重绘，须与抛错路径分别判断。
批量导入验证应包含“有效文件 → 空文件或读取失败 → 有效文件”，同时检查错误提示、内部待发送列表、tray 和后续文件读取次数；单文件成功或 pending 去重不能证明批次失败后已全部回滚。
普通 composer 的准入配置来自 runtime：\(n\le8\)、每件 \(b_i\le12\,\mathrm{MiB}\)、\(\sum b_i\le32\,\mathrm{MiB}\)。空附件被拒绝；该规则与合法空项目文件的语义不同。
**清空与在途读取的数量边界。** `clear` 清空附件及 pending keys，未撤销读取或设置代次屏障；旧读取完成后仍可 push。先由并发 `addFiles` 调用启动 8 个在途读取，clear 后再启动 8 个新读取，全部完成可出现 16 件待发附件。一次批量调用内部顺序 await，不能将上述场景误写成单批同时读取 8 件。总字节预约未同时清零，该反例不证明字节总额也可绕过；Native 仍独立校验发送配额。
[NativeQuotas](../../native-host/src/nativeQuotas.js) 普通附件保留单件/数量约束，聚合限制为 96 MiB；不能用 Native 更宽上限推断 UI 接受范围。写作风格参考采用另组 quotas。
`getAttachmentsForRun` 包含本次发送内容；`createRunAttachmentSnapshots` 只保留名称、类型、大小与受限预览，避免把完整附件作为历史卡片内容复制。
`serializePersistableAttachments/restorePersistedAttachments` 提供序列化与回填 helper：最多三件，单件 `contentBase64.length <= 1,048,576`；此单位为 Base64 字符。
Base64 长度约为 \(4\lceil B/3\rceil\)，因此该字符阈值不能当作原始文件 1 MiB 限额。runtime 的 `applyStateToPanel` 设有每页仅一次的回填门槛，避免已有状态中的附件在移除后再次出现。

**当前持久链缺口。** `persistComposerAttachmentsToState` 写入顶层 `state.composerAttachments`，[SessionState.prepareStateForStorage](../../extension/src/shared/sessionState.js) 也保留该字段；但 [ScopedPersistencePanelState.persistPanelState](../../extension/src/content/scopedPersistencePanelState.js) 实际写入的 [StorageDb.extractLightweightPrefs/buildSessionRecord](../../extension/src/shared/storageDb.js) 均未包含它。
runtime 的 `loadStoredStateForProject` 正常返回与 compact fallback 返回也不回填该字段，因此上述 helper 与一次性门槛不能证明当前刷新恢复已贯通。
[sessionState](../../test/sessionState.test.js) 中名为“composer attachments persist across refresh”的用例只调用 normalize/compact，未穿过真实存储及 hydration；刷新恢复验证需要覆盖 `saveState → persistPanelState → loadStoredStateForProject → restorePersistedAttachments`。此项与第 9 节的清空/迟到读取竞态分别处理。

`runTask` 在异步 Provider/风格加载前捕获已完成附件，创建 run 后清空 composer；队列协调器拒绝带附件的排队输入，见 [RunQueueScheduler](../../extension/src/content/runQueueScheduler.js)。
清空后迟到读取的实际交互影响仍需浏览器验收，见第 9 节；不能由去重测试推广出完整生命周期保证。

## 6. Markdown、公式和链接的呈现链

### 活动投影与写后回执

事件进入 UI 前已有一层结构化投影：[contentRuntime.appendNativeEvent](../../extension/src/content/contentRuntime.js) 先尝试 `SubagentActivityModel.ingest`，普通事件再交给 [AgentTranscript.mapAgentEventToActivity](../../extension/src/shared/agentTranscript.js)。不可见或 technical 事件在此返回，其他事件进入运行记录及视图。
[RunTimelineView](../../extension/src/content/runTimelineView.js) 创建 [RunActivitySummary](../../extension/src/content/runActivitySummary.js)，后者消费 [RunActivityModel](../../extension/src/shared/runActivityModel.js) 的投影，组织阶段、工具、通知、折叠项和子代理区域；需要富文本的内容继续调用下文 Markdown 链。
活动展开选择写入页面 `sessionStorage`，运行事实另由会话持久化保存。修改折叠展示不能据此改写运行结果或历史。

写后文件回执从 [WritebackOrchestrator.applySyncChangesToOverleaf](../../extension/src/content/writebackOrchestrator.js) 调用 `renderReadOnlyDiffReview`，经 [DiffReviewPanel](../../extension/src/content/diffReviewPanel.js) 使用 runtime 注入的 [WrittenChangesView.render](../../extension/src/content/writtenChangesView.js)。当前常规装配下，逐文件折叠回执的展示 owner 是 WrittenChangesView。
DiffReviewPanel 同时保留 [ReviewHunks](../../extension/src/content/reviewHunks.js) 支持的交互 hunk 决策和 `renderDiffReview`。按该源码基线的静态调用关系，`renderDiffReview` 无生产外部调用；`createDiffReviewElement` 仍可作为未注入回执 renderer 时的只读回退。模块被打包和独立测试存在，不能证明交互式逐块审阅属于当前可达用户流程。
[agentTranscript](../../test/agentTranscript.test.js) 检查事件映射；[subagentActivityView](../../test/subagentActivityView.test.js) 在伪 DOM 中装配共享活动 renderer；[writtenChangesView](../../test/writtenChangesView.test.js) 覆盖回执 helper 并用源码断言检查 runtime 注入；[reviewHunks](../../test/reviewHunks.test.js) 检查纯决策模型。它们各自覆盖局部边界，真实长流、滚动和写后展示仍待验收。

<a id="failure-settlement-actions"></a>

### 失败、结算与恢复动作来源

**当前实现。** 失败说明、运行终态、写回证据和可点击动作经不同路径生成。定位“报告说完成却有告警”或“提示可重试却没有按钮”时，应分别核对下表的生产者与消费者。

| 展示或状态 | 实际来源与入口 | 不能据此推定的内容 |
| --- | --- | --- |
| 跳过项的原因、阶段、下一步 | [ApplyResultFormatters](../../extension/src/content/applyResultFormatters.js) 的 `normalizeSkippedFailure/appendApplyResult` 调用 [FailureReasons.normalizeFailureReason/selectPrimaryFailure](../../extension/src/shared/failureReasons.js) 并本地化 | 展开文案中的分类不保证等于结算保存的分类 |
| 写回事实及其主因 | [WritebackSettlement.settle](../../extension/src/shared/writebackSettlement.js) 经 [WritebackOperationEvidence.normalizeOperationEvidence](../../extension/src/shared/writebackOperationEvidence.js) 收集失败；[SettlementFacts.projectRunSettlement](../../extension/src/shared/settlementFacts.js) 投影持久事实 | `evidence.settled`、failure 的 `terminalState` 和 `run.status` 具有不同含义 |
| 完成报告与摘要 | [WritebackOrchestrator.promoteWritebackSkippedFailure](../../extension/src/content/writebackOrchestrator.js) 提升显式 failure；[Summary.buildChangeSummaryLine](../../extension/src/shared/summary.js) 与 [AgentTranscript.buildHumanCompletionReport](../../extension/src/shared/agentTranscript.js) 统计原始返回集合；runtime `appendCompletionReport` 保存 report event | 报告 failure 未统一采用严重度排序，返回条目计数也未补齐缺失回执 |
| 报告中的失败告警 | [RunFailureNotice.append/formatMetaValue](../../extension/src/content/runFailureNotice.js) 优先读当前 settlement 主因，缺少时读 report event.failure | 刷新后重建的告警与报告中保存的原 failure 可能来源不同 |
| 告警旁的恢复按钮 | `RunFailureNotice.prepareRecovery` 先处理写入不确定性；[RunTimelineView.appendRecoveryActionForFailure](../../extension/src/content/runTimelineView.js) 再按 event.failure.code 白名单及注入 callback 路由 | `canRetry` 或 `retryable` 为真不保证存在按钮；按钮出现也不单独证明原操作适合自动重放 |
| 活动告警与运行页眉 | [RunActivityModel.project](../../extension/src/shared/runActivityModel.js) 分类活动；[RunActivitySummary](../../extension/src/content/runActivitySummary.js) 汇总活动事实，调用 [RunPresence](../../extension/src/content/runPresence.js)；timeline `classifyRunPresence` 读取 run.status | 活动 warning 不直接决定运行失败；页眉文件数不能当作页面已写文件数 |

**失败归一化与排序的边界。** `FailureReasons.normalizeFailureReason` 校验显式 failure，失败时回退到 legacy code 映射和目录默认值；`WritebackOperationEvidence.normalizeFailure` 直接复制显式 failure，只有原始 code 时采用 `write/error/retryable=false` 等默认值。两者未共享同一归一化契约。例如合成输入 `code: stale_snapshot` 在前者变为 `stale_source_changed/preflight/blocked/retryable=true`，在后者保留 `stale_snapshot/write/error/retryable=false`。这一输入说明 helper 差异，不能推定当前真实页面仍会产生该 legacy 结果。

`selectPrimaryFailure` 按严重度 `blocked > error > warning > info`，再按 `STAGE_TIE_BREAKER_ORDER` 选主因，可记为 \(f^*=\arg\min_f(\operatorname{severityRank}(f),\operatorname{stageRank}(f))\)，相同排序项保留输入顺序。当前 `promoteWritebackSkippedFailure` 只取首个带 code 的显式 failure；首项 warning 与后项 blocked 并存时，report event 与 settlement 可保存不同主因。修改其中一个消费者不能推定另一个已同步。
单条 failure 的 `terminalState: needs_review` 与结算的 `evidence.settled: needs-review` 也须分别核对。`deriveSettledEvidence` 检查主因的 needs_review 或任一文件读回 mismatch；较低优先级的 needs_review 并不必然覆盖较高优先级的 blocked，不能将其概括为对全部 failure 取最严格终态。

**已知缺口：计划操作缺少回执。** `normalizeOperationEvidence` 会为计划中未匹配到结果的操作补 `write_result_missing`，使对应结算需要检查；Summary、AgentTranscript 和 `appendApplyResult` 仍只统计原始 applied/skipped 集合。计划两项、仅返回一项 applied 且 skipped 为空时，结算可为 `applied=partial/settled=needs-review`，报告计数仍为“已写入 1 项，跳过 0 项”。
[WritebackOrchestrator.applySyncChangesToOverleaf](../../extension/src/content/writebackOrchestrator.js) 先 append 报告，再在返回值构造 settlement；[contentRuntime.runTask](../../extension/src/content/contentRuntime.js) 随后调用 [RunSettlementPersistence.applyToCurrentRun](../../extension/src/content/runSettlementPersistence.js)。若上述缺项形状到达普通同项目返回路线，`writebackIncomplete/hasSkippedOperations` 仍可为 false，后续 `finishRunView` 可将 run.status 设为 completed。这个条件分支不能证明真实 RPC 已产生缺项，也不能把补齐结算事实描述成全部 UI 已同步修正。

**恢复动作的边界。** `RunFailureNotice` 将 `write_timeout/partial_write_needs_review`、possibly-changed 或特定 unknown/needs-review 证据归入写入未确认，优先提供检查文件或展开详情，并覆盖报告的 Write result/Next 显示值。普通恢复 registry 随后只读 report event.failure.code：例如 `provider_rate_limited` 即使 retryable 为真也未进入编辑重发白名单；`write_operation_failed` 的白名单分支未再检查 retryable。当前 settlement 主因改变后，告警可显示新主因，普通按钮仍按原 report event 路由。Accept/Undo 另经实际恢复材料投影，见[运行状态与恢复](run-state-and-recovery.md#6-undo-的持久化与重载投影)。

**活动与页眉的边界。** `RunActivityModel.isDiagnosticNotice` 将未携带显式 failure 且活动 state 非 failed 的普通 warning/configWarning 放入 diagnostics，保留 guardianWarning 等需要留意的事件；`needsUserAttention` 通常不把普通工具失败升级为任务告警，TeX 编译命令失败另有识别规则。页眉 files 统计 completed 本地 edit 活动中的路径，增删行数来自这些活动；compiled 取 completed compile 活动。`classifyRunPresence` 在 `retryingWriteback` 为真时先返回 plain，其余按 run.status 区分 Done 等分类。这些数值描述各自记录的活动，页面 applied/saved/compiled 结算证据仍需另查；裁剪历史还受 `filesClipped` 限定。

**验证入口与范围。** [failureReasons](../../test/failureReasons.test.js) 检查目录、校验与排序；[writebackSettlement](../../test/writebackSettlement.test.js) 的缺项用例检查合成回执的结算；[writebackSettlementContract](../../test/writebackSettlementContract.test.js) 检查证据和恢复材料投影；[summary](../../test/summary.test.js) 与 [agentTranscript](../../test/agentTranscript.test.js) 覆盖各自的报告 helper。[p0ProductExperience](../../test/p0ProductExperience.test.js) 的恢复 registry 用例主要检查源码装配，[runPresence](../../test/runPresence.test.js) 检查局部页眉 renderer，[runActivityHistoryPersistence](../../test/runActivityHistoryPersistence.test.js) 检查活动元数据经过存储投影后仍可分类。它们不能共同替代 `orchestrator → report → settlement → finishRunView → hydration → 按钮/页眉` 的组合验证；修改这些语义时应同时比较运行中展示、重载后展示及各自保存的事实。

### 复制结论

[RunResultActions.configureResultActions](../../extension/src/content/runResultActions.js) 把结果动作放入完成报告，再配置复制按钮、分叉和完成时间。
`configureCopyButton` 在配置时读取 `.run-completion-report .run-final-answer` 的 `innerText/textContent`；复制内容是渲染后的结论文字，不包括活动日志，也不保证原始 Markdown 或公式 TeX 保真。
`writeClipboardText` 优先使用 `navigator.clipboard.writeText`，仅在 API 不可用时创建临时 textarea 并调用 `execCommand('copy')`。已存在的 Clipboard API 拒绝时由按钮显示失败提示，不继续执行该回退。
验证应覆盖空结论禁用、复制成功/拒绝、API 缺失和结果重新渲染；浏览器剪贴板权限及格式需单独验证。

### 富文本、公式与引用

```text
需要富文本呈现的回答/事件文本
  → MarkdownText.renderMarkdownBlockText
      ├─ 非 streaming: MarkdownDomRenderer + markdown-it tokens → 显式 DOM
      └─ streaming 或 renderer 失败后的预期降级: 兼容块/行内路径
  → 项目引用清理 / 链接按钮 / MathText + KaTeX
  → 面板 CSS、滚动与字体资源
```

[MarkdownDomRenderer](../../extension/src/content/markdownDomRenderer.js) 配置 `html:false/linkify:false`，按 token 构造 DOM；默认限制为 1,000,000 UTF-16 code units、25,000 tokens、32 层嵌套。
超限会抛受控错误，[MarkdownText.renderMarkdownBlockText](../../extension/src/content/markdownText.js) 的 catch 尝试记录诊断并降级。
**静态缺口。** `recordRenderingDiagnostic` 引用未声明的 `options`，而工厂参数为 `deps`；首次出现的诊断可能在 catch 内再抛 ReferenceError，不能保证进入兼容路径。runtime 传入的诊断 callback 还进入空的 `appendTechnicalEvent`，记录能力也需单独核对。
相关片段测试在外层额外提供 `options`，不能替代真实工厂装配的异常路径；验证需以实际工厂触发 renderer 失败，检查诊断与降级是否继续执行。即使降级成功，也不能推定整条消息统一截断或所有 fallback 遵循同一预算。
[MathText.createMathNode](../../extension/src/content/mathText.js) 归一化公式、使用调用方提供的宏或默认宏，并调用 KaTeX：`trust:false`、`throwOnError:true`、`maxExpand:200`、`maxSize:20`。
公式失败保留源码文本；KaTeX CSS、字体 WAR、过宽公式容器同属验收面。静态配置不能证明实际字体加载或窄屏视觉效果。
`buildMarkdownLinkNodes` 对 HTTP(S) 建外链；项目路径解析为 `createLineReferenceButton`，点击时调用 `jumpToPosition` 并传当前 projectId；未识别目标退为文字。
[LineReferences](../../extension/src/shared/lineReferences.js) 和 MarkdownText 的 sanitizers 清理本地路径；新增文本、code、href 或诊断字段均须检查对应路径。脱敏机制的存在不能证明任意未来输入均不会泄露。

## 7. 诊断与 Popup 的真实入口

[DiagnosticsController.runAllDiagnostics](../../extension/src/content/diagnosticsController.js) 依次收集 Native、页面、快照和 OT 检查，并按最差 health 汇总；DiagnosticsPanel 负责菜单、loading 与结果 DOM。
[DiagnosticsPanel.closeResult](../../extension/src/content/diagnosticsPanel.js) 隐藏结果并设置 `resultDismissed`，`showResult` 在该布尔屏障为真时忽略结果；关闭按钮、Escape 和外部点击均可进入此路径。关闭没有取消底层检查，全检仍可继续并更新 health。
下一次 `showLoading` 会清除 `resultDismissed`；该状态未绑定请求 ID 或 generation，不能据此保证新检查启动后会忽略旧检查的迟到结果。[diagnosticsViewport](../../test/diagnosticsViewport.test.js) 覆盖“关闭 → 原结果返回”与重新 loading 的局部状态；还需覆盖“关闭 → 另起检查 → 旧结果返回”的交错次序。
[DiagnosticsExport.exportDiagnosticsBundle](../../extension/src/content/diagnosticsExport.js) 取近期运行、audit、mirror、Native 摘要；异步采集后复核 projectId，再交给 [AuditRecords.buildDiagnosticBundle](../../extension/src/shared/auditRecords.js)。
辅助 audit 存储没有账号字段，导出查询只按 projectId；项目复核不能替代账号过滤。导出元数据、历史视图筛选与删除范围的差异见[审计和诊断消费](context-and-governance.md#5-审计和诊断消费)。
AuditRecords 构造摘要字段并使用 secret-like 文本处理。维护约束是避免正文、完整附件或凭据进入诊断；新增字段须沿采集、摘要和导出链检查，已有字段的处理不能作为其他出口的无泄漏保证。
[Direct popup HTML](../../extension/popup.html) 和 [Managed popup HTML](../../extension/bootstrap/popup.html) 共用 [src/popup.js](../../extension/src/popup.js)；后者通过 runtime 路径加载可替换代码和 CSS。
`ensureMinimalPopupShell` 可改造旧 managed HTML 外壳；`initPopupState/applyPopupPreferences` 读取全局语言主题、监听变化，并设置 `<html lang>`。
launcher 开关先读 `get-panel-state`，按需发 `toggle-launcher`，再读回验证；该开关只控制侧边入口可见性，面板开合有自己的动作。
[bootstrap/popup.js](../../extension/bootstrap/popup.js) 未被当前 managed HTML 引用；[contentScript.js](../../extension/src/contentScript.js) 也未列入当前 canonical content entry。旧文件存在与当前执行是两种证据。

## 8. 最小改动配方与验证路由

| 改动意图 | 最小联动 | 相关测试 |
| --- | --- | --- |
| 新 content controller | source import → registry 依赖 → 必要时 legacy adapter → runtime callbacks/getters → bundle | [contentModuleRegistry](../../test/contentModuleRegistry.test.js)、[contentRuntimeInitialization](../../test/contentRuntimeInitialization.test.js)、[contentBuildIdentity](../../test/contentBuildIdentity.test.js) |
| 新 MAIN 方法 | 实现 → RPC catalog → WAR → PageBridgeClient 顺序 → dispatcher/capability → 消费者 | [pageBridgeClient](../../test/pageBridgeClient.test.js)、[pageRpcContract](../../test/pageRpcContract.test.js)、[manifest](../../test/manifest.test.js) |
| 设置项或布局 | 字段 owner → SettingsPanel read/load → coordinator → Workbench 映射 → i18n/CSS | [globalPreferences](../../test/globalPreferences.test.js)、[contentPanelModules](../../test/contentPanelModules.test.js)、[providerModalLifecycle](../../test/providerModalLifecycle.test.js)、[diagnosticsViewport](../../test/diagnosticsViewport.test.js) |
| 时间线滚动、最新按钮或重绘位置 | RunTimelineView 跟随意图／帧调度 → RunScrollLayout 阅读锚点 → history 重绘选项／CSS | [p2UiRegression](../../test/p2UiRegression.test.js)、[p0ProductExperience](../../test/p0ProductExperience.test.js) |
| 历史查看或清理 | PanelMaintenance / ChangeHistoryView → shared/legacy 存储范围 → ProjectSessionCleanup / Native → 重绘 | [p0ProductExperience](../../test/p0ProductExperience.test.js)、[dashboardSessions](../../test/dashboardSessions.test.js)、[storageDb](../../test/storageDb.test.js)、[sessionTombstones](../../test/sessionTombstones.test.js) |
| 草稿、编辑重发或排队回填 | textarea / RunTimelineView → PanelMaintenance → runtime / RunController → 会话或队列 owner | [runControllerContent](../../test/runControllerContent.test.js)、[runInputQueueSnapshotRegression](../../test/runInputQueueSnapshotRegression.test.js)、[runQueueSchedulerDurability](../../test/runQueueSchedulerDurability.test.js) |
| 结果卡分叉 | RunResultActions → SessionForkController → [Native thread fork](../../native-host/src/codexThreadFork.js) → 记录复制 / 保存 / 补偿 | [sessionForkController](../../test/sessionForkController.test.js)、[sessionState](../../test/sessionState.test.js)、[storageDb](../../test/storageDb.test.js)；刷新字段保留另见运行状态页 |
| 模型或选区输入 | 请求身份/能力 → 视图 → state → execution snapshot → Native 消费者 | [modelSelectionRecovery](../../test/modelSelectionRecovery.test.js)、[projectProviderSelection](../../test/projectProviderSelection.test.js)、[sentSelectionChip](../../test/sentSelectionChip.test.js)、[cuaRepairState](../../test/cuaRepairState.test.js) |
| 附件/输出展示 | 输入预算/恢复或 renderer → 消费者 → CSS/资源 → 失败回退 | [p0ProductExperience](../../test/p0ProductExperience.test.js)、[nativeQuotas](../../test/nativeQuotas.test.js)、[markdownDomRenderer](../../test/markdownDomRenderer.test.js)、[mathRendering](../../test/mathRendering.test.js)、[lineReferences](../../test/lineReferences.test.js) |
| 活动卡或写后回执 | AgentTranscript / RunActivityModel → RunTimelineView / RunActivitySummary；writeback → WrittenChangesView | [agentTranscript](../../test/agentTranscript.test.js)、[subagentActivityView](../../test/subagentActivityView.test.js)、[writtenChangesView](../../test/writtenChangesView.test.js) |
| Popup/诊断 | 两个 HTML shell → shared runtime → 偏好/状态读取 → 摘要字段 | [popupInstallGuidance](../../test/popupInstallGuidance.test.js)、[popupUpdateExperience](../../test/popupUpdateExperience.test.js)、[diagnosticsHealth](../../test/diagnosticsHealth.test.js)、[auditRecords](../../test/auditRecords.test.js) |

Content 新模块不要再向两份 manifest 追加源脚本；产物由 [build-content-bundle](../../scripts/build-content-bundle.mjs) 生成。Page 新脚本必须另外核对 WAR，content import 不能加载 MAIN 能力。
新增设置须明确默认值、作用域、迁移、失败显示及销毁监听器；新增视觉代理控件须保留原有持久化事件入口。
以下命令用于选择并执行专项验证；执行前按实际改动缩小文件集合：

```sh
# 仅列出测试选择
node scripts/run-tests.mjs --list test/modelSelectionRecovery.test.js test/sentSelectionChip.test.js
# 执行输入状态专项
node scripts/run-tests.mjs test/modelSelectionRecovery.test.js test/sentSelectionChip.test.js
# 执行渲染专项
node scripts/run-tests.mjs test/markdownDomRenderer.test.js test/mathRendering.test.js test/lineReferences.test.js
# 重新生成 bundle 并检查模块图；会写入产物
npm run check:module-graph
```

[run-tests.mjs](../../scripts/run-tests.mjs) 负责选择执行文件；具体测试仍可能创建 fixture 或构建临时产物。`npm run test:focus` 还前置模块图检查，不能当作纯只读操作。
浏览器验收另需覆盖 Direct/Managed 首载、SPA 切项目、宽窄面板、dialog 键盘/焦点、旧 Popup shell、公式字体与真实 Overleaf 选区。

OT 点击、滚动及重绘可从[真实 Chrome 本地夹具](../../test/browser/README.md)进入，由 [serve-ui-regression.mjs](../../scripts/serve-ui-regression.mjs) 提供页面。点击场景要求真实指针事件；脚本调用 `element.click()` 的微任务检查点顺序可能不同，可能导致 OT 复选框回滚用例误通过。该夹具装配本地控制器，不连接 Overleaf 或 Native；结果不能直接充当真实项目写回验收。

## 9. 边界场景与验证要点

1. **新增脚本的加载。** content 缺入口 import 或组合依赖时无法进入实际应用；MAIN 模块即使公开为 WAR，也仍需要注入和 dispatcher。需检查执行链，不能仅搜索文件存在。
2. **设置过滤器与持久化作用域。** Workbench 只筛选可见 group；preloadProjectContext 属于全局字段，Track 经活动会话写入。改作用域必须修改 owner 与迁移，不能只移动 DOM。
3. **模型目录请求的迟到响应。** generation/provider/revision 守卫会忽略迟到响应；fallback 保留 unverified 选择也不代表服务已验证支持。需测试慢请求覆盖快请求和无目录的自定义 Provider。
4. **附件清空与迟到读取。** `addFiles` 等待 FileReader/预览后直接 push；`clear` 清数组与 pending keys，没有取消读取或 generation 校验；runtime 清 composer 前只捕获已完成附件，发送可用性未检查 pending bytes。
   按静态链路，旧读取可能在清空后重新进入 tray；实际影响需要通过“读取中提交或清空 → 读取完成”的生命周期用例确认。现有 `p0ProductExperience` 仅覆盖 pending 去重/预算。
5. **富文本主路径与降级路径的资源限额。** 非 streaming renderer 失败后的预期兼容路径还可能被前述诊断异常打断；超长 Markdown、恶意链接与复杂公式应分别验证主路径和降级链，静态主路径参数不足以证明整体资源界限。
6. **真实浏览器中的 modal 与加载副本。** 原生 dialog 的 top-layer、焦点恢复、字体及旧 managed shell 依赖 Chrome 和页面状态；验证需要覆盖真实浏览器中的挂载、键盘操作、关闭和重载。
7. **附件序列化与刷新恢复。** 附件虽通过 SessionState normalize/compact，实际 prefs/session 写入与 hydration 未携带该字段；须按第 5 节完整保存和加载路线验证。

目标契约：控制器销毁、异步清空/切换和失效响应均应维护所属身份；渲染与诊断边界应随新增字段一同检查。上述目标不能反推未覆盖分支已经满足。
