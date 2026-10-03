# 架构指南定位验收记录

日期：2026-10-03。产品源码基线：`main@2073ae74747431aab8d529803d4e9f8197262388`，版本 `2.5.0`。
本记录验证首版指南能否帮助新 agent 定位功能与修改联动。它不构成产品测试、浏览器验收或发布就绪证据。

## 方法与范围

两位未参与编写的独立 agent 从新上下文开始，各处理两个假设维护场景。任务只提供仓库、症状和只读限制，没有提供预期实现答案。

阅读路径固定为 [AGENTS](../../AGENTS.md) → [指南入口](README.md) → [功能索引](feature-map.md) → 必要领域页。
每位 agent 先记录仅凭指南得到的候选定位，再沿链接及符号静态核对源码和测试定义；没有读取旧 `docs/agents/` 或私有交接，也没有运行产品测试或浏览器。

评价标准为：能定位真实入口、权威状态及持久化；能列出必要联动和约束；能选出最近验证入口；能区分已有证据与未验证场景。
两位 agent 初轮均评价“通过但有改进”。修订指南后分别复核相关增补，最终四个场景的定位验收均通过。

## 四个场景的定位结果

| 场景 | 从指南得到并由源码确认的路线 | 最终评价与限定 |
| --- | --- | --- |
| A 关闭 Track 的混合 Undo 后刷新又显示可撤销 | `undoRun` → `undoRunTrackedChanges` 或直接逆操作 → lifecycle 分类 → checkpoint/settlement → 持久化 → 重载投影 | 通过。明确普通混合记录仍可能走延迟保存；按钮文案不能证明页面修改或持久化结果。 |
| B 创建请求超时但文件可能已创建 | broker 查询原 receipt → page journal → creator → 恢复 intent / 只读 save check → server 内容证据 | 通过。发现并登记显式创建重试参数缺口；原请求恢复与显式新派发分别描述。 |
| C 排队后修改 Provider 或模型配置 | 提交快照 → `resolveForExecution` → `claimNext/scheduleOne` → Native Provider 二次校验 | 通过。原引用有效时保持原配置；修订不符或删除时可以暂停/拒绝，快照不保存完整旧配置或凭据。 |
| D 另一站点或标签页刷新时误把活跃运行标为中断 | shared history → run-owner port → `interruptOwnerlessRun` → hydration / recoverJournals → 被动视图同步 | 通过。共享模式下等待 ownerLost；Native 终态不能单独授权旁观页结算。 |

这四个结果只评价所选场景的导航能力。其他领域目前有源码索引，其完整调用链和故障恢复仍待扩展。

## 初验反馈与已完成的修订

### 普通 Undo 的生命周期与持久化

[Auto 修改与撤销](auto-edit-undo.md) 增加 `runTimelineView.isTrackedChangeLifecycleRun` 的分类依据。
Track-off 且无 tracked 状态或 refs 的混合记录，即使调用名为 `undoRunTrackedChanges` 的函数，仍可走 `applyLegacyUndoSettlement → saveStateSoon`。
审阅生命周期路径则进入 `applyTrackedChangeSettlement → applyReviewTransition` 的持久化确认。
该区分避免维护者根据函数名或按钮样式误选修复层。

相关源码为 [contentRuntime](../../extension/src/content/contentRuntime.js)、[runTimelineView](../../extension/src/content/runTimelineView.js)、[scopedPersistencePanelState](../../extension/src/content/scopedPersistencePanelState.js)。
测试导航同时说明 [ordinaryUndoRouting](../../test/ordinaryUndoRouting.test.js) 的 `ordinary Undo after reload` 先重载再 Undo，不能独自证明“Undo 完成后立即刷新”。

### 回执查询与显式创建重试

指南先前把 creator 对同内容文件的幂等支持概括为重试行为，初验沿真实调用链发现 `retryCreates` 在 page journal 重建参数时未转发。
现已把该保证限定为 creator 局部能力，并登记[证据与差异 G-04](evidence-and-drift.md#g-04显式创建重试参数在执行回执层未继续传递)。
原 `requestId` receipt 查询及重复请求取回原结果具有独立机制；此缺口不能推导它们失效，也不能证明发生过重复创建。

源码依据为 [assetTransferBroker](../../extension/src/content/assetTransferBroker.js)、[writebackReceiptJournal](../../extension/src/page/writebackReceiptJournal.js)、[writebackRouter](../../extension/src/page/writebackRouter.js) 和 [textFileCreator](../../extension/src/page/textFileCreator.js)。
测试导航分开 [原 receipt 恢复](../../test/writebackReceiptRecovery.test.js)、[creator 局部幂等](../../test/textFileCreator.test.js) 与[重试意图](../../test/writebackEditRetry.test.js)，并保留跨生产 journal 的专项验证缺口。本轮未修复产品。

### Provider 的执行校验入口

[运行状态与恢复](run-state-and-recovery.md) 与功能索引补充浏览器快照解析、队列暂停及 Native `resolveRunProvider/resolveRunProviderForRun`。
模型目录发现 `resolveProviderModels` 与实际执行校验分别定位。
当原 Provider 仍以同一 revision 存在时，排队任务保留原模型选择；Provider 被修订或删除后，旧任务可以被拒绝。

关键源码为 [RunExecutionSnapshot](../../extension/src/shared/runExecutionSnapshot.js)、[runQueueScheduler](../../extension/src/content/runQueueScheduler.js)、[providerRuntime](../../native-host/src/providerRuntime.js)。
最近定义包括 [runExecutionSnapshot](../../test/runExecutionSnapshot.test.js)、[projectProviderSelection](../../test/projectProviderSelection.test.js)、[runQueueSchedulerArchitecture](../../test/runQueueSchedulerArchitecture.test.js) 及 [providerSessionBinding](../../test/providerSessionBinding.test.js)。

### 共享恢复的确认与耐久性

运行恢复页增加 [background.js](../../extension/src/background.js) 的 run-owner port 和 `interruptOwnerlessRun` 定位。
“保存后 acknowledge journal”已限定为等待 `saveState()` 返回的调用顺序；普通保存的错误捕获、紧凑 fallback 或身份拒绝仍影响耐久性，不能表述成完整历史已成功持久化。

[crossTabRuntimeRegression](../../test/crossTabRuntimeRegression.test.js) 使用模拟 shared history 的运行环境；它与 [activeTurnControl](../../test/activeTurnControl.test.js) 提供相关验证入口。
静态阅读和这些测试定义不能证明真实 www/cn 双页面、worker 重启、port 重连或保存失败后的 journal 清理均已通过。

## 机械检查与后续使用

文档交付检查覆盖仓库相对链接、源码与测试目标、链接中的行号/锚点、明确标注的入口符号、测试选择器和 Git 忽略边界。
最终机械检查通过：8 份文件（含 AGENTS）、465 个相对链接、24 个可从链接标签提取的源码符号；88 个测试文件被运行器成功列出。其余关键分支由上述独立定位与源码复核检查。
未跟踪的 npm 等待候选仅以文字路径记录，新克隆不必拥有它；没有必需链接指向私有交接或被忽略的旧指南。
只有明确列入白名单的新指南及 AGENTS 进入此次版本管理范围，其他本地资料保留原有忽略范围。

测试选择器通过 `node scripts/run-tests.mjs --list <测试文件...>` 检查，只列出文件，不执行测试。文档检查和定位验收不能计入产品测试通过数。

后续新增领域页可复用此流程：选择真实维护症状，先只凭指南形成候选，再核对实现；记录误导点、修订和定点复查结果。
指南在代码变动后仍需同步维护，本记录只证明该基线下四个场景的定位能力。
