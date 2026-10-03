# 界面、加载与输入上下文

产品源码基线：`2073ae74747431aab8d529803d4e9f8197262388`；首版指南提交：`86d5a17`；核查日期：2026-10-03。
本页补足[系统总览](system-overview.md)与[功能索引](feature-map.md)中的界面领域。`Current behavior` 指静态源码支持的实现；本轮未运行产品测试、构建、安装、浏览器或远端操作。
完整运行归属见[运行状态与恢复](run-state-and-recovery.md)，写入证据见[Auto 编辑与撤销](auto-edit-undo.md)。本页中的测试只表示定义存在。

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
[ContentRuntime.init](../../extension/src/content/contentRuntime.js) 是组合入口，向各 controller 注入 getter/callback；该文件仍包含业务流程，不能将其所有内容都归类为纯装配。
runtime 对重复初始化设有标记；发现旧 panel 已在 DOM、runtime 尚未登记时，返回 `stale-panel-before-runtime-init`。这条守卫不能证明所有旧页面都已自动恢复。
异步初始化先加载全局偏好、账号作用域与持久状态，再建立队列、面板和恢复流程；项目列表路由立即挂 dashboard shell，后续填充列表。

### MAIN world 的独立装配

[PageBridgeClient](../../extension/src/content/pageBridgeClient.js) 的 `PAGE_WORLD_SCRIPTS`、`OPTIONAL_OT_SCRIPTS` 与 `injectPageBridge` 是顺序 owner，runtime 只创建并启动 client。
`injectPageBridge` 在 capability 模块之前尝试 OT 可选依赖；这部分失败可继续保留不可用回退，其他必需脚本加载失败使 `call` 返回 bridge unavailable。
`injectScriptOnce` 生成资源 URL，等待 load/error/timeout；列表第三项 `force` 会影响已有脚本节点处理。完成脚本装配后还要 `initializeCapability` 握手。
方法策略来自 [pageRpcContract.METHODS](../../extension/src/shared/pageRpcContract.js)，真正分派位于 [pageBridge.dispatch](../../extension/src/pageBridge.js)；新方法需要同时定义身份、超时、取消和重放语义。
身份策略须逐方法读取。当前 `ensureReviewing/ensureEditing` 的项目身份仍为 optional，相关边界见[证据与漂移](evidence-and-drift.md)中的 G-02。

## 2. Panel 与 Settings：DOM 是状态的投影

投影指“把已有状态显示成控件、标签和卡片”。例如按钮勾选状态像仪表指针，持久 owner 决定读数；重建 DOM 时应重新投影，不能借机改写运行历史。

| 表面 | 创建/布局 owner | 行为与数据来源 |
| --- | --- | --- |
| Panel 外壳、launcher、拖动宽度 | [PanelRenderer.create](../../extension/src/content/panelRenderer.js) | runtime `ensurePanelOpen` 提供操作 callbacks；renderer 管理监听器与宽度 |
| `diagnosticsSlot` | [DiagnosticsPanel](../../extension/src/content/diagnosticsPanel.js) | DiagnosticsController 执行检查，结果展示不拥有底层环境状态 |
| `settingsSlot` | [SettingsPanel.create](../../extension/src/content/settingsPanel.js) | 设置 coordinator、全局偏好及对应领域 owner |
| `sessionSlot` | [SessionPanel](../../extension/src/content/sessionPanel.js) | SessionManager、共享会话状态与当前活动会话 |
| `composerSlot` | [ComposerPanel.create](../../extension/src/content/composerPanel.js) | runtime 的提交、取消、模型、上下文、附件 callbacks |
| 项目列表 dashboard | [RecentProjects](../../extension/src/content/recentProjects.js) | 账号作用域会话摘要和 SPA route，不应先闪现项目 composer |

[SettingsWorkbench.mount](../../extension/src/content/settingsWorkbench.js) 把现有设置 group DOM 移入原生 `<dialog>`，分类由 `CATEGORIES/GROUP_PAGES` 控制，显示范围由 `PROJECT_GROUPS` 等决定。
移动保留已有节点、监听器和草稿；新增控件仍应在 SettingsPanel 中定义读写接口。新增导航按钮不自动建立持久化字段。
`All settings` 与 `This project` 是可见项过滤器；切换过滤器不迁移字段所属作用域。
`show` 使用 `showModal()`，保存进入前焦点；`hide` 关闭后尝试恢复焦点。`requestClose` 先经过 Provider close guard，再通知原关闭回调。
dialog 的 `cancel` 只处理目标为 dialog 的事件，避免文件选择器取消事件误关设置；分类切换和关闭都须保留此生命周期约束。
Provider 通过 `revealProviders` 嵌入工作台；相关编辑器由 [ProviderSettingsDialog](../../extension/src/content/providerSettingsDialog.js) 与 [ProviderSettingsCoordinator](../../extension/src/content/providerSettingsCoordinator.js) 管理。
普通主题选项仍以已有 select 为值入口，Workbench 的主题卡片触发其 input/change；新增视觉代理控件应继续接入既有状态通路。

### 历史查看、清理与结果动作

[PanelMaintenance.openChangeHistory](../../extension/src/content/panelMaintenance.js) 打开设置历史卡，交给 [ChangeHistoryView.load](../../extension/src/content/changeHistoryView.js) 读取 auditLogs 和 sessions。
后者捕获账号、项目、容器与请求 generation，异步返回后复核；超时或读取失败显示错误及重试入口，不能把失败投影成“没有历史”。历史行通过 runtime 的 `jumpToHistoryRun` 跳转到所属会话与运行。

| 清理入口 | 实际 owner 与范围 | 独立结果与限制 |
| --- | --- | --- |
| 设置中的清空历史 | `PanelMaintenance.clearAllHistoryWithConfirm` → `StorageDb.clearAllStores`，随后重置项目名称缓存、重建会话状态并保存 | 入口检查当前页面 `currentRunView`，通过 destructive confirm 后执行；该入口未调用 Native `codex.history.clearPlugin` |
| 共享历史启用时的清空实现 | [SharedSessionBridge.decorate](../../extension/src/shared/sharedSessionBridge.js) 将会话清理交给 `erase('clear-account')`；同时删除当前账号的站点 legacy 会话备份 | 其他账号的 legacy 会话备份保留；辅助 stores 仍调用站点本地 `clearStore`，其范围不能按会话的账号隔离推定 |
| legacy 存储实现 | [StorageDb.clearAllStores](../../extension/src/shared/storageDb.js) 在当前站点 IndexedDB 事务中清空 `STORES` | 与后台共享账号会话库是不同存储边界；控件位于项目设置过滤器也不会缩小此范围 |
| dashboard 的逐项目清理 | [ProjectSessionCleanup.clearProjectSessions](../../extension/src/content/projectSessionCleanup.js) 按 projectId 查询、按已解析账号过滤，检查近期 running 记录，再确认并写墓碑、删除会话及请求 Native 历史清理 | 会话删除数和 Native 历史清理失败分别统计；剩余记录仍可显示并重试。账号缺失时过滤条件有放行分支，不能从此函数单独推定始终账号隔离 |

这些动作清理插件历史与恢复材料，Overleaf 文件写入、撤销属于其他入口；清理前应分别核对账号共享库、站点辅助库及 Native 历史的范围。
[p0ProductExperience](../../test/p0ProductExperience.test.js) 的清空历史用例和 [dashboardSessions](../../test/dashboardSessions.test.js) 的逐项目清理用例主要检查源码调用结构，不能替代实际持久删除、部分失败与跨标签交互验收。

结果卡按钮由 [RunTimelineView.renderRunCard](../../extension/src/content/runTimelineView.js) 装配 [RunResultActions.configureResultActions](../../extension/src/content/runResultActions.js)。
其中 `configureForkButton` 在记录有 turnId、非 running、非 forkSnapshot 且具有 callback 时启用，再调用 [SessionForkController.forkRunFromNode](../../extension/src/content/sessionForkController.js)。
分叉从所选节点复制历史并建立新 Native thread；来源线程优先级、撤销材料剥离、保存失败补偿及持久化字段缺口见[会话分叉与恢复材料隔离](run-state-and-recovery.md#61-会话分叉与恢复材料隔离)。
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
  ├─ 无当前运行：runTask 捕获输入 → startRunView → clearTaskComposer
  └─ 有当前运行：queueComposerInput → RunQueueScheduler coordinator → pendingInputs
结果卡 Edit & resend → refillComposerForRetry → prepareRetryReplacement → 会话草稿
```

[contentRuntime](../../extension/src/content/contentRuntime.js) 的 `syncComposerSendAvailability` 在运行中且无文字时呈现取消，有文字时呈现排队发送；`safeRunTask` 将活动运行期间的提交交给队列协调器。
`runTask` 在 Provider/风格异步加载前捕获输入，建立 run 后还等待 audit 草稿等步骤，才调用 `clearTaskComposer` 清文字、选区、技能调用及附件；该顺序不能推广为任意提交等待期间的新输入都会保留。
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
发送后的 `renderSent` 从 run execution snapshot 渲染 chip；草稿移除选区不应删除历史 chip。页面选区探测还检查编辑器焦点、连接状态和 probe generation。
[ContextTray](../../extension/src/content/contextTray.js) 管理 focused files、文件列表和预加载；`@` 文件上下文与二进制附件各有持久化和消费路径。

### 多附件异步、预算与恢复

[ComposerAttachments.createComposerAttachmentController](../../extension/src/content/composerAttachments.js) 接收 paste/drop/file input，先去重和预约预算，再等待 FileReader 与图片预览。
`pendingAttachmentKeys` 防止同一文件并发重复读取；预算计入已完成字节和 pending bytes，`finally` 释放预约，避免同时导入绕过总额判断。
普通 composer 的配置来自 runtime：\(n\le8\)、每件 \(b_i\le12\,\mathrm{MiB}\)、\(\sum b_i\le32\,\mathrm{MiB}\)。空附件被拒绝；该规则与合法空项目文件的语义不同。
[NativeQuotas](../../native-host/src/nativeQuotas.js) 普通附件保留单件/数量约束，聚合限制为 96 MiB；不能用 Native 更宽上限推断 UI 接受范围。写作风格参考采用另组 quotas。
`getAttachmentsForRun` 包含本次发送内容；`createRunAttachmentSnapshots` 只保留名称、类型、大小与受限预览，避免把完整附件作为历史卡片内容复制。
`serializePersistableAttachments/restorePersistedAttachments` 提供序列化与回填 helper：最多三件，单件 `contentBase64.length <= 1,048,576`；此单位为 Base64 字符。
Base64 长度约为 \(4\lceil B/3\rceil\)，因此该字符阈值不能当作原始文件 1 MiB 限额。runtime 的 `applyStateToPanel` 设有每页仅一次的回填门槛，避免已有状态中的附件在移除后再次出现。

**当前持久链缺口。** `persistComposerAttachmentsToState` 写入顶层 `state.composerAttachments`，[SessionState.prepareStateForStorage](../../extension/src/shared/sessionState.js) 也保留该字段；但 [ScopedPersistencePanelState.persistPanelState](../../extension/src/content/scopedPersistencePanelState.js) 实际写入的 [StorageDb.extractLightweightPrefs/buildSessionRecord](../../extension/src/shared/storageDb.js) 均未包含它。
runtime 的 `loadStoredStateForProject` 正常返回与 compact fallback 返回也不回填该字段，因此上述 helper 与一次性门槛不能证明当前刷新恢复已贯通。
[sessionState](../../test/sessionState.test.js) 中名为“composer attachments persist across refresh”的用例只调用 normalize/compact，未穿过真实存储及 hydration；后续应覆盖 `saveState → persistPanelState → loadStoredStateForProject → restorePersistedAttachments`，本轮未执行复现。此项与第 9 节的清空/迟到读取竞态分别处理。

`runTask` 在异步 Provider/风格加载前捕获已完成附件，创建 run 后清空 composer；队列协调器拒绝带附件的排队输入，见 [RunQueueScheduler](../../extension/src/content/runQueueScheduler.js)。
当前 controller 也有尚待验证的清空/迟到读取边界，见第 9 节；不能由去重测试推广出完整生命周期保证。

## 6. Markdown、公式和链接的呈现链

### 活动投影与写后回执

事件进入 UI 前已有一层结构化投影：[contentRuntime.appendNativeEvent](../../extension/src/content/contentRuntime.js) 先尝试 `SubagentActivityModel.ingest`，普通事件再交给 [AgentTranscript.mapAgentEventToActivity](../../extension/src/shared/agentTranscript.js)。不可见或 technical 事件在此返回，其他事件进入运行记录及视图。
[RunTimelineView](../../extension/src/content/runTimelineView.js) 创建 [RunActivitySummary](../../extension/src/content/runActivitySummary.js)，后者消费 [RunActivityModel](../../extension/src/shared/runActivityModel.js) 的投影，组织阶段、工具、通知、折叠项和子代理区域；需要富文本的内容继续调用下文 Markdown 链。
活动展开选择写入页面 `sessionStorage`，运行事实另由会话持久化保存。修改折叠展示不能据此改写运行结果或历史。

写后文件回执从 [WritebackOrchestrator.applySyncChangesToOverleaf](../../extension/src/content/writebackOrchestrator.js) 调用 `renderReadOnlyDiffReview`，经 [DiffReviewPanel](../../extension/src/content/diffReviewPanel.js) 使用 runtime 注入的 [WrittenChangesView.render](../../extension/src/content/writtenChangesView.js)。当前常规装配下，逐文件折叠回执的展示 owner 是 WrittenChangesView。
DiffReviewPanel 同时保留 [ReviewHunks](../../extension/src/content/reviewHunks.js) 支持的交互 hunk 决策和 `renderDiffReview`。本基线静态调用检索未找到生产外部调用 `renderDiffReview`；`createDiffReviewElement` 仍可作为未注入回执 renderer 时的只读回退。模块被打包和独立测试存在，不能证明交互式逐块审阅属于当前可达用户流程。
[agentTranscript](../../test/agentTranscript.test.js) 检查事件映射；[subagentActivityView](../../test/subagentActivityView.test.js) 在伪 DOM 中装配共享活动 renderer；[writtenChangesView](../../test/writtenChangesView.test.js) 覆盖回执 helper 并用源码断言检查 runtime 注入；[reviewHunks](../../test/reviewHunks.test.js) 检查纯决策模型。它们各自覆盖局部边界，真实长流、滚动和写后展示仍待验收。

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
相关片段测试在外层额外提供 `options`，不能替代真实工厂装配的异常路径。即使降级成功，也不能推定整条消息统一截断或所有 fallback 遵循同一预算；本轮未进行实际渲染复现。
[MathText.createMathNode](../../extension/src/content/mathText.js) 归一化公式、使用调用方提供的宏或默认宏，并调用 KaTeX：`trust:false`、`throwOnError:true`、`maxExpand:200`、`maxSize:20`。
公式失败保留源码文本；KaTeX CSS、字体 WAR、过宽公式容器同属验收面。静态配置不能证明实际字体加载或窄屏视觉效果。
`buildMarkdownLinkNodes` 对 HTTP(S) 建外链；项目路径解析为 `createLineReferenceButton`，点击时调用 `jumpToPosition` 并传当前 projectId；未识别目标退为文字。
[LineReferences](../../extension/src/shared/lineReferences.js) 和 MarkdownText 的 sanitizers 清理本地路径；新增文本、code、href 或诊断字段均须检查对应路径。脱敏机制的存在不能证明任意未来输入均不会泄露。

## 7. 诊断与 Popup 的真实入口

[DiagnosticsController.runAllDiagnostics](../../extension/src/content/diagnosticsController.js) 依次收集 Native、页面、快照和 OT 检查，并按最差 health 汇总；DiagnosticsPanel 负责菜单、loading 与结果 DOM。
[DiagnosticsExport.exportDiagnosticsBundle](../../extension/src/content/diagnosticsExport.js) 取近期运行、audit、mirror、Native 摘要；异步采集后复核 projectId，再交给 [AuditRecords.buildDiagnosticBundle](../../extension/src/shared/auditRecords.js)。
AuditRecords 构造摘要字段并使用 secret-like 文本处理。维护约束是避免正文、完整附件或凭据进入诊断；本轮证据只涵盖已阅读的字段与调用链，不构成全系统无泄漏证明。
[Direct popup HTML](../../extension/popup.html) 和 [Managed popup HTML](../../extension/bootstrap/popup.html) 共用 [src/popup.js](../../extension/src/popup.js)；后者通过 runtime 路径加载可替换代码和 CSS。
`ensureMinimalPopupShell` 可改造旧 managed HTML 外壳；`initPopupState/applyPopupPreferences` 读取全局语言主题、监听变化，并设置 `<html lang>`。
launcher 开关先读 `get-panel-state`，按需发 `toggle-launcher`，再读回验证；该开关只控制侧边入口可见性，面板开合有自己的动作。
[bootstrap/popup.js](../../extension/bootstrap/popup.js) 未被当前 managed HTML 引用；[contentScript.js](../../extension/src/contentScript.js) 也未列入当前 canonical content entry。旧文件存在与当前执行是两种证据。

## 8. 最小改动配方与验证路由

| 改动意图 | 最小联动 | 最近已有测试 |
| --- | --- | --- |
| 新 content controller | source import → registry 依赖 → 必要时 legacy adapter → runtime callbacks/getters → bundle | [contentModuleRegistry](../../test/contentModuleRegistry.test.js)、[contentRuntimeInitialization](../../test/contentRuntimeInitialization.test.js)、[contentBuildIdentity](../../test/contentBuildIdentity.test.js) |
| 新 MAIN 方法 | 实现 → RPC catalog → WAR → PageBridgeClient 顺序 → dispatcher/capability → 消费者 | [pageBridgeClient](../../test/pageBridgeClient.test.js)、[pageRpcContract](../../test/pageRpcContract.test.js)、[manifest](../../test/manifest.test.js) |
| 设置项或布局 | 字段 owner → SettingsPanel read/load → coordinator → Workbench 映射 → i18n/CSS | [globalPreferences](../../test/globalPreferences.test.js)、[contentPanelModules](../../test/contentPanelModules.test.js)、[providerModalLifecycle](../../test/providerModalLifecycle.test.js)、[diagnosticsViewport](../../test/diagnosticsViewport.test.js) |
| 历史查看或清理 | PanelMaintenance / ChangeHistoryView → shared/legacy 存储范围 → ProjectSessionCleanup / Native → 重绘 | [p0ProductExperience](../../test/p0ProductExperience.test.js)、[dashboardSessions](../../test/dashboardSessions.test.js)、[storageDb](../../test/storageDb.test.js)、[sessionTombstones](../../test/sessionTombstones.test.js) |
| 草稿、编辑重发或排队回填 | textarea / RunTimelineView → PanelMaintenance → runtime / RunController → 会话或队列 owner | [runControllerContent](../../test/runControllerContent.test.js)、[runInputQueueSnapshotRegression](../../test/runInputQueueSnapshotRegression.test.js)、[runQueueSchedulerDurability](../../test/runQueueSchedulerDurability.test.js) |
| 结果卡分叉 | RunResultActions → SessionForkController → [Native thread fork](../../native-host/src/codexThreadFork.js) → 记录复制 / 保存 / 补偿 | [sessionForkController](../../test/sessionForkController.test.js)、[sessionState](../../test/sessionState.test.js)、[storageDb](../../test/storageDb.test.js)；刷新字段保留另见运行状态页 |
| 模型或选区输入 | 请求身份/能力 → 视图 → state → execution snapshot → Native 消费者 | [modelSelectionRecovery](../../test/modelSelectionRecovery.test.js)、[projectProviderSelection](../../test/projectProviderSelection.test.js)、[sentSelectionChip](../../test/sentSelectionChip.test.js)、[cuaRepairState](../../test/cuaRepairState.test.js) |
| 附件/输出展示 | 输入预算/恢复或 renderer → 消费者 → CSS/资源 → 失败回退 | [p0ProductExperience](../../test/p0ProductExperience.test.js)、[nativeQuotas](../../test/nativeQuotas.test.js)、[markdownDomRenderer](../../test/markdownDomRenderer.test.js)、[mathRendering](../../test/mathRendering.test.js)、[lineReferences](../../test/lineReferences.test.js) |
| 活动卡或写后回执 | AgentTranscript / RunActivityModel → RunTimelineView / RunActivitySummary；writeback → WrittenChangesView | [agentTranscript](../../test/agentTranscript.test.js)、[subagentActivityView](../../test/subagentActivityView.test.js)、[writtenChangesView](../../test/writtenChangesView.test.js) |
| Popup/诊断 | 两个 HTML shell → shared runtime → 偏好/状态读取 → 摘要字段 | [popupInstallGuidance](../../test/popupInstallGuidance.test.js)、[popupUpdateExperience](../../test/popupUpdateExperience.test.js)、[diagnosticsHealth](../../test/diagnosticsHealth.test.js)、[auditRecords](../../test/auditRecords.test.js) |

Content 新模块不要再向两份 manifest 追加源脚本；产物由 [build-content-bundle](../../scripts/build-content-bundle.mjs) 生成。Page 新脚本必须另外核对 WAR，content import 不能加载 MAIN 能力。
新增设置须明确默认值、作用域、迁移、失败显示及销毁监听器；新增视觉代理控件须保留原有持久化事件入口。
以下为后续执行命令，本轮均未运行；执行前按实际改动缩小文件集合：

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

## 9. 反例与验证缺口

1. **“新文件写好就会加载”不成立。** content 缺入口 import 或组合依赖时无法进入实际应用；MAIN 模块即使公开为 WAR，也仍需要注入和 dispatcher。需检查执行链，不能仅搜索文件存在。
2. **“切到项目过滤器就把设置存为项目级”不成立。** Workbench 只筛选可见 group；preloadProjectContext 属于全局字段，Track 经活动会话写入。改作用域必须修改 owner 与迁移，不能只移动 DOM。
3. **“旧模型目录返回后总能刷新 UI”不成立。** generation/provider/revision 守卫会忽略迟到响应；fallback 保留 unverified 选择也不代表服务已验证支持。需测试慢请求覆盖快请求和无目录的自定义 Provider。
4. **附件清空与迟到读取存在待验证竞态。** `addFiles` 等待 FileReader/预览后直接 push；`clear` 清数组与 pending keys，没有取消读取或 generation 校验；runtime 清 composer 前只捕获已完成附件，发送可用性未检查 pending bytes。
   静态链路提示旧读取可能在清空后重新进入 tray；尚未执行复现，不能据此断言已出现用户故障。现有 `p0ProductExperience` 覆盖 pending 去重/预算，仍需补“读取中提交或清空 → 读取完成”的生命周期用例。
5. **“严格 renderer 限额就是整条消息全程限额”不成立。** 非 streaming renderer 失败后的预期兼容路径还可能被前述诊断异常打断；超长 Markdown、恶意链接与复杂公式应分别验证主路径和降级链，静态主路径参数不足以证明整体资源界限。
6. **单元定义无法证明实际 modal 与加载副本。** 原生 dialog 的 top-layer、焦点恢复、字体及旧 managed shell 依赖 Chrome 和页面状态；本轮只确认源码与测试定义，相关交互仍待验收。
7. **序列化 helper 不构成刷新恢复证据。** 附件虽通过 SessionState normalize/compact，实际 prefs/session 写入与 hydration 未携带该字段；须按第 5 节完整保存和加载路线验证。

目标契约：控制器销毁、异步清空/切换和失效响应均应维护所属身份；渲染与诊断边界应随新增字段一同检查。上述目标不能反推未覆盖分支已经满足。
