# Native 消息、执行与进程寿命

产品源码基线：`2073ae74747431aab8d529803d4e9f8197262388`；文档首版基线：`86d5a17`；核对日期：2026-10-03。
本页基于源码与既有测试定义，未运行产品测试、构建、浏览器操作或真实进程故障演练。
`Current behavior` 表示可定位的源码事实；`Target contract` 表示维护目标；`Known gap / 未验证` 表示具体限制或尚缺的运行证据。
下文未单独标注的实现描述均属于 `Current behavior`，不能由此推定全部平台已经验收。
浏览器运行状态见[运行与恢复](run-state-and-recovery.md)，页面写入见[Auto 修改与撤销](auto-edit-undo.md)，模型适配见 [Provider 与协议](providers-and-protocols.md)。

## 1. 适用范围与 owner

Native Host 是浏览器启动的本机 Node 进程，负责消息接入、镜像协调和 agent 执行；Codex app-server 是它启动的另一个进程。
两个进程之间还有独立的 RPC。RPC 可类比有编号的工单：编号关联请求与回应，工单回执、工作结束、文件保存各有自己的证据。

| 边界 | 权威入口 / 符号 | 消费者或寿命 |
| --- | --- | --- |
| Content → 扩展后台 | [nativeChannel.js](../../extension/src/content/nativeChannel.js) 的 `create/sendNativeTracked` | `contentRuntime.sendTrackedCodexRun` 绑定插件运行及 requestId |
| 后台 → Native Host | [background.js](../../extension/src/background.js) 的 `sendNativeRequest/ensurePort` | `pending` 路由回应；运行 journal 保存有限恢复投影 |
| Native 字节入口 | [index.js](../../native-host/src/index.js) 的 `handleDecodedMessage/writeResponse` | 同一 stdio 通道接受多个异步请求 |
| 传输信封 | [nativeTransportEnvelope.js](../../native-host/src/nativeTransportEnvelope.js) | 汇聚帧编码、方法配额、结果预算及超限兜底 |
| 方法与运行控制 | [taskRunnerRuntime.js](../../native-host/src/taskRunnerRuntime.js) 的 `handleRequest/handleCodexRun` | 锁、controller、活动 turn 控制；[taskRunner.js](../../native-host/src/taskRunner.js) 仅转发 exports |
| 工作区到 agent 结果 | [codexSessionRunner.js](../../native-host/src/codexSessionRunner.js) 的 `runCodexSession` | 快照/镜像、提示词、worker 收束、差异收集 |
| app-server RPC 与终止 | 同文件 `runCodexAppServerProcess`；[codexSessionTiming.js](../../native-host/src/codexSessionTiming.js) | `pending` 为这一子进程自己的 RPC 表，与后台表分开 |
| 退出未确认的隔离 | [processStopBarrier.js](../../native-host/src/processStopBarrier.js) 的 `record/isBlocked` | 内存记录及项目镜像旁的持久屏障 |

## 2. 两层 RPC 的调用链

```mermaid
sequenceDiagram
    participant C as Content
    participant B as Background
    participant N as Native Host
    participant A as Codex app-server
    C->>B: native-request {id, method: codex.run, params}
    B->>N: Native Messaging 帧
    N->>N: 配额、停止屏障、项目锁、Provider、快照
    N->>A: spawn app-server --listen stdio://
    N->>A: initialize → initialized
    N->>A: skills 隔离 → thread/start 或 thread/resume
    N->>A: turn/start
    A-->>N: turn/started、item 事件、服务端请求
    N-->>B: {id, ok:true, event}
    B-->>C: native-event + journalSeq
    A-->>N: 匹配活动 turn 的 turn/completed
    N->>N: 结束 runner、收束 worker、收集并限制差异
    N-->>B: {id, ok:true, result} 或 {id, ok:false, error}
    B-->>C: 请求 Promise 结算
    C->>C: 后续写回、保存检查、镜像确认、可选编译
```

外层使用 [nativeMessaging.js](../../native-host/src/nativeMessaging.js) 的四字节小端长度前缀加 UTF-8 JSON；内层使用逐行 JSON。
外层 `requestId` 关联插件的一次 Native 调用，内层数字 `id` 关联一次 app-server RPC；`threadId/turnId` 标识模型线程与轮次。
`index.handleDecodedMessage` 把 `update.*` 交给 `updateManager`，其余交给 task runner；消息分派没有全局串行等待。
因此 `codex.run` 未结束时仍能接收 `codex.steer/cancel`，项目级互斥另由 task runner 控制。

### 请求、流与终态

流事件形状为 `{id, ok:true, event}`；`ok:true` 在此表示一次事件传递，不表示整轮成功。
终态成功形状为 `{id, ok:true, result}`；失败形状为 `{id, ok:false, error:{code,message,...}}`。
后台按 `message.event` 区分事件和终态；事件先交给 journal 写队列，再转发；终态移除 `pending` 并结算调用方 Promise。
Native 的 `emitCodexEvent` 创建 `type/title/status/detail/timestamp`；单调恢复序号由后台 `appendRunJournalEvent` 添加。
`requestId` 提供关联能力；源码中的 `pending.set` 与 Native 运行注册不能作为重复执行去重协议。
`Target contract`：新增事件须声明所属运行、消费者、最大载荷和错误语义；“只执行一次”需要额外幂等与持久证据。

## 3. codex.run 的准入与结果收集

`handleRequest` 先调用信封的 `getRequestQuotaViolation`；超额返回 `native_request_quota_exceeded`，再进入具体方法。
`handleCodexRun` 检查 Codex 可发现性，派发运行时身份事件，获取项目锁，登记 controller，再解析执行 Provider。
Provider revision、地址披露、模型和 Auto 协议协商由 `providerRuntime.resolveRunProviderForRun` 决定，详见 [Provider 与协议](providers-and-protocols.md)。
完整快照或聚焦部分快照须通过 `hasRunnableProjectSnapshotEvidence`；复用镜像另查 freshness，OT 聚焦复用另查覆盖并拒绝 overlays。
技能安装和风格生成有独立入口例外，不能把普通项目快照前置条件套到所有运行。

`runCodexSession` 的普通项目顺序如下：

1. 同步或取得镜像，准备选区范围、项目技能、附件与写作风格上下文。
2. 根据模式与技能类型生成 sandbox/approval 参数，按官方技能开关创建 subagent broker。
3. 执行父任务；父任务异常时停止 broker，正常返回时先 drain 剩余 worker。
4. 收集镜像差异，依次应用选区限制、focus 限制和 subagent 阻断路径。
5. 存在改动或不支持项时将镜像标 dirty；Ask 返回空 `syncChanges/unsupportedChanges`，保留被忽略数量事件。
6. Auto 准备二进制资产、文本 diff/patch，再通过 `reduceTaskResult` 限制响应预算。

普通 Ask 的 `buildCodexSettings` 为 `read-only`；Auto 为 `workspace-write`；技能安装有单独 `workspace-write` 配置。
`handleServerRequest` 处理收到的文件/命令审批请求，其他未知服务端请求默认 decline；相关 allowlist 只约束这一审批入口。
`Known gap / 未验证`：仅凭 allowlist 的存在不能证明所有工具执行都会触发该审批回调；真实 Codex sandbox 行为须另验。
运行结果仍有工作区中的本地改动，允许写回集合由过滤和预算决定；返回文本“完成”不能绕过这些集合。

| 完成节点 | 已获得的证据 | 仍可能继续的工作 |
| --- | --- | --- |
| 匹配的 `turn/completed` | app-server 发出该轮终态通知 | 子进程清理、worker 收束、镜像差异与响应预算 |
| `runCodexSession` resolve | 本次运行结果已收集并经过返回集合过滤 | 外层编码传输；正常路径进程退出仍须单独判断 |
| Native 请求 Promise 结算 | 后台收到终态响应或连接错误 | Content 写回、保存检查、镜像确认和可选编译 |
| 插件 run settlement | 页面与后处理证据已归类 | 结果可含部分失败、保存未知或后续恢复动作 |

这些节点的 owner 不同；改变“完成”文案或下一项队列启动条件时，应同时阅读 [WritebackSettlement](../../extension/src/shared/writebackSettlement.js)。

## 4. thread、turn、steer 与活动事件

每次 `runCodexAppServerSession` 准备 Provider launch，创建 app-server 进程，并在 finally 关闭本次 Provider 桥。
传入 `threadId` 时执行 `thread/resume`，失败返回 `thread_resume_failed`；该路径不自动新建线程冒充续接成功。
未传入时调用 `thread/start`，拿到线程后调用 `turn/start`；不支持 reasoning summary 的特定错误只重试该请求并移除 summary。
该兼容重试与外层整个 `codex.run` 的重放不同，修改时必须分别评估副作用。

`publishActiveTurnControl` 取得 thread 与 turn 后仅发布一次冻结 control，发出 `codex.turn.bound`；其 `steer` 调用 `turn/steer`。
`handleCodexSteer` 用 requestId 优先、projectKey 兜底查找活动 entry，控制尚未就绪报 `codex_turn_not_ready`。
提供的 threadId 或 expectedTurnId 不匹配时报 `codex_turn_mismatch`；空文本及超过 12,000 字符的文本分别拒绝。
这里的预期身份字段按“传入才比较”实现，不能声称 Native 拒绝全部缺失 thread/turn 的 steer 请求。
`Target contract`：调用方应传入绑定时捕获的预期 turn，避免迟到指导进入另一轮；浏览器绑定见 [activeTurnControl.js](../../extension/src/content/activeTurnControl.js)。

`createRunEventScope` 位于 [readProgressGuard.js](../../native-host/src/readProgressGuard.js)，按 thread/turn 和 item 已知归属过滤异线程事件。
`accepts` 对无身份且无已知 owner 的兼容事件允许通过；`owns` 对进度守卫要求更强证据，两者不能混用。
`subagentTelemetry` 先观察原生协作事件，再进入父任务处理；子任务消息不会自动取得父任务终态地位。
`buildFinalAssistantMessage` 优先从完成的消息项选择最终答复，commentary 与中间片段保留在流事件中。
兼容例外：成功 turn 中没有 completed 项，且所有项都没有显式 phase 时，会选择最后一个非空 delta-only 项；带 phase 的未完成项不进入该回退。定义见同文件 `buildFinalAssistantMessage` 及 `codexSessionRunner.test.js` 的 legacy delta-only 场景。
`Known gap / 未验证`：匹配 turn 的 `turn/completed` 直接进入 `succeed`；该入口没有以 `turn.status === completed` 单独拒绝其他终态。
该 status 影响最终文本选择，但 runner 的 resolve 不能作为所有中断/失败协议组合均已准确投影的证明。

线程分叉走独立 [codexThreadFork.js](../../native-host/src/codexThreadFork.js) 的 `forkCodexThread`，执行 `initialize → thread/fork`。
它有自己的 30 秒计时、pending 表和 best-effort kill；没有接入普通运行的 controller/停止屏障，不应套用普通运行取消保证。

## 5. 三种互斥、取消与退出证据

| 机制 | 当前作用 | 不能推出的保证 |
| --- | --- | --- |
| `activeProjectLocks` | `acquireProjectLock/releaseProjectLock` 用 token 防止旧 finally 释放新锁 | 同一进程的 Map 不能证明跨 Native 进程互斥 |
| `activeRunControllers/activeRunEntries/activeRunByProject` | requestId 或 projectKey 定位普通 codex.run 的取消与 steer | 登记表不包含所有本机子进程 |
| `processStopBarrier` | 退出未确认后阻止特定入口继续修改该项目 | 屏障不等于关闭操作系统中的所有相关进程 |

`resolveProjectKey` 规范化项目字符串，并有 `unknown` 兜底；它提供锁索引，不能替代账号、页面与运行身份认证。
`mirror.sync/patchFiles/confirmWriteback/invalidate` 也使用项目锁；status/scan 等查询和下述停止屏障各有独立准入范围。
`handleCodexRun` 在 finally 移除所属登记并释放 token 锁；异常停止时即使锁释放，持久屏障仍可独立阻止下次准入。

### 取消调用链与回执强度

浏览器 `contentRuntime.cancelActiveRun` 并发发送 Native `codex.cancel` 与 Page `cancelActiveWrite`，同时 abort 本地运行 controller。
Page 信号打断剩余写操作，Native 信号面向 agent；已经完成的页面写入不会由取消自动回滚。
后台对 `codex.cancel` 使用专门的 `sendNativeCancel`，`postMessage` 后立即返回 `{sent:true,id}`，未等待 Native 的取消响应。
Native `handleCodexCancel` 命中 controller 后调用 abort，并返回 `{cancelled:true}`；此时停止过程仍可继续。
由此可写为 \(sent \not\Rightarrow cancelled \not\Rightarrow exited\)：各箭头左侧证据不足以推出右侧事实。

无活动 controller 时，`force:true` 仅在项目未被 stop barrier 阻断、且内存锁存在时删除锁；它不执行额外 OS kill。
`Known gap`：`forceCancelStuckTaskForCurrentProject` 读取 `cancelled/lockReleased` 来生成文案，但正常后台取消通道只返回 `sent`。
因此该按钮的文字与调用成功均不足以证明 Native 已释放锁，需核对原运行终态、后续准入及实际进程证据。

### 失败/取消的有界停止

`runCodexAppServerProcess.fail` 标记 stopping、清理观察器和计时器、拒绝未完成 RPC，然后调用 `stopCodexAppServer`。
POSIX 子进程以 detached 启动，停止时先尝试 `turn/interrupt`，再向所属进程组发 SIGTERM，必要时 SIGKILL。
当前默认等待由函数参数定义：interrupt 1,500 ms、terminate 500 ms、force 1,500 ms；各阶段预算不能直接推出 UI 取消总耗时。
POSIX 确认停止要求已观察子进程退出，且进程组探测得到 `ESRCH`；单纯 `child.killed` 或信号发送成功不满足条件。
Windows 使用 `taskkill /pid <owned-pid> /t /f`，随后检查 child 退出状态；实现没有 POSIX 同类的剩余进程组探测。
无法确认时抛出 `codex_process_stop_unconfirmed`，携带 PID、group 与运行时 `isStopped`；runner 将它传给 `onStopUnconfirmed`。

`processStopBarrier.record` 原子写入镜像旁 `.codex-stop-barrier.json`；内存保留 `isStopped` 回调，持久数据去掉函数。
重启后仅同平台、有效 PID、标记为 process group 的记录可用 `kill(-pid,0)` 探测；未知记录及 Windows 恢复记录保持隔离。
文件解析失败、顶层非数组或超额数据按未知记录处理；数组元素结构尚未完整校验。合法 JSON `[null]` 会在 `stopped` 解引用时抛异常，不能声称所有损坏数据都能转为 unknown 隔离记录；此为静态恢复缺口，未进行真实文件故障验证。
写盘失败仅附加错误信息，不能承诺重启后一定还保留屏障。
当前屏障准入位于 `handleRequest`，只覆盖 `codex.run/mirror.sync/mirror.patchFiles/mirror.confirmWriteback`。
直接调用更底层 workspace 函数、其他方法、线程分叉及外部 agent 路径不能自动继承这项检查。

`Known gap / 未验证`：正常 `succeed` 清理后调用 `child.kill('SIGTERM')` 即 resolve，没有等待 `stopCodexAppServer` 的退出证据。
因此“失败/取消有停止确认路径”和“每次正常完成都已确认整棵进程树退出”必须分别陈述。

## 6. 断连、计时与允许重试的范围

`index.handleNativeDisconnect` 对 stdin end/close/error、预期 stdout 断连只处理一次，禁止继续写 stdout。
它调用 `abortAllActiveOperations` 中止已登记普通运行，并安排 1,500 ms 后退出；此过程没有 await 全部停止与屏障写盘。
该集合不包含独立的 Provider test、线程分叉或 `task.run` 外部 agent，不能把函数名推广为所有 native 操作的统一取消。
`Known gap / 未验证`：真实断连与分阶段停止预算交错时，进程退出、子树残留及屏障落盘的组合仍需故障演练。

app-server 的绝对 timeout 由 `CODEX_OVERLEAF_CODEX_TIMEOUT_MS` 可选开启，默认不设；idle watchdog 默认 600,000 ms。
收到 stdout 或发出 RPC 会重置 idle；broker 有活动 worker 时会继续重置，worker 自有时间预算另行约束。
重复读取守卫由 `readProgressGuard` 先 steer，再在继续无进展时触发相同 fail 停止路径；活跃输出不能自动证明任务有进展。
Provider HTTP 空闲/总预算属于另一层，见 [Provider 与协议](providers-and-protocols.md)，不能与 agent watchdog 相加后宣称统一超时。

后台 `getNativeRetryClass/canRetryNativeRequest` 的当前分类如下；重连仅允许一次，收到终态后不再重试。

| 方法 | 分类与动作 |
| --- | --- |
| `bridge.ping/mirror.status/mirror.scanSensitive` | `safe_read_retry`，失败端口上的请求可重连一次 |
| `mirror.sync/mirror.patchFiles/mirror.confirmWriteback/mirror.invalidate` | `safe_sync_retry`，依赖各方法收敛、基线和 stale 条件 |
| `codex.cancel` | `best_effort`，走单独发送路径 |
| `codex.run/task.run/task.confirm` 与未显式列举方法 | `no_silent_retry`，断连以 `native_execution_interrupted` 结束 |

`codex.models` 和 Provider 查询也落入默认禁止重放分类；“看起来只读”不足以推断当前已经注册自动重试。
后台按 nativePort 筛选受断连影响的 pending，并过滤旧端口新进入 `onMessage` 的消息；无 ID 错误仅单 pending 时可归属，多 pending 时按连接失败处理。
已在断连前进入 journal 写入等待队列的事件，写入完成后仍可能转发，回调未再次核对端口/pending/terminal。它是否被 UI 的运行身份和终态守卫丢弃还需核对消费者，不能宣称端口过滤消除了所有迟到事件。
运行 journal 支持有限事件恢复；`ActiveTurnControl.recoverJournals` 不把 Native terminal 直接当作页面写回完成，详见[运行与恢复](run-state-and-recovery.md)。
`Target contract`：新增方法默认禁止重放，只有明确副作用、幂等条件与失败测试后再加入安全分类。

## 7. 配额与超限后的降级

| 层 | 权威符号 | 当前意义 |
| --- | --- | --- |
| Node 入站帧/缓冲 | [nativeMessaging.js](../../native-host/src/nativeMessaging.js) 的 `MAX_NATIVE_INPUT_MESSAGE_BYTES/MAX_NATIVE_BUFFER_BYTES` | 128 MiB / 160 MiB；仅描述本机 decoder 限制 |
| 出站帧 | 同文件 `MAX_NATIVE_OUTPUT_MESSAGE_BYTES` | 1 MiB，按 JSON 的 UTF-8 字节计算 |
| 方法数据 | [nativeQuotas.js](../../native-host/src/nativeQuotas.js) 的 `NATIVE_REQUEST_QUOTAS/validateNativeRequestQuotas` | 项目、附件、操作、编译日志和技能分别校验；未列方法不自动获得字段级检查 |
| 成功结果 | [nativeResponseBudget.js](../../native-host/src/nativeResponseBudget.js) 的 `NATIVE_OK_RESPONSE_BUDGET_BYTES` | 给外层信封预留 64 KiB，提前缩减可写回集合 |

Base64 字节数约为 \(4\lceil n/3\rceil\)，外面还有 JSON 与 diff/patch；附件原始大小合格不代表整帧一定合格。
上述出站降级也不能证明内层 app-server 的未换行 stdout、stderr 或消息累积始终有界；`runCodexAppServerProcess` 的缓冲与 `buildFinalAssistantMessage` 输入需单独审查和测试。
`reduceTaskResult` 优先把最大内联文本改动移入 `unsupportedChanges`，再处理内联二进制，随后缩减 assistantMessage，最后可退化成整体不支持提示。
对应 reason 包括 `text_payload_exceeds_native_message_limit` 与 `native_response_payload_exceeds_native_message_limit`，不能把这些项显示为已写回。
二进制常规分块入口为 [nativeAssetTransfer.js](../../native-host/src/nativeAssetTransfer.js)；分块协议与内联兜底应分别维护。
最后 `encodeOutputFrame` 若仍超限，事件改为有界 `native_event_truncated` detail，终态改为 `native_response_too_large` 错误，并限制回传 ID 长度。
`Known gap / 未验证`：字段配额、Node decoder、浏览器平台上限、生成结果预算是不同约束；当前数值不能证明所有合法组合都可传输。

日志由 [debugLog.js](../../native-host/src/debugLog.js) 的 `sanitize` 截断字段、压缩部分 content/files；这不构成通用凭据识别器。
`index` 的摘要与运行错误路径还会记录 error message/stack；`Target contract` 禁止敏感凭据进入日志，但各新异常路径仍须单独审阅。

## 8. 修改联动与最近测试

| 改动意图 | 必查联动 | 既有测试定义 |
| --- | --- | --- |
| 新 Native 方法/请求身份 | owner、index 路由、compatibility、后台重试分类、quota、content consumer | [taskRunner.test.js](../../test/taskRunner.test.js)、[nativeRequestIdentity.test.js](../../test/nativeRequestIdentity.test.js) |
| 流事件或结果形状 | producer、信封、background journal、content reducer/时间线 | [nativeTransportEnvelope.test.js](../../test/nativeTransportEnvelope.test.js)、[nativeTransportEnvelopeFallback.test.js](../../test/nativeTransportEnvelopeFallback.test.js)、[streamEvents.test.js](../../test/streamEvents.test.js) |
| 进程取消/无进展 | runtime controller、runner fail、timing、stop barrier、页面取消和状态投影 | [readProgressGuard.test.js](../../test/readProgressGuard.test.js)、[nativeDispatchCancellation.test.js](../../test/nativeDispatchCancellation.test.js)、[runCancellationLifecycle.test.js](../../test/runCancellationLifecycle.test.js) |
| 断连/重连 | background pending/port、Native disconnect、owner/journal 恢复 | [backgroundNativeError.test.js](../../test/backgroundNativeError.test.js)、[activeTurnControl.test.js](../../test/activeTurnControl.test.js) |
| thread/turn/最终回答 | start/resume 参数、事件 scope、steer 绑定、assistant item 完成规则 | [codexSessionRunner.test.js](../../test/codexSessionRunner.test.js)、[readProgressGuard.test.js](../../test/readProgressGuard.test.js) |
| 配额或 diff 体积 | quota、响应预算、资产分块、不支持项呈现 | [nativeQuotas.test.js](../../test/nativeQuotas.test.js)、[codexSessionRunner.test.js](../../test/codexSessionRunner.test.js)、[nativeAssetTransfer.test.js](../../test/nativeAssetTransfer.test.js) |

以下仅为后续修改时的命令导航；本轮未执行：

```sh
node scripts/run-tests.mjs --list test/readProgressGuard.test.js test/backgroundNativeError.test.js
node scripts/run-tests.mjs test/readProgressGuard.test.js test/backgroundNativeError.test.js
node scripts/run-tests.mjs test/nativeTransportEnvelope.test.js test/nativeTransportEnvelopeFallback.test.js test/nativeQuotas.test.js
```

`readProgressGuard.test.js` 已定义用户取消、POSIX 后代进程、Windows taskkill 注入、发信号不算退出等场景；测试定义不等于本轮通过。
静态检索未发现独立 `processStopBarrier` 测试或 Native 断连 1,500 ms 与完整停止流程竞速的直接覆盖；跨重启和跨平台保证仍未验证。
遗留 `task.run → runExternalAgent` 在 [taskRunnerRuntime.js](../../native-host/src/taskRunnerRuntime.js) 另走 stdout 整体 JSON/stderr 事件路径，timeout 和 kill 实现独立；修改普通 runner 时须明确是否覆盖它。

## 9. 红队定位题与验收边界

以下题目供独立 agent 只凭指南定位源码并反驳过强结论；答案须同时引用调用方和实际守卫。

1. **“取消返回 ok，项目进程已经退出，可以立即重跑。”** 应指出后台 sent 回执、Native cancelled 回执、timing 退出证据三层，并检查 force 按钮的回执投影。
2. **“正常 turn 完成也经过停止屏障，所有后代进程都结束。”** 应定位 `succeed` 与 `fail` 的不同路径，给出 SIGTERM 后立即 resolve 的实际位置。
3. **“持久屏障能拦住项目的一切写操作，重启总能自动解除。”** 应列出仅四个 `handleRequest` 方法、直接底层调用边界、未知/Windows 记录及写盘失败条件。
4. **“所有只读 RPC 可以重连重试，requestId 保证一次执行。”** 应核对显式分类、默认禁重放与缺少通用重复请求去重协议。
5. **“收到 matching turn/completed，就能把整个 UI 标为保存成功。”** 应区分协议通知 status、runner resolve、差异收集、页面写回/保存/镜像/编译及最终 settlement。

`Target contract`：新实现若增强这些保证，应补准确的端到端证据，并更新本页、功能索引与[证据登记](evidence-and-drift.md)。
当前指南只承诺可定位的实现与限制；异常终态协议组合、断连后残留子树、屏障重启恢复、真实浏览器后处理均保留独立验收需求。
