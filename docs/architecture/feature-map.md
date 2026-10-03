# 功能修改导航

适用产品版本：`2.5.0`；源码基线：`2073ae7`。
本页记录当前实现的入口、状态 owner、必要联动和最近测试。owner 指拥有状态或行为决策权的模块；UI 通常只展示该状态的投影。
下列测试提供对应行为的验证入口；实际 Chrome/Overleaf 交互还需按改动选择浏览器场景。

入口：[架构指南首页](README.md) · [系统概览](system-overview.md)。
核心链路：[Auto 编辑与 Undo](auto-edit-undo.md)、[运行状态与恢复](run-state-and-recovery.md)。其他领域页按以下分组展开主路径和失败边界；实现变动仍需检查对应源码。
查找方法：先匹配用户改动意图，再沿“入口 → 状态 owner → 联动 → 测试”阅读；符号名可直接用于源码搜索。

## 界面、设置与诊断

领域说明：[界面与加载](ui-and-loading.md)。

### 改面板入口、宽度或布局

- 入口：[PanelRenderer.create](../../extension/src/content/panelRenderer.js)；[ContentRuntime.ensurePanelOpen](../../extension/src/content/contentRuntime.js) 组装各 slot。
- 状态 owner：PanelRenderer 管理 DOM 和 resize；宽度进入 runtime/prefs，launcher 启用值独立存于 `chrome.storage.local['codex-overleaf:launcher-visible']`。面板开合为 DOM 状态，刷新初始化会重新打开面板。
- 必须联动：[panel.css](../../extension/styles/panel.css)、[sessionState](../../extension/src/shared/sessionState.js)；保持设置、会话、composer 的生命周期。
- 最近测试：[contentPanelModules](../../test/contentPanelModules.test.js)、[panelPolish](../../test/panelPolish.test.js)、[diagnosticsViewport](../../test/diagnosticsViewport.test.js)。

### 改阅读跟随、最新按钮或复制结论

- 入口：[RunTimelineView.bindLogAutoFollow/scrollLogToBottom](../../extension/src/content/runTimelineView.js)、[RunResultActions](../../extension/src/content/runResultActions.js) 的 `configureCopyButton`。
- 状态 owner：timeline 管理跟随意图、未读步骤和强制跳转；[RunScrollLayout](../../extension/src/content/runScrollLayout.js) 保存重绘前的阅读锚点。复制读取渲染后的结论文字，不复制运行日志或原始 Markdown。
- 必须联动：流式输出、折叠、重绘、字体与宽度变化、Clipboard API/回退和操作失败提示。细节见[界面与加载](ui-and-loading.md)。
- 最近测试：[p2UiRegression](../../test/p2UiRegression.test.js) 含滚动、布局和锚点场景；复制还需覆盖空结论、权限拒绝及 Clipboard API 不可用。

### 加设置项、调整设置分类或作用域

- 入口：[SettingsPanel.create/readState/loadState](../../extension/src/content/settingsPanel.js)、[SettingsWorkbench.mount](../../extension/src/content/settingsWorkbench.js)。
- 状态 owner：全局偏好经 [GlobalPreferencesController](../../extension/src/content/globalPreferencesController.js)；项目指令与治理配置经 [ProjectSettingsCoordinator](../../extension/src/content/projectSettingsCoordinator.js)。
- 必须联动：[globalPreferences](../../extension/src/shared/globalPreferences.js)、[sessionState](../../extension/src/shared/sessionState.js) 的字段归属；分类映射 `GROUP_PAGES/PROJECT_GROUPS`。Workbench 移动已有控件，保留草稿和监听器。
- 最近测试：[globalPreferences](../../test/globalPreferences.test.js)、[contentPanelModules](../../test/contentPanelModules.test.js)、[providerModalLifecycle](../../test/providerModalLifecycle.test.js)。

### 改中英文、主题或 Popup

- 入口：[i18n](../../extension/src/shared/i18n.js)、[ThemeController](../../extension/src/content/themeController.js)、共享 [popup.js](../../extension/src/popup.js)。
- 状态 owner：[globalPreferences](../../extension/src/shared/globalPreferences.js) 的 `locale/theme`；panel、popup 分别应用偏好。
- 必须联动：[direct popup](../../extension/popup.html)、[managed popup](../../extension/bootstrap/popup.html)、[popup.css](../../extension/styles/popup.css)，以及 runtime 的 `tr/tx`、popup 的 `utx`。当前 managed HTML 加载 runtime popup，未引用同目录旧 `popup.js`。
- 最近测试：[i18n](../../test/i18n.test.js)、[themeController](../../test/themeController.test.js)、[popupInstallGuidance](../../test/popupInstallGuidance.test.js)、[popupUpdateExperience](../../test/popupUpdateExperience.test.js)。

### 改回答 Markdown、公式或文件行号跳转

- 入口：[MarkdownText.create](../../extension/src/content/markdownText.js)、[MarkdownDomRenderer.renderMarkdown](../../extension/src/content/markdownDomRenderer.js)。
- 状态 owner：渲染器管理 DOM；[lineReferences](../../extension/src/shared/lineReferences.js) 规范化路径，[MathText](../../extension/src/content/mathText.js) 管理公式解析与回退。
- 必须联动：项目文件身份、TeX 宏来源、KaTeX/vendor 加载与字体公开资源；保留原始 HTML 禁用、公式失败显示源码和本地路径脱敏。
- 最近测试：[markdownDomRenderer](../../test/markdownDomRenderer.test.js)、[mathRendering](../../test/mathRendering.test.js)、[lineReferences](../../test/lineReferences.test.js)。

### 改诊断检查或导出内容

- 入口：[DiagnosticsPanel](../../extension/src/content/diagnosticsPanel.js)、[DiagnosticsController.runAllDiagnostics](../../extension/src/content/diagnosticsController.js)。
- 状态 owner：各检查读取 Native/Page/镜像状态；[DiagnosticsExport](../../extension/src/content/diagnosticsExport.js) 构造脱敏导出和 smoke 摘要。
- 必须联动：[compatibility](../../extension/src/shared/compatibility.js)、[auditRecords](../../extension/src/shared/auditRecords.js)、[failureReasons](../../extension/src/shared/failureReasons.js)；导出字段不得泄露正文、附件或 secret。
- 关闭结果只设置展示屏障，不取消原检查；再次开始检查会重置该屏障，不能把它当作请求 generation 保护。
- 最近测试：[diagnosticsHealth](../../test/diagnosticsHealth.test.js)、[diagnosticsMenu](../../test/diagnosticsMenu.test.js)、[diagnosticsViewport](../../test/diagnosticsViewport.test.js)。

## 模型、选区与附件

模型执行与连接见[Provider 与协议](providers-and-protocols.md)；选区和输入生命周期见[界面与加载](ui-and-loading.md)。

### 改模型、Reasoning、Speed 或切换 Provider

- 入口：[ModelPicker.loadModelOptions](../../extension/src/content/modelPicker.js)、[ProjectProviderSelection](../../extension/src/content/projectProviderSelection.js)。
- 状态 owner：[models](../../extension/src/shared/models.js) 规范化能力；[ProviderSettingsCoordinator](../../extension/src/content/providerSettingsCoordinator.js) 协调配置；项目选择与已提交运行快照分别保存。
- 必须联动：[modelPickerSupport](../../extension/src/content/modelPickerSupport.js)、[providerRuntime.resolveProviderModels](../../native-host/src/providerRuntime.js)、[runExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js)；保留 generation、providerId、providerRevision 迟到响应守卫。
- 快捷入口还需检查 [ProviderProfiles](../../extension/src/shared/providerProfiles.js) 与 dialog 的协议/地址/认证联动；Speed 最终参数由 [codexArgs.buildCodexSpeedArgs](../../native-host/src/codexArgs.js) 生成。Native 默认 Provider 与当前项目选择是不同状态，清密钥/改端点后的文案不能单独证明已切换。
- 若问题涉及已排队任务实际使用哪个配置，沿 `RunExecutionSnapshot.resolveForExecution` → `RunInputQueue.claimNext` → `RunQueueScheduler.scheduleOne` 检查暂停分支，再核对 Native `providerRuntime.resolveRunProvider/resolveRunProviderForRun`；模型目录加载不能代替执行校验。
- 最近测试：[modelSelectionRecovery](../../test/modelSelectionRecovery.test.js)、[providerSessionBinding](../../test/providerSessionBinding.test.js)、[models](../../test/models.test.js)。

### 改 Ask/Auto、发送控件或编辑选区

- 入口：[ComposerPanel.create](../../extension/src/content/composerPanel.js)、[SelectionContextView.attach](../../extension/src/content/selectionContextView.js)、runtime 的 `safeRunTask`。
- 状态 owner：[sessionState](../../extension/src/shared/sessionState.js) 保存草稿；[selectionContext](../../extension/src/shared/selectionContext.js) 规范化选区；发送时进入 execution snapshot。
- 必须联动：[pageBridge.getSelectionContext](../../extension/src/pageBridge.js)、[Native selectionScope](../../native-host/src/selectionScope.js)、[runExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js)。当前仅 Ask/Auto，默认 Ask；旧 `confirm` 归一化为 Ask。
- Edit Selection 准入比较整份文档摘要；任一收集改动越出允许范围时，整组改动会被阻止，不能把单个合法补丁视为一定会单独写入。
- 最近测试：[p0ProductExperience](../../test/p0ProductExperience.test.js)、[sentSelectionChip](../../test/sentSelectionChip.test.js)、[runExecutionSnapshot](../../test/runExecutionSnapshot.test.js)。

### 改 @文件上下文、粘贴/拖放附件或附件限额

- 入口：[ContextTray](../../extension/src/content/contextTray.js)、[ComposerAttachments.createComposerAttachmentController](../../extension/src/content/composerAttachments.js)。
- 状态 owner：会话保存 focused files；附件控制器管理当次输入文件、异步读取和去重；运行快照保留提交时信息。
- 必须联动：[contentRuntime](../../extension/src/content/contentRuntime.js) 注入的限额、[turnAttachments](../../native-host/src/turnAttachments.js)、[nativeQuotas](../../native-host/src/nativeQuotas.js)、[runInputQueue](../../extension/src/shared/runInputQueue.js) 与附件持久化裁剪。
- 普通 `@path` 文字与 focus 列表独立；批量附件的部分读入与末尾渲染也分别处理。排查缺附件需核对内部数组、可见 tray 和最终运行参数。
- 最近测试：[contextTray](../../test/contextTray.test.js)、[p0ProductExperience](../../test/p0ProductExperience.test.js)、[nativeQuotas](../../test/nativeQuotas.test.js)、[runInputQueue](../../test/runInputQueue.test.js)。

### 改编译日志引用或编译错误修复入口

- 入口：runtime `renderAtFileMenu/runTask` 解析 `@compile-log`，以及 [RunTimelineView](../../extension/src/content/runTimelineView.js) 的 `appendCompileFix` 回填草稿。
- 状态 owner：[CompileBridge](../../extension/src/page/compileBridge.js) 管理页面缓存及编辑时间戳；[WritebackOrchestrator.resolveCompileLogContext](../../extension/src/content/writebackOrchestrator.js) 协调日志获取。
- 必须联动：`getCompileLog` 的刷新和身份策略、[RunController](../../extension/src/content/runController.js) 参数、[codexPromptAssembly](../../native-host/src/codexPromptAssembly.js) 及失败继续行为。显式日志请求与写后自动编译是两条入口，详见[界面与加载](ui-and-loading.md)。
- 最近测试：[compileAdapter](../../test/compileAdapter.test.js)、[runControllerContent](../../test/runControllerContent.test.js)、[codexPromptAssembly](../../test/codexPromptAssembly.test.js)。

## 运行、队列与共享会话

编辑重发和运行中草稿的 UI 路线另见[界面与加载](ui-and-loading.md)，主入口为 `RunTimelineView.configureEditButton`、`PanelMaintenance.refillComposerForRetry`、runtime `prepareRetryReplacement/persistPanelInputs`。已提交快照、当前草稿和排队项的字段及寿命分别核对。

### 改提交、取消、队列或运行中追加指导

- 入口：runtime 的 `safeRunTask`、[RunQueueScheduler.createCoordinator](../../extension/src/content/runQueueScheduler.js)、[ActiveTurnControl](../../extension/src/content/activeTurnControl.js)。
- 状态 owner：[runExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js) 固定执行输入；[runInputQueue](../../extension/src/shared/runInputQueue.js) 管理队列；[taskRunnerRuntime](../../native-host/src/taskRunnerRuntime.js) 管理活跃 Native 工作。
- 必须联动：[runGuidanceController](../../extension/src/content/runGuidanceController.js)、[scopedPersistenceTransaction](../../extension/src/shared/scopedPersistenceTransaction.js)、[nativeRequestIdentity](../../extension/src/shared/nativeRequestIdentity.js)。详细链路见[运行状态与恢复](run-state-and-recovery.md)。
- 最近测试：[runInputQueueSnapshotRegression](../../test/runInputQueueSnapshotRegression.test.js)、[runQueueSchedulerDurability](../../test/runQueueSchedulerDurability.test.js)、[activeTurnControl](../../test/activeTurnControl.test.js)、[nativeDispatchCancellation](../../test/nativeDispatchCancellation.test.js)。

### 改刷新恢复、跨标签同步、删除会话或分叉

- 入口：[SessionManager](../../extension/src/content/sessionManager.js)、[SessionForkController](../../extension/src/content/sessionForkController.js)、[SharedSessionViewSync.install](../../extension/src/content/sharedSessionViewSync.js)。
- 状态 owner：[backgroundSharedSessions.createService](../../extension/src/backgroundSharedSessions.js) 管理共享持久存储；[ScopedPersistenceTransaction](../../extension/src/shared/scopedPersistenceTransaction.js) 管理作用域提交；content 保留当前视图。
- 必须联动：[scopedPersistenceCoordinator](../../extension/src/content/scopedPersistenceCoordinator.js)、[storageSessionClaims](../../extension/src/shared/storageSessionClaims.js)、[sessionState](../../extension/src/shared/sessionState.js)、Native [codexThreadFork](../../native-host/src/codexThreadFork.js)。详细链路见[运行状态与恢复](run-state-and-recovery.md)。
- 最近测试：[scopedPersistenceTransaction](../../test/scopedPersistenceTransaction.test.js)、[crossTabRuntimeRegression](../../test/crossTabRuntimeRegression.test.js)、[sessionTombstones](../../test/sessionTombstones.test.js)、[sessionForkController](../../test/sessionForkController.test.js)。

### 改新建、重命名、最后会话或清空历史

- 入口：[SessionManager](../../extension/src/content/sessionManager.js) 的 `startNewSession/switchSession/commitSessionRename/deleteSessionWithConfirm`；[PanelMaintenance.clearAllHistoryWithConfirm](../../extension/src/content/panelMaintenance.js) 是另一种清理入口。
- 状态 owner：`SessionState` 负责空会话复用、标题来源、容量及删除后替代会话；共享库、站点辅助库和 Native 历史各有清理范围。
- 必须联动：当前可达的 PanelRenderer/SessionPanel callbacks、持久化墓碑、内存 `session/task`、提示文案；清库成功不能推定内存也已清空。详见[会话生命周期](run-state-and-recovery.md#session-lifecycle)和[清空历史状态](run-state-and-recovery.md#clear-history-state)。
- 最近测试：[sessionState](../../test/sessionState.test.js)、[sessionManagement](../../test/sessionManagement.test.js)、[sessionTombstones](../../test/sessionTombstones.test.js)；实际清理还需检查状态归一化和保存结果。

### 改项目主页、最近项目或会话列表

- 入口：[RecentProjects](../../extension/src/content/recentProjects.js)、[SessionPanel](../../extension/src/content/sessionPanel.js)；runtime 处理 SPA route 切换。
- 状态 owner：共享会话存储提供记录，recent projects 生成账号作用域的展示投影。
- 必须联动：[sharedSessionBridge](../../extension/src/shared/sharedSessionBridge.js)、[sessionTitle](../../extension/src/shared/sessionTitle.js)、[projectSessionCleanup](../../extension/src/content/projectSessionCleanup.js)；投影应服从账号隔离与删除结果。
- 最近测试：[dashboardSessions](../../test/dashboardSessions.test.js)、[sessionManagement](../../test/sessionManagement.test.js)、[sessionPersistenceAccountIsolation](../../test/sessionPersistenceAccountIsolation.test.js)。

## 快照、镜像、写回与 Undo

展示差异与执行补丁分别由 Native [diffEngine.computeLineDiff](../../native-host/src/diffEngine.js) 和 [textPatch.computeTextPatches](../../native-host/src/textPatch.js) 生成；page `applyTextPatches` 负责检查与应用。修改差异粒度或坐标时，先读[Auto 修改与撤销](auto-edit-undo.md)及 [diffEngine](../../test/diffEngine.test.js)、[textPatch](../../test/textPatch.test.js) 测试定义。

### 改项目读取、ZIP 回退或 OT 预热镜像

- 入口：[snapshotRouter](../../extension/src/page/snapshotRouter.js)、[overleafProjectSnapshot](../../extension/src/page/overleafProjectSnapshot.js)、[OtWarmMirror](../../extension/src/content/otWarmMirror.js)。
- 状态 owner：Page 提供读取证据；[mirrorWorkspace](../../native-host/src/mirrorWorkspace.js) 管理本地文件与 baseline；[mirrorHealth](../../extension/src/content/mirrorHealth.js) 投影镜像可用性。
- 必须联动：[otWarmMirrorController](../../extension/src/content/otWarmMirrorController.js)、[shared/otText](../../extension/src/shared/otText.js)、[taskRunnerRuntime](../../native-host/src/taskRunnerRuntime.js) 的 mirror 方法、快照完整性和空字符串语义。
- ZIP 前快启入口为 `resolveWarmRunStart`；OT producer 的非空 overlays 与 Native validator 的拒绝条件存在冲突，需同时定位 `mirror_stale` 回退，详见写回章节。
- 最近测试：[pageBridgeSnapshotCache](../../test/pageBridgeSnapshotCache.test.js)、[mirrorWorkspace](../../test/mirrorWorkspace.test.js)、[otWarmMirrorIntegration](../../test/otWarmMirrorIntegration.test.js)、[mirrorHealth](../../test/mirrorHealth.test.js)。

### 改 Auto 编辑、保存确认、编译或失败重试

- 入口：[WritebackOrchestrator.applySyncChangesToOverleaf](../../extension/src/content/writebackOrchestrator.js)、[writebackRouter](../../extension/src/page/writebackRouter.js)。
- 状态 owner：[writebackSettlement](../../extension/src/shared/writebackSettlement.js) 汇总结果；[saveState](../../extension/src/page/saveState.js) 观察保存；[writebackReceiptJournal](../../extension/src/page/writebackReceiptJournal.js) 保存页面操作回执。
- 必须联动：[staleGuard](../../extension/src/shared/staleGuard.js)、[writebackController](../../extension/src/content/writebackController.js)、[compileBridge](../../extension/src/page/compileBridge.js)、[runSettlementPersistence](../../extension/src/content/runSettlementPersistence.js)。详细链路见[Auto 编辑与 Undo](auto-edit-undo.md)。
- 最近测试：[writebackSaveCheck](../../test/writebackSaveCheck.test.js)、[writebackSettlementContract](../../test/writebackSettlementContract.test.js)、[writebackReceiptRecovery](../../test/writebackReceiptRecovery.test.js)、[writebackCancellationFlow](../../test/writebackCancellationFlow.test.js)。

### 改 Accept、Undo、新建/删除文件或二进制资产

- 入口：runtime 的 run 操作回调、[trackedChangesLifecycle](../../extension/src/page/trackedChangesLifecycle.js)、[AssetTransferBroker](../../extension/src/content/assetTransferBroker.js)。
- 状态 owner：[undoOperations](../../extension/src/shared/undoOperations.js) 与 run checkpoint 保存撤销证据；页面 receipt 和 settlement 记录部分完成结果。
- 支持范围：Auto 重命名按 create/delete 拆分，二进制删除、生成 PDF 与资产扩展名另有过滤；原有文件删除的恢复不能套用“编辑＋新建”的 Undo 路线，详见[文件操作与撤销限制](auto-edit-undo.md)。
- 二进制覆盖走 uploader 独立链，当前未携带旧版本基线比较；新载荷完整性和上传后核验不能单独证明覆盖前远端未变化。
- 必须联动：[treeOperations](../../extension/src/page/treeOperations.js)、[nativeAssetTransfer](../../native-host/src/nativeAssetTransfer.js)、[writebackSettlement](../../extension/src/shared/writebackSettlement.js) 和镜像失效处理。详细链路见[Auto 编辑与 Undo](auto-edit-undo.md)。
- 最近测试：[writebackRouterAccept](../../test/writebackRouterAccept.test.js)、[createdFileUndo](../../test/createdFileUndo.test.js)、[ordinaryUndoRouting](../../test/ordinaryUndoRouting.test.js)、[binaryUploadUndoRoundTrip](../../test/binaryUploadUndoRoundTrip.test.js)。

## Native、Provider、子代理与写作风格

领域说明：[Native 执行](native-execution.md)、[Provider 与协议](providers-and-protocols.md)、[并行子代理](parallel-subagents.md)、[写作风格与技能](writing-style-and-skills.md)。

### 加 Native 方法、事件或 Provider 协议能力

- 入口：[background.js](../../extension/src/background.js) → [native index](../../native-host/src/index.js) → [taskRunnerRuntime.handleRequest](../../native-host/src/taskRunnerRuntime.js) / [providerRuntime.handleProviderRequest](../../native-host/src/providerRuntime.js)。
- 状态 owner：Native 管理进程与运行；[providerStore](../../native-host/src/providerStore.js) 保存 Provider 配置；[providerProfile](../../native-host/src/providerProfile.js) 定义配置结构。
- 必须联动：[NativeChannel](../../extension/src/content/nativeChannel.js)、[nativeTransportEnvelope](../../native-host/src/nativeTransportEnvelope.js)、[nativeQuotas](../../native-host/src/nativeQuotas.js)、[providerBridgeRoutes](../../native-host/src/providerBridgeRoutes.js)、双方 compatibility、secret 脱敏与取消路径。
- 最近测试：[nativeMessaging](../../test/nativeMessaging.test.js)、[streamEvents](../../test/streamEvents.test.js)、[providerReliability](../../test/providerReliability.test.js)、[nativeTransportEnvelope](../../test/nativeTransportEnvelope.test.js)。

### 改并行子代理、文件归属或子对话展示

- 入口：[subagentBroker.createSubagentBroker](../../native-host/src/subagentBroker.js)、[subagentActivityView](../../extension/src/content/subagentActivityView.js)。
- 状态 owner：broker 管理任务槽、worker 和取消；[subagentWorkspace](../../native-host/src/subagentWorkspace.js) 管理工作空间；[subagentTelemetry](../../native-host/src/subagentTelemetry.js) 生成运行事件。
- 必须联动：[codexSessionRunner](../../native-host/src/codexSessionRunner.js)、[subagentActivityModel](../../extension/src/shared/subagentActivityModel.js)、[parallel-subagents skill](../../native-host/src/skills/parallel-subagents/SKILL.md)，以及运行 settlement。
- 最近测试：[subagentBroker](../../test/subagentBroker.test.js)、[parallelSubagents](../../test/parallelSubagents.test.js)、[subagentTelemetry](../../test/subagentTelemetry.test.js)、[subagentActivityView](../../test/subagentActivityView.test.js)。

### 改 Write in My Style、参考资料或 skills

- 入口：[WritingStyleSettings](../../extension/src/content/writingStyleSettings.js)、[writingStyleRuntime.build/get/set/forRun](../../native-host/src/writingStyleRuntime.js)、[LocalSkillsPanel](../../extension/src/content/localSkillsPanel.js)。
- 状态 owner：Native 风格配置带 revision 和版本 bundle；[writingStyleProfile](../../native-host/src/writingStyleProfile.js) 校验生成结构；[localSkills](../../native-host/src/localSkills.js) 管理本地技能。
- 必须联动：[referenceProjects](../../extension/src/page/referenceProjects.js)、[writingStyleEvidence](../../native-host/src/writingStyleEvidence.js)、[runExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js)、[codexPromptAssembly](../../native-host/src/codexPromptAssembly.js)，以及全局 skill 开关。
- 最近测试：[writingStyleLimits](../../test/writingStyleLimits.test.js)、[localSkills](../../test/localSkills.test.js)、[runExecutionSnapshot](../../test/runExecutionSnapshot.test.js)。

## 上下文扫描与写入治理

领域说明：[上下文与治理](context-and-governance.md)。

- 入口：runtime `runSensitivePreflight`、[SensitiveScan](../../extension/src/shared/sensitiveScan.js)、[mirrorSensitiveScan](../../native-host/src/mirrorSensitiveScan.js)；写回时走 [WritebackPlan](../../extension/src/content/writebackPlan.js) 与 [GovernanceRules](../../extension/src/shared/governanceRules.js)。
- 状态 owner：[ProjectSettingsCoordinator](../../extension/src/content/projectSettingsCoordinator.js) 保存项目规则；扫描发现、跳过项和审计摘要有各自的消费范围。
- 必须联动：首次与业务重试的实际输入、[codexPromptAssembly](../../native-host/src/codexPromptAssembly.js)、写入类型及来源/目标路径、[AuditRecords](../../extension/src/shared/auditRecords.js)。规则不等同模型本地文件权限，零发现不等同全部材料已扫描。
- 最近测试：[sensitiveScan](../../test/sensitiveScan.test.js)、[governanceRules](../../test/governanceRules.test.js)、[taskRunner](../../test/taskRunner.test.js)、[p0ProductExperience](../../test/p0ProductExperience.test.js)。

## 安装、更新与发布

领域说明：[安装与更新](installation-and-updates.md)。

### 改安装、doctor、托管更新或发布包

- 入口：[CLI](../../bin/codex-overleaf-link.mjs)、[install-managed](../../scripts/install-managed.mjs)、[bootstrap/background](../../extension/bootstrap/background.js)、[release workflow](../../.github/workflows/release.yml)。
- 状态 owner：[managedInstall](../../native-host/src/managedInstall.js) 管理安装；[updateManager](../../native-host/src/updateManager.js) 管理更新；[backgroundUpdateCoordinator](../../extension/src/backgroundUpdateCoordinator.js) 协调授权与浏览器状态。
- 必须联动：[nativeDoctor](../../native-host/src/nativeDoctor.js)、[managedUpdateProjection](../../extension/src/shared/managedUpdateProjection.js)、[updateTrust](../../native-host/src/updateTrust.js)、[build-release](../../scripts/build-release.mjs)、manifest/版本及 npm 包边界。
- 最近测试：[managedInstall](../../test/managedInstall.test.js)、[nativeInstallScripts](../../test/nativeInstallScripts.test.js)、[updateManager](../../test/updateManager.test.js)、[releaseScripts](../../test/releaseScripts.test.js)；发布还需另读当前发布 skill。

## 新增模块与能力的加载清单

Content 源模块采用以下顺序；源码入口与浏览器注入清单承担不同职责。

1. 在 [content-entry.mjs](../../extension/entries/content-entry.mjs) 加入 canonical source import；通过 [ModuleRegistry.define](../../extension/src/content/moduleRegistryKernel.js) 声明显式依赖。
2. 需要直接暴露给组合根时，更新 [legacyGlobalRegistry](../../extension/src/content/legacyGlobalRegistry.js) 的依赖集合；在 [contentRuntime](../../extension/src/content/contentRuntime.js) 装配 callbacks/getters。
3. 由 [build-content-bundle](../../scripts/build-content-bundle.mjs) 生成 bundle 与 metadata；不手改生成文件。该操作会写入产物。
4. [direct manifest](../../extension/manifest.json) 与 [runtime manifest](../../extension/runtime-manifest.json) 当前各列一个 content bundle；新增普通 content 模块不向两处追加源脚本。
5. 验证定义位于 [contentModuleRegistry](../../test/contentModuleRegistry.test.js)、[contentScriptLoadOrder](../../test/contentScriptLoadOrder.test.js)、[contentBuildIdentity](../../test/contentBuildIdentity.test.js) 和 [module graph 检查](../../scripts/check-content-module-graph.mjs)。

Page-world 能力采用独立清单：实现 → RPC contract → 资源公开 → 顺序注入 → dispatcher → 验证。

1. 在页面模块实现能力，并在 [pageRpcContract](../../extension/src/shared/pageRpcContract.js) 分类读取/修改、身份要求和超时；在 [pageBridge](../../extension/src/pageBridge.js) 接入 dispatcher/capability。
2. 检查 [direct WAR](../../extension/manifest.json) 与 [managed WAR](../../extension/bootstrap/manifest.template.json) 覆盖所需资源；managed 已使用 shared/page 通配清单。
3. 修改 [pageBridgeClient.PAGE_WORLD_SCRIPTS / injectPageBridge](../../extension/src/content/pageBridgeClient.js) 保持依赖顺序；runtime 仅创建并启动 client。
4. 联动 [pageBridgeClient 测试](../../test/pageBridgeClient.test.js)、[pageRpcContract 测试](../../test/pageRpcContract.test.js)、[manifest 测试](../../test/manifest.test.js)，并为修改操作覆盖缺失/错误项目身份与重复请求。

任何路线的改动都应先固定所属项目、会话与运行，再审视异步结果和持久化；UI 显示“完成”应能回溯到相应执行、写入、保存或撤销证据。
