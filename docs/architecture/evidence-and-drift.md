# 证据、文档漂移与待完善契约

本页记录架构指南的证据边界，以及源码、测试和旧说明之间已经核实的差异。
维护者应从[指南入口](README.md)选择阅读路径，再用本页核对一项结论能支持多强的判断。

## 1. 核验基线与证据等级

- 核验日期：2026-10-03；源码基线：`main@2073ae74747431aab8d529803d4e9f8197262388`。
- 包版本：`2.5.0`，见根目录 [package.json](../../package.json)。
- 本轮进行了源码、测试定义、工作树与文档的静态阅读；未运行产品测试、构建、安装或浏览器验收。
- 下文“源码事实”说明所读代码具有该分支或约束；运行环境能否完成对应操作仍需相应执行证据。
- 文中的符号指函数、常量或协议方法名；符号与文件路径共同帮助后续 agent 定位，行号仅是基线下的辅助锚点。

| 等级 | 能够支持的结论 | 不能据此推定 |
|---|---|---|
| 源码核实 | owner、调用分支、常量、字段及守卫存在 | 所有真实环境均正确执行 |
| 测试存在 | 仓库声明了某项回归场景；可定位最近验证入口 | 本轮测试通过或全部边界均被覆盖 |
| 测试运行 | 指定提交、命令与环境下的实际结果 | 未运行的平台、浏览器或网络路径也通过 |
| CUA 历史 | 特定日期、安装副本和页面上的实际操作证据 | 当前 HEAD、另一份安装或完整产品均已验收 |
| 发布历史 | 当时保存的公开资产、签名或 registry 核验记录 | 当前远端状态与新候选发布流程仍相同 |

CUA 指对真实浏览器界面的操作验收。它像特定车辆的一次路试，记录车辆身份和路况后才有可复用意义。
源码、构建产物、磁盘安装、浏览器已加载 runtime、远端发布产物分别具有自己的身份；具体边界见[系统总览](system-overview.md)。
例如，磁盘已安装新版本但页面仍运行旧 bundle，不能仅凭 `package.json` 推定实际页面版本。

## 2. HEAD、工作树与历史材料的范围

| 范围 | 本轮事实 | 指南处理 |
|---|---|---|
| 已提交产品源码 | 产品核验提交如上；后续纯文档提交不改变 runtime | 作为架构说明的产品代码基线 |
| 未提交发布候选 | `.github/workflows/release.yml` 已修改；`scripts/wait-for-npm-publication.mjs` 尚未跟踪 | 单列候选变化，不能称为已发布行为 |
| 新架构指南 | 本轮新增的文档与入口调整 | 说明源码，不改变产品契约的执行结果 |
| 私有交接材料 | `.local-handoff/` 包含发布恢复与 CUA 历史 | 只用于本地背景；不作为指南必需依赖，不复制私人现场内容 |
| 旧指南材料 | `docs/agents/` 的本地指南包含历史基线与后补章节 | 仅作为漂移线索；新指南直接引用源码和测试，避免必需依赖该目录 |

发布候选将“等待 npm 可见”交给 `waitForNpmPublication()`：共享十分钟预算，核验公开 metadata 和实际 tarball 的 SHA-512。
工作流位置为 [release.yml](../../.github/workflows/release.yml) 的 npm 发布后验证步骤；候选脚本路径为 `scripts/wait-for-npm-publication.mjs`。
该脚本尚未跟踪，新克隆可能没有它；本指南不把候选脚本作为必备链接，HEAD 中仍可见原循环。
现有 [releaseScripts.test.js](../../test/releaseScripts.test.js#L1749) 仍要求旧的十二次、每次五秒循环；新的等待逻辑专项测试尚未补齐。
此项状态为“实现候选存在、测试定义待更新、执行未验证”；后续应补虚拟时钟与请求注入测试，再决定是否提交。
私有交接记载的 `v2.5.0` 发布成功属于历史证据；本轮未重新核验 GitHub、npm 或已安装浏览器。

## 3. 文档漂移登记

`D-*` 表示文档与当前源码的差异，不自动代表产品缺陷。每项均分别记录现有行为、证据和后续处理。

### D-01：content 模块接入配方仍沿用多脚本注册

- 类型：旧配方漂移。旧架构说明已介绍单 bundle，后面的配方仍要求登记 classic global、向两条加载路径插入模块。
- 源码事实：`content-entry.mjs` 是纳入入口，`buildContentBundle()` 生成 bundle；模块依赖由 registry/组合入口组织。
- 证据：[content-entry.mjs](../../extension/entries/content-entry.mjs)、[构建器](../../scripts/build-content-bundle.mjs#L34)、[模块图检查](../../scripts/check-content-module-graph.mjs)。
- 测试存在：[contentModuleRegistry.test.js](../../test/contentModuleRegistry.test.js)、[manifest.test.js](../../test/manifest.test.js)、[managedInstall.test.js](../../test/managedInstall.test.js)。
- 新指南处理：通过[功能地图](feature-map.md)路由到源码入口，保留 Direct/Managed 注入面检查；新增模块统一配方位于同页加载清单。

### D-02：模式数量与默认值

- 类型：旧默认值漂移。旧功能说明含 Suggest / `confirm` 默认值。
- 源码事实：界面提供 Ask / Auto，`DEFAULT_PANEL_STATE.mode` 为 `ask`；历史 `confirm` 数据经状态规范化处理。
- 证据：[composerPanel.js](../../extension/src/content/composerPanel.js#L32)、[sessionState.js](../../extension/src/shared/sessionState.js#L36)。
- 测试存在：[p0ProductExperience.test.js](../../test/p0ProductExperience.test.js#L501)、[sessionState.test.js](../../test/sessionState.test.js)。
- 新指南处理：用当前入口说明功能；旧模式只保留在迁移说明，避免 agent 增加已经移除的 UI 分支。

### D-03：共享历史的服务层缺失

- 类型：owner 与存储路径遗漏。只说明页面侧 IndexedDB 会遗漏当前跨站点共享路径。
- 源码事实：`SharedSessionBridge.decorate()` 装饰存储 API；符合启用条件时经扩展后台读写共享 IndexedDB，保留 legacy 路径。
- 证据：[storageDb.js](../../extension/src/shared/storageDb.js#L1298)、[sharedSessionBridge.js](../../extension/src/shared/sharedSessionBridge.js)、[backgroundSharedSessions.js](../../extension/src/backgroundSharedSessions.js#L74)。
- 测试存在：[crossTabRuntimeRegression.test.js](../../test/crossTabRuntimeRegression.test.js)、[storageDb.test.js](../../test/storageDb.test.js)。
- 新指南处理：在[运行与恢复](run-state-and-recovery.md)区分账号/项目作用域、页面 owner、共享锁和 hydration；后续补共享历史专题。

### D-04：Provider 切换与队列快照

- 类型：旧缺口描述失效。旧说明声称项目 Provider 切换仍会违背队列不可变契约。
- 源码事实：`projectProviderSelection.commit()`更新未来默认值，保留已有 `pendingInputs` 和 `runs`；不能据旧条目断言当前仍改写队列。
- 证据：[projectProviderSelection.js](../../extension/src/content/projectProviderSelection.js#L24)、[runExecutionSnapshot.js](../../extension/src/shared/runExecutionSnapshot.js)。
- 测试存在：[projectProviderSelection.test.js](../../test/projectProviderSelection.test.js#L18)、[runInputQueueSnapshotRegression.test.js](../../test/runInputQueueSnapshotRegression.test.js)。
- 新指南处理：记录提交时执行配置及消费时验证；后续 Provider 专题仍需解释 revision 变化、配置失效和重试边界。

### D-05：保存证据与编译门槛

- 类型：状态含义与调用策略漂移。旧说明把编译前安全点概括为接受 `verified_saved` / `verified_quiet`。
- 源码事实：`triggerCompile()`默认要求 `verified_saved`；写后自动编译可显式放宽该要求，并把保存未确认的状态保留在结果中。
- 证据：[compileBridge.js](../../extension/src/page/compileBridge.js#L92)、[autoRecompileAfterWriteback()](../../extension/src/content/writebackOrchestrator.js#L696)。
- 保存补证路径可通过服务端 ZIP/receipt；`confirmSaveCheck()`要求匹配真实服务端内容，二进制 digest 缺少可读字节不能证明保存，见 [writebackController.js](../../extension/src/content/writebackController.js#L501)。
- 测试存在：[compileAdapter.test.js](../../test/compileAdapter.test.js)、[writebackSaveCheck.test.js](../../test/writebackSaveCheck.test.js)、[writebackReleaseContract.test.js](../../test/writebackReleaseContract.test.js)。
- 新指南处理：在[Auto 编辑与撤销](auto-edit-undo.md)分开 applied、readback、saved、compiled；后续按调用入口核对门槛，避免用一个布尔值概括全部链路。

### D-06：Writing Style 的 PDF 限额

- 类型：同一旧文档主文与补充章节冲突。主文写单 PDF 5 MiB、合计8 MiB，后补说明已有新值。
- 源码事实：`REFERENCE_LIMITS`为最多三份参考，单 PDF 20 MiB、PDF合计40 MiB、项目4 MiB、附件合计44 MiB、提取超时90秒。
- 证据：[writingStyle.js](../../extension/src/shared/writingStyle.js#L7)、[writingStylePdfWorker.js](../../native-host/src/writingStylePdfWorker.js)。
- 测试存在：[writingStyleLimits.test.js](../../test/writingStyleLimits.test.js)覆盖限额与 Base64 后的消息预算；本轮未执行。
- 新指南处理：写作风格参考与普通聊天附件分别路由；后续补真实大 PDF 验收，不能由限额测试推定提取质量。

### D-07：子代理时间预算

- 类型：旧数值漂移。旧说明为 worker 300,000 ms、broker 900,000 ms。
- 源码事实：`DEFAULT_LIMITS`为 worker 600,000 ms、broker 1,800,000 ms；默认并行3、总任务8。环境覆盖有界，构造器还接受测试/调用方 limits。
- 证据：[subagentBroker.js](../../native-host/src/subagentBroker.js#L31) 的 `DEFAULT_LIMITS` 与 `boundedMs()`。
- 测试存在：[subagentBroker.test.js](../../test/subagentBroker.test.js)覆盖预算准入及超时，[parallelSubagents.test.js](../../test/parallelSubagents.test.js)覆盖接入。
- 新指南处理：分别列默认、环境覆盖、测试注入；后续专题说明文件所有权、取消和父代理收口。

### D-08：Bootstrap 协议与升级路径

- 类型：旧协议值与状态分支漂移。旧说明为 Bootstrap protocol 2，并指导旧版本安装2.2.0。
- 源码事实：`BOOTSTRAP_PROTOCOL=3`；可信但协议不同的候选可报告 `manual_install_required`，stage/apply仍拒绝不兼容候选。
- 证据：[updateTrust.js](../../native-host/src/updateTrust.js#L8)、[版本迁移说明](../../README.md#quick-start)、[阶段目录](../../extension/src/shared/managedUpdateProjection.js#L11)。
- 测试存在：[updateTrust.test.js](../../test/updateTrust.test.js)、[updateManualInstall.test.js](../../test/updateManualInstall.test.js)、[updateBoundaryWorkingTree.test.js](../../test/updateBoundaryWorkingTree.test.js)。
- 新指南处理：区分 Native runtime 协议与 Bootstrap 协议；后续解释原位升级演练和“拒绝升级、要求重装”演练的不同证据。

## 4. 源码支持的待完善契约

`G-*` 表示重新检查源码后仍能定位的限制。条目描述具体作用域，不从旧 Known gap 名单直接继承结论。

### G-01：已知为空的内容在部分路径仍被过滤

- 源码事实：`checkOperationFreshness()`在 baseline 为空或纯空白时直接放行，见 [staleGuard.js](../../extension/src/shared/staleGuard.js#L44)。
- 同类路径：`isUsableProjectFileContent()`过滤空白，`buildActiveEditorOverlay()`和`mergeSnapshotFiles()`使用该判断，见 [projectFiles.js](../../extension/src/shared/projectFiles.js#L163)、[snapshotRouter.js](../../extension/src/page/snapshotRouter.js#L523)。
- 目标契约：已知空串 `""`、未知内容、已知非空应分开；空串同样参与 stale 比较，并能覆盖旧 ZIP 内容。
- 最近测试：[staleGuard.test.js](../../test/staleGuard.test.js)、[pageBridgeStaleGuard.test.js](../../test/pageBridgeStaleGuard.test.js)。测试文件存在不能证明上述目标已覆盖。
- 剩余动作：建立空串、纯空白、编辑器清空与旧 ZIP 冲突的失败用例，再评估最小修复；本轮未修改产品。

### G-02：页面模式切换的项目身份仍为可选

- 源码事实：`METHODS.ensureReviewing/ensureEditing`的`projectIdentity`为`optional`；`dispatch()`仅在传入身份时执行对应身份守卫。
- 证据：[pageRpcContract.js](../../extension/src/shared/pageRpcContract.js#L20)、[pageBridge.js](../../extension/src/pageBridge.js#L266)。
- 目标契约：改变编辑/审阅状态前拥有明确项目身份；当前不能宣称所有 page-state mutation 都拒绝缺失身份的请求。
- 最近测试：[pageRpcContract.test.js](../../test/pageRpcContract.test.js)、[pageBridgeStaleGuard.test.js](../../test/pageBridgeStaleGuard.test.js#L997)；后者存在空参数切换模式用例。
- 剩余动作：检查全部调用方及兼容需求，新增缺失/不匹配身份测试后再变更协议；本条不等同于外部页面可绕过 capability 认证。

### G-03：凭据存储与 journal 用语需要规范范围

- 源码事实：`commitProviderState()`把 `previousSecrets`写入本机专用 Provider 事务恢复文件，恢复后删除；该文件属于受限凭据存储。
- 证据：[providerStore.js](../../native-host/src/providerStore.js#L374)；目录创建/收紧为`0700`，原子文件写入为`0600`，见同文件`ensurePrivateDirectory()`、`atomicWriteJson()`；POSIX权限在部分平台不具相同语义。
- 契约范围：禁止凭据进入浏览器持久状态、运行 journal、诊断和日志；专用本地凭据存储及其恢复文件必须按 owner 的权限、原子写入和清理规则描述。
- 最近测试：[providerReliability.test.js](../../test/providerReliability.test.js#L193)检查存储锁恢复与版本一致；本轮未确认每个恢复故障点都有专项覆盖。
- 剩余动作：在 Provider/隐私专题审阅数据去向与恢复文件生命周期，避免将“任何 journal 不含秘密”写成源码事实；本轮未调整凭据实现。

### G-04：显式创建重试参数在执行回执层未继续传递

- 来源：本轮独立定位验收发现的静态调用链缺口；未复现浏览器故障，也未修改产品代码。
- 源码事实：`contentRuntime.retryRunWriteback` → `writebackOrchestrator.applySyncChangesToOverleaf` → `assetTransferBroker.applyOperations` 将 `retryCreates: true` 送入 Page RPC。
- 参数缺口：[writebackReceiptJournal.js](../../extension/src/page/writebackReceiptJournal.js) 的 `apply` 重建 options 时未转发 `retryCreates`；[pageBridge.js](../../extension/src/pageBridge.js) 注入的 `applyOperations` wrapper 也未补入该值。
- 下游含义：[writebackRouter.js](../../extension/src/page/writebackRouter.js) 依赖该字段设置 `allowExistingMatches`；[textFileCreator.js](../../extension/src/page/textFileCreator.js) 的已有同内容幂等分支因此不能被描述为真实显式重试已贯通。
- 目标契约：显式重试应完整传递所需语义，匹配内容可识别为已有结果，冲突内容保持拒绝；幂等命中还不能被登记为本轮可删除的新建文件。
- 范围限定：原 `requestId` 的 receipt 查询/重复派发取回原结果具有独立机制。此缺口不表示该机制失效，也不证明已经发生重复创建；文件存在性守卫仍在。
- 最近测试：[textFileCreator.test.js](../../test/textFileCreator.test.js) 直接覆盖 `allowExistingMatches`；[writebackReceiptRecovery.test.js](../../test/writebackReceiptRecovery.test.js) 检查部分模式参数转发；[writebackEditRetry.test.js](../../test/writebackEditRetry.test.js) 覆盖恢复意图。静态检索未找到 `retryCreates` 穿过真实 journal 的专项断言，本轮未执行这些测试。
- 剩余动作：后续产品修复任务应先补 broker → journal → router 的参数与同内容/异内容集成用例，再修复传递；本轮只修正指南中的保证范围。

### G-05：取消可能阻止页面部分写入结果返回到恢复账本

- 来源：第二轮对抗式文档审阅及调用链静态复核；未进行故障注入，未修改产品。
- 源码事实：[writebackRouter.js](../../extension/src/page/writebackRouter.js) 可保留取消前的逐项结果；但 [assetTransferBroker.js](../../extension/src/content/assetTransferBroker.js) 的 `recoverTextReceipt` 遇 `codex_cancelled` 会直接抛出。
- 跨层条件：[pageBridgeClient.js](../../extension/src/content/pageBridgeClient.js) 在取消标志已置位时拒绝新发起的可取消请求；[pageRpcContract.js](../../extension/src/shared/pageRpcContract.js) 将 apply 与 receipt 读取均标为可取消。client 的 `cancelActiveRequests` 可拒绝活动请求，但本基线 `cancelActiveRun` 未调用该入口。
- 后果范围：[writebackOrchestrator.js](../../extension/src/content/writebackOrchestrator.js) 在 broker 返回后才 `appendApplyResult/recordUndoFromApply`。写入已发生而回复超时后取消，可能阻止该结果进入 checkpoint；跨批次抛出还需核查先前累积结果。不能从 router 返回能力推导所有取消都具有完整持久撤销材料。
- 目标契约：停止新增写入的同时，已发生的修改应保留可核对的事实与恢复材料；无法确认的部分明确标为待核查。
- 最近定义：[writebackCancellationFlow.test.js](../../test/writebackCancellationFlow.test.js) 直接调用 router；[writebackReceiptRecovery.test.js](../../test/writebackReceiptRecovery.test.js) 覆盖回执恢复的其他分支。它们不能替代“真实 Page RPC 取消 → broker → content checkpoint”的组合测试。
- 剩余动作：后续独立修复任务先构造已写入、回复丢失、取消及跨批次的可控用例，核查 intent、receipt、checkpoint 三者；本轮只收紧文档表述。

### G-06：混合 Undo 中间持久化失败可绕过镜像失效

- 静态路径：[contentRuntime.js](../../extension/src/content/contentRuntime.js) 的 `undoRunTrackedChanges` 在文本恢复后、删除新建文件前等待 `applyTrackedChangeSettlement`；调用位置早于 `invalidateMirrorAfterUndo`。
- [scopedPersistencePanelState.js](../../extension/src/content/scopedPersistencePanelState.js) 在中间保存失败时恢复材料、标记 `needs_review` 后继续抛错。控制流可直接进入 finally，新建文件保留，但镜像失效尚未发生。
- 目标契约：页面已有变更时，恢复材料与镜像基线分别得到可靠处理；保留 Undo checkpoint 不能代替镜像失效证据。
- 最近定义：[undoMirrorInvalidation.test.js](../../test/undoMirrorInvalidation.test.js) 的相关 harness 将 settlement 替换为成功 stub，不能证明中间持久化失败路径。
- 剩余动作：单独构造文本已恢复、保存失败的故障用例，检查镜像健康与下一次运行的读取路径。本轮只确认控制流可能跳过失效，未证明实际复用了旧镜像。

### G-07：队列保存调用可能在事务前静默跳过

- 静态路径：[contentRuntime.js](../../extension/src/content/contentRuntime.js) 的 `saveState` 在项目缺失或运行与当前项目分离时，仅对 `reviewRunIds` 抛错，其他调用可能直接返回。
- [runQueueScheduler.js](../../extension/src/content/runQueueScheduler.js) 在 `scheduleOne/markExecuting` 等待保存 Promise；正常返回不能在上述路径证明队列 mutation 已持久提交。
- 目标契约：队列所有权推进以明确提交证据为准；入口不适用时向调度器返回可区分结果。
- 最近定义：[runQueueSchedulerDurability.test.js](../../test/runQueueSchedulerDurability.test.js)、[runQueueSchedulerArchitecture.test.js](../../test/runQueueSchedulerArchitecture.test.js)；现有覆盖不能直接推广至真实 runtime 的所有前置守卫。
- 剩余动作：核对导航/会话变化与队列提升的可达时序，并补真实保存入口的测试。本轮未复现任务丢失或重复执行。

### 其他领域的静态边界索引

以下条目在领域页保存具体源码与验证限定，避免复制多份容易失效的保证。它们包含设计范围与待核实风险，不能全部当作已复现缺陷。

| 范围 | 已确认的限定 | 后续核对入口 |
| --- | --- | --- |
| 共享历史断连 | 已接纳事务可以完成；meta-write 的独立锁检查未读取 disconnected | [运行状态与恢复](run-state-and-recovery.md) 的锁与版本部分 |
| Native 取消 | 浏览器 sent 回执不包含 Native lockReleased；成功路径退出、断连停止和恢复屏障各有范围 | [Native 执行](native-execution.md) |
| 屏障与流边界 | 数组元素校验、已排队迟到事件和内层流缓冲不能由外围守卫推定安全 | [Native 执行](native-execution.md) |
| Provider 配置 | 协议桥消费字段存在差异；按键名筛查不覆盖允许字段中的所有秘密 | [Provider 与协议](providers-and-protocols.md) |
| 附件异步 | 清空 tray 未必终止已开始的文件读取；迟到结果的真实交互影响待验证 | [界面与加载](ui-and-loading.md) |
| 子代理 | 波次净哈希无法证明 ownedUnion 内的真实作者；drained 与 OS 退出分别判断 | [并行子代理](parallel-subagents.md) |
| 风格与技能 | 资产生成、运行捕获、技能安装完成各有独立证明范围 | [写作风格与技能](writing-style-and-skills.md) |
| 安装更新 | UI idle、当前 Native 计数、版本健康与完整业务安全分别取证 | [安装与更新](installation-and-updates.md) |

## 5. 后续覆盖顺序

| 顺序 | 专题 | 优先补足的问题 |
|---|---|---|
| 1 | Auto 编辑、保存、撤销 | 证据如何从操作回执走到保存确认与撤销恢复 |
| 2 | 运行、队列与共享历史 | 谁拥有活跃运行，跨页观察与 owner 丢失如何区分 |
| 3 | Provider 与隐私 | 提交快照、revision、凭据、续传和日志的边界 |
| 4 | 安装、更新与发布 | 五层身份、事务恢复、重装边界、公开资产证据 |
| 5 | Writing Style、子代理、附件及呈现 | 配额、所有权、取消、失败和实验功能限制 |

各主要领域已有对应说明，经[功能地图](feature-map.md)进入专题。此顺序继续用于选择后续深度验证，具体静态审阅结果见[对抗式审阅记录](red-team-review.md)。

## 6. 维护与关闭规则

1. 每次行为改动同时检查功能地图、相应调用链和本页；记录核验提交、源码符号、最近测试及实际执行情况。
2. 数值优先从 owner 常量读取；页面应说明单位与适用范围，避免把默认值推广为不可变上限。
3. 文档漂移关闭需要更新使用中的指南并复核源码；产品缺口关闭需要对应实现及有意义的回归证据。
4. “测试存在”“测试已通过”“浏览器已验收”“公开发布已核验”分别陈述，并附各自基线。
5. 新的未提交候选和历史现场记录保持独立；发布或合并后更新状态，保留必要的决策原因。
6. 无法由本轮证据确认的结论标为待核验；未运行测试或 CUA 的文档维护不能升级为全链路验收声明。
