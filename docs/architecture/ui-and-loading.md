# 界面、加载与输入上下文

初始参考源码基线：`2073ae74747431aab8d529803d4e9f8197262388`。当前行为随本仓库实现维护。
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
[RunReviewController](../../extension/src/content/runReviewController.js) 拥有 Undo/Accept 操作编排；[DirectoryCleanupRecovery](../../extension/src/content/directoryCleanupRecovery.js) 保存目录观测。原有新建重试和保存确认由 runtime 编排并核对账号、项目、运行及持久化依赖。结果展示由 [RunCompletionMeta](../../extension/src/content/runCompletionMeta.js) 与 [RunRecoveryActions](../../extension/src/content/runRecoveryActions.js) 分别负责元信息和既有恢复动作。
runtime 对重复初始化设有标记；发现旧 panel 已在 DOM、runtime 尚未登记时，返回 `stale-panel-before-runtime-init`。这条守卫不能证明所有旧页面都已自动恢复。
异步初始化先加载全局偏好、账号作用域与持久状态，再建立队列、面板和恢复流程；项目列表路由立即挂 dashboard shell，后续填充列表。
队列数据加载与队列卡重绘使用不同入口，由面板同步衔接；初始化及恢复后的显示路线见[队列显示与恢复入口](#pending-queue-render)。

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
| 共享历史启用时的清空实现 | [SharedSessionBridge.decorate](../../extension/src/shared/sharedSessionBridge.js) 将会话清理交给 `erase('clear-account')`；同时删除当前账号的站点 legacy 会话备份 | 其他账号的 legacy 会话备份保留；辅助 stores 经站点本地 `clearAuxiliaryStores` 在同一事务中清理并推进附件草稿 epoch，其范围不能按会话的账号隔离推定 |
| legacy 存储实现 | [StorageDb.clearAllStores](../../extension/src/shared/storageDb.js) 在当前站点 IndexedDB 事务中清空 `STORES` | 与后台共享账号会话库是不同存储边界；控件位于项目设置过滤器也不会缩小此范围 |
| dashboard 的逐项目清理 | [ProjectSessionCleanup.clearProjectSessions](../../extension/src/content/projectSessionCleanup.js) 捕获账号、项目和 dashboard 渲染代次，查询所属会话，检查 running 并确认；确认后重读，再处理墓碑、兼容 blob、共享删除及 Native 历史清理 | 仅处理确认过且仍存在的会话；确认后新增会话保留，出现近期 running 记录则停止。缺少账号或身份/视图变化时停止后续步骤；会话删除数与 Native 清理失败分别统计 |

逐项目清理的按钮捕获创建时的账号与 dashboard 渲染代次，旧按钮和确认期间变化的视图不能继续清理。每次异步查询及副作用前后复核身份；兼容 blob 读写接收同一守卫，共享 `deleteRecord` 显式传入预期账号/项目，再由 bridge capture 与后台锁检查。确认取消或身份失效不显示完整成功。
该操作跨兼容墓碑、旧 blob、共享库和 Native，仍是分步清理；守卫阻止后续动作，已经完成或派发的原作用域操作无法统一回滚。兼容存储失败、共享删除和 Native 清理结果需分别核对，不能仅凭计数推断跨库原子成功。[projectCleanupAccountIsolation.test.js](../../test/projectCleanupAccountIsolation.test.js) 串联真实 dashboard 按钮、确认与共享存储守卫，以 I/O 替身覆盖换账号、旧按钮、重绘代次、新会话和新 running 记录；不执行真实历史删除。

清库后同步清除旧会话兼容镜像、草稿和控制器输入，再创建空白会话；完整成功提示要求新状态获得持久确认。名称缓存清理或保存失败会显示部分完成，旧内存仍保持清空，详见[清空历史后的状态](run-state-and-recovery.md#clear-history-state)。

结果卡按钮由 [RunTimelineView.renderRunCard](../../extension/src/content/runTimelineView.js) 装配 [RunResultActions.configureResultActions](../../extension/src/content/runResultActions.js)。
其中 `configureForkButton` 在记录有 turnId、非 running、非 forkSnapshot 且具有 callback 时启用，再调用 [SessionForkController.forkRunFromNode](../../extension/src/content/sessionForkController.js)。
分叉从所选节点复制历史并建立新 Native thread；来源线程优先级、撤销材料剥离、保存失败补偿及持久化字段缺口见[会话分叉与恢复材料隔离](run-state-and-recovery.md#61-会话分叉与恢复材料隔离)。
Native 分叉返回后复核 scope 与来源记录，合并当前会话集合并保留后来选择的活动会话；乐观渲染、保存失败补偿和用户后续编辑的处理见[分叉等待与视图切换](run-state-and-recovery.md#fork-async-state)。
[sessionForkConcurrency](../../test/sessionForkConcurrency.test.js) 和 [sessionForkController](../../test/sessionForkController.test.js) 使用真实 controller、SessionState 与会话管理模块，Native、渲染和保存通过依赖替身提供；不能据此推定真实浏览器、Native fork 与数据库重载已联合通过。

## 3. 配置作用域：按写入路径判断

| 作用域 | 代表字段与 owner | 修改后的影响 |
| --- | --- | --- |
| 全局偏好 | [GlobalPreferences](../../extension/src/shared/globalPreferences.js)：theme、locale、preloadProjectContext、skills 总开关及逐项开关 | 通过 [GlobalPreferencesController](../../extension/src/content/globalPreferencesController.js) 发字段 patch、接收 revision 与 storage 事件 |
| 当前项目 | [ProjectSettingsCoordinator](../../extension/src/content/projectSettingsCoordinator.js)：custom instructions、governance；OT 按 project map 保存 | 对应项目后续提交读取这些值 |
| 项目 Provider 选择 | [ProjectProviderSelection.commit](../../extension/src/content/projectProviderSelection.js) | 更新项目及各会话未来默认选择；Provider/revision 变化会重置未来线程绑定，保留已有 runs/pendingInputs |
| 活动会话 | [SessionState](../../extension/src/shared/sessionState.js)：task、mode、requireReviewing、focusFiles、selectionContext 等 | `readPanelInputs/updateActiveSession` 更新当前会话；Track 的实际写入属于此路径 |
| 面板/项目状态字段 | runtime 的 `state.autoRecompile`、panelWidth；附件草稿由 `ComposerAttachmentDraft` 按账号/项目保存 | 查 read/persist/load 路径；附件使用站点 artifacts，不属于共享会话或全局 prefs |
| 已提交运行 | [RunExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js) | 捕获模式、模型、Provider revision、Track/compile、选区等；后续控件变化不应重解释该快照 |

`persistPanelInputs` 先交给全局 controller；识别到全局字段就返回该 patch Promise。普通 task 输入走 debounce 保存，明确控件变更继续读取并持久化。
全局 controller 将 pending patch 投影到本地视图，再接收递增 revision；失败时移除 pending patch 并报告错误。此结构旨在阻止旧会话 autosave 回滚全局偏好。
语言存在三条呈现通路：[i18n](../../extension/src/shared/i18n.js) 的 `tr` 键、runtime 的 `tx(en, zh)`、Popup 的 `utx`。修改翻译需同时检查实际消费者。Notice、Bridge 和 apply 详情共用 `FailureReasons.formatFailureReasonForDisplay`，已知错误及下一步文案在渲染时读取当前面板语言；历史记录的 Undo、Accept、Review 自产精确模板由同一显示投影识别，覆盖丢失原始错误码及已包装为通用错误码的情况。动态文件路径只展示一次，从旧文案解析出的路径仅用于显示，恢复按钮仍只消费原 failure 的可信路径。原生审阅尚未写入与可能已写入的提示分别保留对应语义。`localizeFailureMessage` 为只有历史文案的消费者提供同一精确模板匹配，未知诊断、模型回答及用户原文保留原文。现有 canonical 错误（`unknown_legacy_failure` 除外）的用户说明与下一步均有中英词条；旧记录中的精确 catalog 默认正文及单层 `文件: 已知正文` 也可恢复显示语言。显示投影不改变 canonical 错误分类、重试标志、持久状态及恢复动作权限；相关回归见 [undoNoticeRecovery](../../test/undoNoticeRecovery.test.js)。

[RunCompletionMeta](../../extension/src/content/runCompletionMeta.js) 根据稳定的 `meta.key`、自产固定模板、计数字段及既有 FailureReason／AgentTranscript 错误建议生成当前语言的元信息显示，不改运行记录及保存的报告。[RunQueueScheduler](../../extension/src/content/runQueueScheduler.js) 按已知 Native 指导错误码生成本地化提示；[ComposerAttachments](../../extension/src/content/composerAttachments.js) 的 `FileReader` 失败使用自产本地化摘要，浏览器原始错误保留在 `cause`。runtime 的自产执行快照、选区、存储和 Native 连接异常通过 `ApplyResultFormatters.localizeVisibleReason` 精确匹配；任意外部异常不做推测翻译。

[CompileAdapter.localizeCompileReason](../../extension/src/shared/compileAdapter.js) 处理产品自产的编译与保存说明，保留原编译摘要和 TeX 日志。

语言变化由 `contentRuntime.applyLocaleToPanel` 刷新已有界面。`RunTimelineView.refreshLocale` 重新呈现历史卡片，并保留展开与滚动位置；活动运行保留流式节点和缓冲引用，只更新产品控件及已生成报告的显示。队列、附件、模型选项、Provider 对话框和更新提示各自刷新自产文案；对话框输入与用户草稿保持原位。已知过程提示可通过精确模板投影，命令输出、技术详情和模型流不作推测翻译。
Undo/Accept 的既有展开 Notice 由 [RunActivitySummary](../../extension/src/content/runActivitySummary.js) 显示当次结果的文件与跳过原因。[RunReviewController](../../extension/src/content/runReviewController.js) 通过既有 `event.failure` 保留受控主故障摘要；runtime 的 `appendRunRecordEvent` 延续该字段，通用 `detail` 仍按原策略脱敏。持久摘要只保留标准错误与产品文案、已有运行材料中的安全相对路径，不保留任意 Page reason、技术消息或原始 evidence；它不参与恢复权限及检查点结算。旧记录若只剩哈希且没有故障摘要，无法从哈希还原原理由。实时可用逐项详情与持久主故障的范围不同，见 [reviewResultNoticeDetails](../../test/reviewResultNoticeDetails.test.js)。
普通 Undo 的 `native_untracked_undo_pending_changes` 沿此显示通路说明现存待处理留痕及下一步；只消费明确的机器原因和未开始变更的证据，不从通用失败文案猜测原因。
[WritingStyleSettings](../../extension/src/content/writingStyleSettings.js) 的 `sync` 也会重新投影缓存的自产状态及目录错误；参考资料标题和模型风格预览保留原内容。缓存文案的语言变化不重新生成风格、不改变所选资料或启用状态，见 [writingStyleLocale](../../test/writingStyleLocale.test.js)。

`RunCompletionMeta.projectCompletionBody` 只识别 `AgentTranscript.buildStructuredHumanReport` 的完整有序章节格式：前四节为单行列表，最后的跳过原因允许多行内容。它翻译五个产品章节名；`projectGovernanceSkippedBody` 另外识别完整的产品自产治理阻止块，将旧 `unknown_legacy_failure` 的已知原因、写回预检阶段和下一步按当前语言显示。匹配要求原因、代码、下一步及块格式一致；模型结论、未知文字和不匹配的跳过正文保持原样，不修改持久记录或恢复权限。相关回归见 [runtimeStatusLocale](../../test/runtimeStatusLocale.test.js)、[uiLocaleProjection](../../test/uiLocaleProjection.test.js) 和 [governanceFailureDisplay](../../test/governanceFailureDisplay.test.js)。

[ThemeController.applyTheme/watchAuto](../../extension/src/content/themeController.js) 负责主题效果；全局存储拥有偏好，CSS 与 dialog/浮动工具栏负责正确继承和显示。

### 已提交输入、运行中草稿与编辑重发

三类状态类似已寄出的信、桌上的草稿和等待寄出的信：已提交运行消费 execution snapshot，当前 textarea 的新输入写入活动会话 `task`，排队项保留自己的 text/payload。运行结束、切换会话和重新绘制时，须分别定位各自 owner。

```text
textarea input → persistPanelInputs → readPanelInputs → updateActiveSession → debounce save
提交 → safeRunTask
  ├─ 无当前运行：runTask 捕获输入与归属 → 按需等待插件技能目录 → 等待旧镜像 → 准备 Provider/风格 → startRunView → audit 等待与身份复核 → 条件清理输入
  └─ 有当前运行：queueComposerInput → RunQueueScheduler coordinator → pendingInputs
结果卡 Edit & resend → refillComposerForRetry → prepareRetryReplacement → 会话草稿
```

[contentRuntime](../../extension/src/content/contentRuntime.js) 的 `syncComposerSendAvailability` 在运行中且无文字时呈现取消，有文字时呈现排队发送；`safeRunTask` 将活动运行期间的提交交给队列协调器。
`runTask` 在首次 await 前捕获输入、提交会话、提示词会话投影、线程和技能开关。普通提交启用插件技能时，先与面板预取共用 `primeCodexOverleafSkillsCatalog({ required:true })`，再按捕获的逐项开关生成启用 ID；读取失败走已有任务启动错误提示，输入保留，尚未派发任务。随后等待 `pendingMirror`、Provider 与风格准备；风格快照仍在加载后获取。`startRunView` 按捕获的 sessionId 建立记录；`safeRunTask` 用准备期标志防止重复启动。
建立 run 后等待 audit 草稿，再复核账号项目并条件清理已提交输入。原会话草稿或当前文字、附件、技能、选区已变化时保留新输入；在途附件和 `SelectionContextView.getRevision` 的代次变化也阻止清理。切换会话后只可能清理仍匹配的原会话 task，当前 composer 保留；队列提升跳过此清理。普通与 skill-installer 参数消费已捕获的会话投影，详见[运行状态与恢复](run-state-and-recovery.md#31-执行快照)。
[PendingInputView.pullBack](../../extension/src/content/pendingInputView.js) 只回填 queued 项，已有非空草稿时提示并返回；实际移除队列项与持久化由回调完成，UI 回填动作本身不提供事务提交证明。队列准入、推进和保存边界见[运行状态与恢复](run-state-and-recovery.md)。

<a id="pending-queue-render"></a>

**队列显示与恢复入口。** [ComposerPanel](../../extension/src/content/composerPanel.js) 创建的 `data-pending-inputs` 容器默认隐藏；`PendingInputView.render` 在队列非空时显示容器，暂停项同时显示 Queue paused 与 Resume。runtime 的 `renderPendingInputs` 通过队列 coordinator 读取活动会话的 `pendingInputs`。`applyStateToPanel` 在会话列表与运行历史同步后调用该入口，覆盖初始化、journal 恢复和会话切换；切到空队列时清除旧卡，切回时重新显示对应会话的队列。

composer 输入、运行状态变化和 turn 绑定仍会触发重绘。队列 coordinator 未建立或容器尚不存在时，重绘入口安全返回；容器建立后按需创建视图。重绘不调用保存、Resume 或任务调度，也不修改草稿与队列状态。维护该处应同时核对会话加载、恢复后的暂停状态和 DOM 重绘；验证入口为 [pendingQueuePanelRestore.test.js](../../test/pendingQueuePanelRestore.test.js)，真实页面重载和存储环境另行验收。

[RunTimelineView.configureEditButton](../../extension/src/content/runTimelineView.js) 对 cancelled/rejected 且通过 `canEditRun` 的记录提供编辑重发，当前存在运行时禁用该按钮。
[PanelMaintenance.refillComposerForRetry](../../extension/src/content/panelMaintenance.js) 回填任务并调用 runtime 的 `prepareRetryReplacement`：符合资格的 cancelled/rejected 记录在无当前运行时回到草稿，并从列表移除原卡，恢复其模式、focused files 和选区；其他符合替换条件的失败重试会记录 `pendingRetryReplacement`，在新 run 创建时解析替换。
资格规则由 [RunController.isRetryReplacementEligible/resolveRetryReplacement](../../extension/src/content/runController.js) 根据写入与恢复材料判断；附件不会随任务文字自动恢复，UI 会提示重新添加。
[runControllerContent](../../test/runControllerContent.test.js) 覆盖资格、会话归属与替换 helper；[p0ProductExperience](../../test/p0ProductExperience.test.js) 另有恢复按钮路由断言。[runSubmissionOwnership](../../test/runSubmissionOwnership.test.js) 另组合 runtime、真实 SessionManager、参数和 prompt 构造，覆盖异步提交期间的会话/草稿/作用域变化；队列回填、真实 UI 与刷新仍需对应环境验证。

## 4. 模型目录：请求返回顺序与用户选择分开处理

[ModelPicker.loadModelOptions](../../extension/src/content/modelPicker.js) 发出 `codex.models`，请求携带当前 Provider selection；`modelLoadGeneration` 每次加载递增。
响应先检查 generation，再核对响应中明确给出的 providerId；成功的自定义 Provider 目录还须匹配 providerRevision。旧请求或明确失配响应返回 `{ stale: true }`，不进入目录重绘。
目录元数据由 [Models](../../extension/src/shared/models.js) 与 [ModelPickerSupport](../../extension/src/content/modelPickerSupport.js) 归一化，再渲染 model/reasoning/speed select 及其可视选择按钮。
内建目录缺项或处于 fallback 时，`retainSelectedModel/preserveSelectedCapabilities` 可保留用户显式选择并标为 unverified；这仅保留选择，不能证明远端支持该能力。
当前请求的失败包即使不含 result，也进入 `applyUnavailableModelOptions`，禁用不可用目录并保留真实 error code/message；不会用缺失 revision 的 NaN 比较把它误判为旧响应。Built-in fallback 仍有明确来源条件，自定义错误不填入内建模型。Coordinator 继续呈现该错误，不用通用目录失败取代具体原因。
[modelPickerCurrentError](../../test/modelPickerCurrentError.test.js) 覆盖无 result 错误、旧 generation 及成功 revision 冲突；[providerUiContracts](../../test/providerUiContracts.test.js) 串联模型目录与协调器的错误呈现。外部 I/O 与 DOM 使用替身，实际服务和浏览器呈现另行验收。
模型按钮点击更新 select，再调用 `persistPanelInputs`；Speed 先写入 `state.speedTier` 再渲染能力，避免重绘把刚选值还原。

[ProjectProviderSelection.assertSwitchAllowed](../../extension/src/content/projectProviderSelection.js) 统一现有的活动运行等待政策；`confirmSwitch` 和最终 `commit` 共用该检查。Use/Use Built-in 保留原确认，Save and use 保留原按钮意图，删除沿用原 Delete 确认。Coordinator 在相关 Native 变更派发前检查，模型目录等待结束与最终项目提交再次核对，不能通过批准标记跳过活动运行保护。实际选择变更给 `ModelPicker.loadModelOptions` 传 `assertCurrent`，在目录重绘前复核；运行期间仅刷新相同 Provider/revision 的目录仍可继续。
普通 Save 仍可保存共享配置，活动期间不重置当前项目选择和线程。`reconcileProviderSelection` 比较当前项目已绑定 revision 与目录 revision；后续已有 `syncSessionProvider` 在项目空闲时完成延期绑定，尚有活动运行则保持阻止。该路径没有新增计时器或后台自动切换。已派发 Native 操作可以改变共享默认项，随后拒绝项目提交不构成撤回该全局变更；已有运行继续消费原执行快照。
清密钥或普通 Save 改端点的提示区分 Native Host 默认项与当前项目选择，详见 [Provider 两处选择状态](providers-and-protocols.md#4-savetest-与-use)。[providerUiContracts](../../test/providerUiContracts.test.js) 覆盖临时 Store、真实协调器与项目提交，检查各入口、异步运行开始、延期 revision、文案和原操作对照；真实浏览器与实际在途模型仍需独立验收。

## 5. 选区、文件上下文与附件

### 选区引用与选区编辑

[SelectionContextView.attach](../../extension/src/content/selectionContextView.js) 捕获 projectId、sessionId、generation，调用 `getSelectionContext` 后以及打开 composer 后分别复核归属。
[SelectionContext.normalize](../../extension/src/shared/selectionContext.js) 校验项目相对路径、非空文本、范围、文档 hash；上限 `MAX_TEXT=20000` 按 JavaScript 字符串长度计算。
选区路径使用最长2048字符的完整项目字面路径，不截断成别名；反斜线、控制字符及首尾空白等无效路径被拒绝。Page 对文档及选中文字检查孤立 UTF-16 代理码元，避免 UTF-8 编码替换破坏哈希前提；完整 emoji 仍可参与选区。
范围满足 \(0\le from<to\) 与 \(to-from=|text|\)，并携带 `documentHash`，用于说明选区来自哪个文档版本。
`reference` 模式附加参考内容；`edit` 模式显示“仅此处”，runtime 的 `setSelection` 同时把会话模式设为 Auto。实际局部修改限制还依赖 [selectionScope](../../native-host/src/selectionScope.js)，标签本身不提供执行保证。
Native 的 `prepareSelectionScope` 在镜像同步或复用准备后、执行器启动前核对整文 SHA-256 和选中文字。Page 捕获的可选 `rebaseEvidence` 还保存完整前缀、后缀的 SHA-256 及文档长度，坐标和长度均采用 JavaScript UTF-16 码元；不持久化整份前后缀正文。
当整文版本变化时，只在选中文字不变且完整一侧仍匹配时重定位。设旧区间为 \([f,t)\)、旧长 \(L\)、新长 \(N\)、选中文字长 \(m=t-f\)，候选起点为原位置 \(f\) 或按旧后缀从文末定位的 \(N-(L-t)-m\)。前者要求完整前缀哈希一致，后者要求完整后缀哈希一致，且去重后只有一个有效候选。双侧均变化、选中文字变化或多个有效位置时以 `selected_context_unresolved` 拒绝；旧记录没有证明时继续使用严格整文版本检查。重定位后坐标、行号、documentHash 和模型输入都采用当前文档版本。
`filterSelectionChanges` 逐项保留同一选区路径的合法文本 write：`previousContent` 必须等于当前基线，结果满足 \(after=prefix+replacement+suffix\)。跨文件、结构或二进制操作、选区外文本变化进入 `selection_scope_violation`；同路径重复结果被拒绝。单个文件内无法证明可分离的混合越界修改仍整项拒绝。Content 将被拒绝项纳入 skipped/blocked，混合结果明确部分完成，已写部分保留 Undo；本地镜像可继续为 dirty。
[selectionScopeRebase.test.js](../../test/selectionScopeRebase.test.js) 覆盖 Page 捕获、存储/队列、Native 启动与重定位；[selectionScopeWriteback.test.js](../../test/selectionScopeWriteback.test.js) 覆盖部分合法结果的写回与恢复。页面及外部 I/O 使用替身；启动后的远端变化仍由 Page stale guard 检查，不由启动重定位自动解决。reference 模式不启用 edit-only 过滤。

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
`pendingAttachmentKeys` 防止同一文件并发重复读取；预算计入当前 composer 代次内的已完成字节和 pending bytes，只有同代 `finally` 能释放该预约，避免旧读取扣除新批次预算或移除同文件的新预约。
`addFiles` 按顺序处理一批文件。校验或读取抛错会停止后续文件并由原入口提示失败，已接受的前缀保留。整批结束的 `finally` 只在当前代次重绘，因此成功、部分接受后失败、数量上限与总预算不足等分支的内部列表和 tray 保持一致；被清空的旧批次不会重绘新输入。
[composerAttachmentsBatch.test.js](../../test/composerAttachmentsBatch.test.js) 覆盖“有效文件 → 空文件/过大/读取失败 → 有效文件”、重试及旧代完成，同时检查错误、可见列表、停止读取和运行参数；失败不代表整批回滚。

普通 composer 的准入配置来自 runtime：\(n\le8\)、每件 \(b_i\le12\,\mathrm{MiB}\)、\(\sum b_i\le32\,\mathrm{MiB}\)。空附件被拒绝；该规则与合法空项目文件的语义不同。
**清空与在途读取。** 每次 `addFiles` 捕获 `attachmentGeneration`，在批次循环、FileReader 完成及预览完成后复核；`clear` 递增代次，清空附件、预约 keys 和 bytes，新批次可立即准入。旧读取结果、旧批次剩余文件及旧代错误失效，不能重入待发输入；旧 `finally` 不改变新代预约。底层 FileReader/Image 未强制 abort，允许完成后丢弃结果，因此当前预算约束有效 composer 内容与预约，不提供全部历史在途 I/O 的统一内存上限。
[composerAttachmentsConcurrency.test.js](../../test/composerAttachmentsConcurrency.test.js) 使用完整控制器与可控读取/预览，覆盖清空、同文件重新导入、两批交错、旧错误及数量/字节约束；真实浏览器事件与发送仍需单独验收。
[NativeQuotas](../../native-host/src/nativeQuotas.js) 普通附件保留单件/数量约束，聚合限制为 96 MiB；不能用 Native 更宽上限推断 UI 接受范围。写作风格参考采用另组 quotas。
`getAttachmentsForRun` 包含本次发送内容；`createRunAttachmentSnapshots` 只保留名称、类型、大小与受限预览，避免把完整附件作为历史卡片内容复制。
`serializePersistableAttachments/restorePersistedAttachments` 提供序列化与回填 helper：最多三件，单件 `contentBase64.length <= 1,048,576`；此单位为 Base64 字符。
Base64 长度约为 \(4\lceil B/3\rceil\)，因此该字符阈值不能当作原始文件 1 MiB 限额。超出恢复限额的附件仍可参与当前提交，但不保存为刷新草稿。

**附件草稿持久化。** [ComposerAttachmentDraft](../../extension/src/shared/composerAttachmentDraft.js) 管理独立的账号/项目草稿，使用当前站点 IndexedDB 的 `artifacts` store；完整附件不进入全局 prefs、共享会话记录或 compact fallback。它维持项目 composer 归属，切换同项目会话不会自动改变附件；www 与 cn 的跨源共享会话不包含这份站点附件草稿。
`ComposerAttachments` 的 add/remove/clear 经 `onChange` 更新内存并安排保存。runtime `saveState` 在已捕获作用域事务内调用 `getComposerDraftPersistence().save`，仅写有实际变更的附件；`loadStoredStateForProject → loadComposerAttachmentDraft → applyStateToPanel` 在账号/项目作用域内恢复。附件读取的普通 I/O 失败只提示附件不可用，不丢弃已经读取的会话历史；身份或加载代次失配仍拒绝结果。
`syncScope` 在项目或账号改变时清空控制器并使旧 FileReader 失效；作用域代次和读取序号阻止旧异步结果覆盖新草稿。`hydrate` 每个作用域只初始化一次，本地已发生的添加、移除或清空优先于迟到恢复。
草稿写入在同一 IndexedDB 事务中比较 revision 与清理 epoch，匹配后才能提交；冲突会拒绝旧写入并提示恢复方式。清空历史原子清理辅助 stores 并推进 epoch；尚未取得初始版本的编辑还检查首次变更时间，失败重试不能借新读到的版本复活清理前附件。该机制提供并发写入保护，不自动把另一标签页的附件实时投影到当前界面。
[composerAttachmentPersistence.test.js](../../test/composerAttachmentPersistence.test.js) 串联实际保存、加载及控制器回填；[composerAttachmentDraft.test.js](../../test/composerAttachmentDraft.test.js) 覆盖作用域、事务、清理、并发和迟到结果。测试使用存储/DOM 替身，真实 IndexedDB 与 Chrome 刷新仍需单独验收。

`runTask` 在异步 Provider/风格加载前捕获已完成附件，创建 run 后清空 composer；队列协调器拒绝带附件的排队输入，见 [RunQueueScheduler](../../extension/src/content/runQueueScheduler.js)。
提交只捕获当时已完成的附件，不等待在途读取；清空后旧代读取失效。完整提交交互与真实浏览器发送仍需验收，见第 9 节。

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
| 完成报告与摘要 | [WritebackOrchestrator.promoteWritebackSkippedFailure](../../extension/src/content/writebackOrchestrator.js) 提升显式 failure；[Summary.buildChangeSummaryLine](../../extension/src/shared/summary.js) 与 [AgentTranscript.buildHumanCompletionReport](../../extension/src/shared/agentTranscript.js) 统计原始返回集合；runtime `appendCompletionReport` 保存 report event | 写回 failure 共用主因规则；条目计数消费 Broker 已补齐的结果集合 |
| 报告中的失败告警 | [RunFailureNotice.append/formatMetaValue](../../extension/src/content/runFailureNotice.js) 优先读当前 settlement 主因，缺少时读 report event.failure | 刷新后重建的告警与报告中保存的原 failure 可能来源不同 |
| 告警旁的恢复按钮 | [RunRecoveryActions.appendRecoveryActionForFailure](../../extension/src/content/runRecoveryActions.js) 先由 `RunFailureNotice.prepareRecovery` 处理原有检查文件/查看详情动作，其余动作按同一当前 failure.code 白名单路由 | `canRetry` 或 `retryable` 为真不保证存在按钮；按钮出现也不单独证明原操作适合自动重放 |
| 活动告警与运行页眉 | [RunActivityModel.project](../../extension/src/shared/runActivityModel.js) 分类活动；[RunActivitySummary](../../extension/src/content/runActivitySummary.js) 汇总活动事实，调用 [RunPresence](../../extension/src/content/runPresence.js)；timeline `classifyRunPresence` 读取 run.status | 活动 warning 不直接决定运行失败；页眉文件数不能当作页面已写文件数 |

**失败归一化与排序。** 写回相关消费者共用 `FailureReasons.normalizeWritebackFailure`，把旧 code 映射、目录默认值、文件上下文及可能发生修改的证据归一化。`selectPrimaryWritebackFailure` 先选择需要核查写入结果的失败，再按通用严重度和阶段排序：\(f^*=\arg\min_f(\operatorname{reviewRank}(f),\operatorname{severityRank}(f),\operatorname{stageRank}(f))\)。通用严重度仍为 `blocked > error > warning > info`，同等级保留原顺序；未修改非写回场景的通用选择器。
报告、格式化器、逐项证据、settlement 和 Notice 使用同一写回主因规则；不确定修改的证据不会被另一个更高严重度的阻断原因遮住。`terminalState: needs_review` 与 `evidence.settled: needs-review` 分别属于失败与结算表示，修改时继续核对其消费者。

**缺项回执的归一化与结算兜底。** 普通 Auto/Retry 文本写回先经过 [AssetTransferBroker.normalizeTextResult](../../extension/src/content/assetTransferBroker.js)，按计划核对返回项并补齐 skipped。执行结果不确定的缺项会带上 `receiptUnconfirmed` 并阻断未派发尾部；明确未派发的取消保留取消语义，运行可为 cancelled。两者均不按完整成功结算，该入口保护必须与末端投影一起检查。
`normalizeOperationEvidence` 另为未匹配计划补 `write_result_missing`；Summary、AgentTranscript 和 `appendApplyResult` 按传入的 applied/skipped 集合统计。若绕开 Broker 直接交给末端“一项 applied、空 skipped”的孤立结果，结算仍可为 partial/needs-review，而报告计数或 completed 标签不一致。这个兜底差异不构成普通主链已经假成功的证据；新增入口或调整 Broker 时应保持补项与后续消费者的衔接。

**恢复动作的边界。** `RunFailureNotice` 将需要核查写入的证据优先展示为检查文件或展开详情；[RunRecoveryActions](../../extension/src/content/runRecoveryActions.js) 从同一个 Notice context 取得当前 failure，再按明确白名单和 callback 提供动作。旧 report event 继续保留历史事实，当前提示及动作不会各自从不同主因派生。`retryable` 本身仍不足以授权自动重放；Edit & resend 只回填 composer，需新的显式提交。
工具栏 Retry sync 按 `retryWriteback/saveCheck` 提供原有入口；不存在额外写入内容核查、人工 Review 核验或目录检查按钮。[RunCompletionMeta](../../extension/src/content/runCompletionMeta.js) 负责完成信息和 `recoveryRetention` 提示，区分预算省略与摘要降级；必要目录观测只作为原详情的一行历史说明，不能推断当前状态。现有内存材料仍可用时不会禁用其 Undo。Accept/Undo 的执行资格仍由真实恢复材料决定，旧版恢复说明合入原 Undo 确认，见[运行状态与恢复](run-state-and-recovery.md#6-undo-的持久化与重载投影)。

**活动与页眉的边界。** `RunActivityModel.isDiagnosticNotice` 将未携带显式 failure 且活动 state 非 failed 的普通 warning/configWarning 放入 diagnostics，保留 guardianWarning 等需要留意的事件；`needsUserAttention` 通常不把普通工具失败升级为任务告警，TeX 编译命令失败另有识别规则。页眉 files 统计 completed 本地 edit 活动中的路径，增删行数来自这些活动；compiled 取 completed compile 活动。`classifyRunPresence` 在 `retryingWriteback` 为真时先返回 plain，其余按 run.status 区分 Done 等分类。这些数值描述各自记录的活动，页面 applied/saved/compiled 结算证据仍需另查；裁剪历史还受 `filesClipped` 限定。

**验证入口与范围。** [writebackOutcomeConsistency](../../test/writebackOutcomeConsistency.test.js) 检查真实写回失败组合、主因和动作一致性；[failureReasons](../../test/failureReasons.test.js) 检查目录、校验与排序；[writebackSettlement](../../test/writebackSettlement.test.js) 的缺项用例检查合成回执的结算；[writebackSettlementContract](../../test/writebackSettlementContract.test.js) 检查证据和恢复材料投影；[summary](../../test/summary.test.js) 与 [agentTranscript](../../test/agentTranscript.test.js) 覆盖各自的报告 helper。[p0ProductExperience](../../test/p0ProductExperience.test.js) 的恢复 registry 用例主要检查源码装配，[runPresence](../../test/runPresence.test.js) 检查局部页眉 renderer，[runActivityHistoryPersistence](../../test/runActivityHistoryPersistence.test.js) 检查活动元数据经过存储投影后仍可分类。它们不能共同替代 `orchestrator → report → settlement → finishRunView → hydration → 按钮/页眉` 的组合验证；修改这些语义时应同时比较运行中展示、重载后展示及各自保存的事实。

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
`recordRenderingDiagnostic` 从工厂 `deps` 获取诊断 callback，按 code/detail 去重，并隔离其同步异常，使首次及重复的可恢复渲染失败均可继续降级。去重在回调之前登记，回调失败不会反复重发同一条诊断；该同步接口不等待回调返回的 Promise。
[markdownTextFallback.test.js](../../test/markdownTextFallback.test.js) 装配完整工厂与真实 renderer，覆盖依赖缺失、渲染器异常、输入超限、回调缺失/抛错及正常 stream/non-stream 路线；DOM 使用替身。runtime callback 仍进入空的 `appendTechnicalEvent`，诊断可调用不构成持久记录保证。兼容路径也未统一采用主 renderer 的预算，资源和视觉边界仍需单独验证。
[MathText.createMathNode](../../extension/src/content/mathText.js) 归一化公式、使用调用方提供的宏或默认宏，并调用 KaTeX：`trust:false`、`throwOnError:true`、`maxExpand:200`、`maxSize:20`。
公式失败保留源码文本；KaTeX CSS、字体 WAR、过宽公式容器同属验收面。静态配置不能证明实际字体加载或窄屏视觉效果。
`buildMarkdownLinkNodes` 对 HTTP(S) 建外链；项目路径解析为 `createLineReferenceButton`，点击时调用 `jumpToPosition` 并传当前 projectId；未识别目标退为文字。
[LineReferences](../../extension/src/shared/lineReferences.js) 和 MarkdownText 的 sanitizers 清理本地路径；新增文本、code、href 或诊断字段均须检查对应路径。脱敏机制的存在不能证明任意未来输入均不会泄露。

## 7. 诊断与 Popup 的真实入口

[DiagnosticsController.runAllDiagnostics](../../extension/src/content/diagnosticsController.js) 依次收集 Native、页面、快照和 OT 检查，并按最差 health 汇总；DiagnosticsPanel 负责菜单、loading 与结果 DOM。
`DiagnosticsController.refreshLocale` 从当前请求已经取得的观察结果重建显示，不重新发起检查；`DiagnosticsPanel.refreshLocale` 保留已关闭状态、展开项和滚动位置，技术证据仍是原始结果。请求代次与账号、项目、路由约束继续适用，见 [diagnosticsLocaleRefresh](../../test/diagnosticsLocaleRefresh.test.js)。
[DiagnosticsPanel.closeResult](../../extension/src/content/diagnosticsPanel.js) 隐藏结果并设置 `resultDismissed`，`showResult` 在该布尔屏障为真时忽略结果；关闭按钮、Escape 和外部点击均可进入此路径。关闭没有取消底层检查，全检仍可继续并更新 health。
每次可见的全检或单项检查由 `DiagnosticsController.beginDiagnostics` 建立新请求代次，并捕获账号、项目及路由代次；只有仍匹配的请求可发布结果，全检更新 health 也受同一检查约束。全检内部的 `collectOnly` 子检查沿用其父请求，不争夺可见结果。下一次 `showLoading` 清除 `resultDismissed` 后，旧检查仍不能覆盖新检查；仅关闭且未启动新检查时，原检查仍可更新 health。该机制过滤迟到结果，不取消已经发出的底层读取。
[diagnosticsRequestOwnership.test.js](../../test/diagnosticsRequestOwnership.test.js) 串联真实 Panel、Controller 和 runtime 绑定，覆盖全检/单项交错、账号项目及路由变化；[diagnosticsViewport](../../test/diagnosticsViewport.test.js) 另检查关闭及布局。DOM 和通信替身不构成真实浏览器验收。
[DiagnosticsExport.exportDiagnosticsBundle](../../extension/src/content/diagnosticsExport.js) 取近期运行、audit、mirror、Native 摘要；异步采集后复核 projectId，再交给 [AuditRecords.buildDiagnosticBundle](../../extension/src/shared/auditRecords.js)。
审计 writer 保留运行账号；导出查询先按 projectId 读取，再按捕获账号过滤，并在采集后复核账号与项目。旧无账号 audit 不进入导出。运行摘要的旧字段兼容、历史视图筛选与删除范围见[审计和诊断消费](context-and-governance.md#5-审计和诊断消费)，不同来源的身份保证分别判断。
AuditRecords 构造摘要字段并使用 secret-like 文本处理。维护约束是避免正文、完整附件或凭据进入诊断；新增字段须沿采集、摘要和导出链检查，已有字段的处理不能作为其他出口的无泄漏保证。
[Direct popup HTML](../../extension/popup.html) 和 [Managed popup HTML](../../extension/bootstrap/popup.html) 共用 [src/popup.js](../../extension/src/popup.js)；后者通过 runtime 路径加载可替换代码和 CSS。
`ensureMinimalPopupShell` 可改造旧 managed HTML 外壳；`initPopupState/applyPopupPreferences` 读取全局语言主题、监听变化，并设置 `<html lang>`。
Popup 的自产动态状态、复制反馈和站点授权说明随语言重画；Managed 修复指引继续使用原安装身份及平台信息，语言变化不重新申请权限。Managed HTML 先加载固定的 [popupFallback.js](../../extension/bootstrap/popupFallback.js)，使 runtime 无法加载时的原有修复提示也可读取语言偏好。该脚本只更新仍存在的 fallback 外壳，正常 runtime 替换外壳后的迟到回调不覆盖界面。修改此固定资产须完整 Managed 安装，见 [popupFallbackLocale](../../test/popupFallbackLocale.test.js) 及[安装边界](installation-and-updates.md#9-手动升级与-bootstrap-边界)。
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
| 结果卡分叉 | RunResultActions → SessionForkController → [Native thread fork](../../native-host/src/codexThreadFork.js) → 记录复制 / 保存 / 补偿 | [sessionForkController](../../test/sessionForkController.test.js)、[sessionForkConcurrency](../../test/sessionForkConcurrency.test.js)、[sessionState](../../test/sessionState.test.js)、[storageDb](../../test/storageDb.test.js)；刷新字段保留另见运行状态页 |
| 模型或选区输入 | 请求身份/能力 → 视图 → state → execution snapshot → Native 消费者 | [modelSelectionRecovery](../../test/modelSelectionRecovery.test.js)、[projectProviderSelection](../../test/projectProviderSelection.test.js)、[sentSelectionChip](../../test/sentSelectionChip.test.js)、[cuaRepairState](../../test/cuaRepairState.test.js) |
| 附件/输出展示 | 输入预算/恢复或 renderer → 消费者 → CSS/资源 → 失败回退 | [p0ProductExperience](../../test/p0ProductExperience.test.js)、[nativeQuotas](../../test/nativeQuotas.test.js)、[composerAttachmentsConcurrency](../../test/composerAttachmentsConcurrency.test.js)、[markdownTextFallback](../../test/markdownTextFallback.test.js)、[markdownDomRenderer](../../test/markdownDomRenderer.test.js)、[mathRendering](../../test/mathRendering.test.js)、[lineReferences](../../test/lineReferences.test.js) |
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
4. **附件清空与提交时机。** 控制器以代次阻止旧读取、预览及批次余项重入，相关回归见第 5 节。runtime 提交仍只捕获已完成附件，发送可用性未等待 pending bytes；需要在真实浏览器中分别验证读取中提交、主动清空和新批次导入，不能将控制器失效保证推广为全部附件均已被本次任务接收。
5. **富文本主路径与降级路径的资源限额。** 诊断同步异常已隔离；超长 Markdown、恶意链接与复杂公式仍需分别验证主路径和兼容路径的实际资源及呈现边界，主 renderer 的参数不足以证明所有降级路径具有相同上限。
6. **真实浏览器中的 modal 与加载副本。** 原生 dialog 的 top-layer、焦点恢复、字体及旧 managed shell 依赖 Chrome 和页面状态；验证需要覆盖真实浏览器中的挂载、键盘操作、关闭和重载。
7. **附件序列化与刷新恢复。** 附件虽通过 SessionState normalize/compact，实际 prefs/session 写入与 hydration 未携带该字段；须按第 5 节完整保存和加载路线验证。

目标契约：控制器销毁、异步清空/切换和失效响应均应维护所属身份；渲染与诊断边界应随新增字段一同检查。上述目标不能反推未覆盖分支已经满足。
