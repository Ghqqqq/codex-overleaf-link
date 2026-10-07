# 消息协议、准入与信任边界

初始参考产品版本：`2.5.0`；初始参考源码基线：`2073ae74747431aab8d529803d4e9f8197262388`。正文随当前仓库维护。
执行环境见[系统总览](system-overview.md)，修改入口见[功能索引](feature-map.md)；本页集中说明消息进入各环境前检查什么、这些检查能证明什么。

**Current behavior** 表示可沿所列 owner 核对的源码行为；**Target contract** 表示维护约束；**Known gap / 验证范围** 表示当前检查的例外或尚需集成验证的条件。
消息准入、版本兼容性、项目归属和操作结果各有证据，不能由一次握手或一个 `ok:true` 合并推定。

## 1. 两条 RPC 与本地 HTTP 接口

RPC 将方法名、参数和响应关联起来。项目中两条 RPC 的载体、身份与重放策略分别维护。

| 通道 | 生产者、消费者与目录 | 当前边界 |
| --- | --- | --- |
| Page RPC | [PageBridgeClient](../../extension/src/content/pageBridgeClient.js) → [pageBridge](../../extension/src/pageBridge.js)；[pageRpcContract](../../extension/src/shared/pageRpcContract.js) 管理方法策略 | 同文档 `window.postMessage`，跨 isolated / MAIN world；请求带桥接 token，方法可另要求项目身份 |
| Native RPC | [NativeChannel](../../extension/src/content/nativeChannel.js) → [background](../../extension/src/background.js) → [native index](../../native-host/src/index.js) | Chrome runtime 消息再经 Native Messaging；[taskRunnerRuntime](../../native-host/src/taskRunnerRuntime.js)、[providerRuntime](../../native-host/src/providerRuntime.js)、[updateManager](../../native-host/src/updateManager.js) 分别路由方法族 |
| Provider HTTP | [codexProviderLaunch](../../native-host/src/codexProviderLaunch.js) 准备本地桥，Codex 访问桥后由桥请求上游 | loopback 地址与临时 bearer token；三种协议的路由由 [providerBridgeRoutes](../../native-host/src/providerBridgeRoutes.js) 分类 |

Page 目录包含读取、文档修改、页面状态、缓存、导航和 observer 方法，目录中的分类不能代替实际 handler。
Native 没有与 Page `METHODS` 完全对应的统一方法目录；路由、兼容 gate、配额、重放与取消分别由不同 owner 决定。
Native Messaging 使用四字节小端长度前缀加 UTF-8 JSON，app-server 内层使用逐行 JSON；信封与事件语义见[Native 执行](native-execution.md)。

## 2. Page 的四种身份语义

同一个请求内的字段像“通行口令、操作名称、收件地址和单据号”，分别回答不同问题。

| 字段或概念 | 当前用途 | 不能独自证明的事实 |
| --- | --- | --- |
| 请求 `capability` token | 当前 Page Bridge 实例接受的口令，由 client 生成并在初始化后复用 | 请求一定来自扩展 isolated world；某个方法获得独立权限 |
| 目录 `capability` 名称 | `document.write`、`snapshot.read` 等方法能力描述，随 capability report 提供定位信息 | 按调用者或 token 实施逐方法授权 |
| `runProjectId` | `writeGuard` 比较捕获项目与当前页面项目；是否要求由目录策略决定 | 账号、会话、运行、内容基线和保存状态全部匹配 |
| RPC `id` / `writebackRequestId` | client 关联响应；文本写回还用请求身份定位页面回执 | 通用重复请求去重、来源认证或页面已保存 |

client 的 `createCapability` 使用随机 UUID，缺少该接口时使用随机字节；token 保存在 client 闭包中。
[pageBridgeCapability.create](../../extension/src/page/pageBridgeCapability.js) 接受首个格式有效的初始化 token，同 token 再初始化返回已初始化，冲突 token 被拒绝。
`pageBridgeMessageHandler` 检查 `event.source === window`、同源及消息 `source` 标签，再执行初始化或 token 相等检查。
token 检查通过后，`dispatch` 查目录和 handler，并按 `projectIdentity` 策略调用 [writeGuard.runWriteGuard](../../extension/src/page/writeGuard.js)。
项目身份的 optional 例外和页面项目读取回退见[Auto 修改与撤销](auto-edit-undo.md)，不能将某个写操作的守卫推广到全部方法。

### 同文档 MAIN world 的信任前提

**Current behavior：**client 在每条 `window.postMessage` 请求中携带 token；同文档 MAIN 脚本能够监听这条消息通道。
Page 响应没有独立秘密：client 检查同窗、同源、消息标签、目标版本、Page revision 和请求 ID 后接受 `result`。
这些字段提供桥接实例、版本和响应关联信息；消息标签与随机请求 ID 均不能替代独立的发送者认证。

\[
\text{同窗且同源} \not\Rightarrow \text{扩展 isolated world 来源已认证}.
\]

因此当前 Page Bridge 依赖同文档 MAIN 脚本受信任的前提；token 检查可拒绝未携带正确口令的请求，无法单独隔离已经观察到该口令的同文档代码。
纯消息模拟可验证“匹配版本、revision 和 ID 的同窗响应会被 client 接受”，该性质不提供真实浏览器攻击可达性或影响范围的证据。
修改注入方式、页面脚本信任范围或消息传输时，应同时审视请求与响应两个方向，保留上述限定。

### 回执、重放与取消

<a id="shared-review-owner"></a>

**共享审阅归属。** [SharedSessionBridge](../../extension/src/shared/sharedSessionBridge.js) 与 [backgroundSharedSessions](../../extension/src/backgroundSharedSessions.js) 使用独立 `review` lock-port，并以账号、项目和 run 定位 owner；它不长期持有普通 account 存储锁。`review-owner` 查询只读状态，`review-dispatched` 在 Page 派发前耐久保存 token 专属 deadline 行并返回 ACK，`release-review` 正常结束时仅清理自己的 token。
确认前只有活跃 port 预留；可能已派发的 token 行在 owner 丢失或 worker 更替后继续隔离到截止时间。每个 token 使用独立不可变键，迟到旧 set/remove 无法覆盖或删除新 owner 的证明；存储写/删 pending 时同实例也保持 in-flight 屏障。读取或下一次取得 owner 时仅回收键、token 与 deadline 严格匹配的已过期行，异常行保持拒绝，清理失败不开放未过期租约。
既有 Page `cancelActiveWrite` 接受可选 `reviewOwnerToken`，仅失效匹配的 review context，不推进全局取消序号。token 经 runtime、Broker、Journal 和 Router 传递；文本、文件树操作在等待后及实际修改前重查归属与期限。该机制约束后续客户端派发，不能撤回已启动的服务端 HTTP 副作用。相关验证见 [undoReloadOwnership](../../test/undoReloadOwnership.test.js)、[reviewDeadline](../../test/reviewDeadline.test.js) 及[运行恢复](run-state-and-recovery.md#6-undo-的持久化与重载投影)。

`pageRpcContract.resolveDispatchPolicy` 固定 `automaticAttempts: 1`；`safe`、`idempotent` 等标签描述方法策略，client 不据此自动重发。
幂等表示重复执行应收敛到同一结果，例如开关设置；它与“请求只发送一次”属于不同性质。
文本写回回执由 [writebackReceiptJournal](../../extension/src/page/writebackReceiptJournal.js) 管理，二进制 staging、commit 和 status 由 [binaryAssetUploader](../../extension/src/page/binaryAssetUploader.js) 管理。
回执生命周期、部分结果、保存证据和恢复动作仍按具体 handler 解释，见[Auto 修改与撤销](auto-edit-undo.md)。
`content_abort` 控制 client 的派发前拒绝与活动等待取消；页面 `cancelActiveWrite` 另行推进取消序号，具体写入循环在检查点停止。`binaryUploadBegin` 同样受派发前取消检查。
`getWritebackReceipt` 与 `binaryUploadStatus` 为需要项目身份、`cancellation:none` 的只读收尾查询，取消后仍可查询原请求结果，单次 RPC 超时继续有效；文本的显式 deadline 与二进制独立轮询截止点分别维护。broker 将前批已确认结果与未派发尾部分别返回，二进制 begin 成功后的失败，或 begin 已派发且等待被取消，在 commit 未实际派发时按原 transferId 清理暂存；明确拒绝的重复 begin 保留既有 stage；相关时序、部分结果与持久化边界见写回专题。

## 3. 后台消息族的发送者准入

Chrome runtime 消息由多个 listener 消费，各自拥有准入函数。当前三站点主机为 `overleaf.com`、`www.overleaf.com`、`cn.overleaf.com`。
下表描述 listener 实际检查；Chrome 的消息投递条件、manifest 注入范围和业务层身份校验仍需分别核对。

| 消息族 | 准入 owner | 当前检查范围 |
| --- | --- | --- |
| `native-request`、run-journal list/ack、run-owner port | [background.isAllowedOverleafSender](../../extension/src/background.js) | 有 tab 时检查 `sender.tab.url` 的 HTTPS 与三站点主机；不另检查项目路径、`sender.url` 或 frame。无 tab 时要求本扩展 ID 与扩展 URL 前缀 |
| `shared-sessions-v1`、shared-session-lock port | [backgroundSharedSessions.senderOrigin](../../extension/src/backgroundSharedSessions.js) | 本扩展 ID、有 tab、`sender.url` 优先于 tab URL、HTTPS 三站点、`/project` 路径；存在 frameId 时要求为 0 |
| global-preferences read/patch | [globalPreferences.installBackground](../../extension/src/shared/globalPreferences.js) | 本扩展 ID、tab URL、HTTPS 三站点和 `/project` 路径；没有独立 frame 检查 |
| update coordinator 的 `MESSAGE_TYPES` | [backgroundUpdateCoordinator.isAllowedSender](../../extension/src/backgroundUpdateCoordinator.js) | 本扩展 ID，sender URL 优先；允许三站点项目路径或扩展的 `/bootstrap/popup.html` |
| Bootstrap update-get-state/check-now/postpone | [bootstrap/background listener](../../extension/bootstrap/background.js) | 按这三个消息类型路由，listener 未消费 sender 参数；后续更新流程另有授权和事务条件 |
| migration-save-probe | [backgroundUpdateSafety.saveProbe](../../extension/src/backgroundUpdateSafety.js) | 本扩展ID、绑定tab、顶层frame、Chrome documentId、sender URL、事务token及本轮nonce；MAIN读取前后还核对文档URL与当前Native事务 |
| migration-idle-probe | [updateSafetyReceiver](../../extension/src/content/updateSafetyReceiver.js) | 只接受本扩展后台、无sender.tab、匹配token/事务/nonce及当前URL；应答由后台再次核对目标版本与绑定文档 |

共享会话写入还检查 scope、记录归属与锁 token；这些检查不能由允许访问某个站点推导。各共享方法的锁例外见[运行状态与恢复](run-state-and-recovery.md)。 `put-compressed` 经 [SharedSessionTransfer](../../extension/src/shared/sharedSessionTransfer.js) 有界解码后沿同一整批写入事务；原始与压缩格式的字节上限、旧后台拒绝行为见[存储容量](run-state-and-recovery.md#storage-compaction)。
普通 Native listener 的报错文案提到项目页面，但 `isAllowedOverleafSender` 有 tab 分支当前只检查主机和协议。
该 helper 的条件允许 Overleaf `/learn`，也未额外拒绝“顶层 tab 为 Overleaf、sender URL 指向其他源且 frameId 非零”的字段组合。
真实扩展消息的 sender 元数据由 Chrome 提供，网页脚本不能任意指定它；函数接受一个合成对象不证明现行注入与 Chrome 投递路径能够产生该组合，实际可达性需要独立浏览器验证。

**Target contract：**调整站点、路由、frame 注入或新增消息族时，逐项决定实际 sender URL、扩展身份、项目路径及 frame 要求，并检查所有相关 listener。
`sender.tab.url` 描述顶层标签页，`sender.url` 描述消息发送文档；两者在 frame 场景中可能不同，不能直接互换。
`frameId` 限定文档层级，业务 `projectId` 限定数据归属，扩展 ID 限定扩展身份；三者分别维护。

迁移专用probe仅用于恢复扩展reload后失效的安全接收端，不能借此获得普通Native或runtime-health资格。后台按`documentId`定向注入，避免相同tab发生整页导航后向新文档投递；同一文档内的SPA切换另靠URL与MAIN文件/文档identity复核。token绑定安装的接收端，nonce绑定本轮请求，仍须匹配Native事务source/target、状态和后台执行锁；这些字段提供归属与新鲜度约束，不代表页面已经保存。保存证据、活动静默窗口和原刷新清单guard见[安装与更新](installation-and-updates.md#6-安全点的实际范围)。

## 4. Native 兼容性门控的两个位置

兼容性门控决定当前版本与协议能否处理某个方法，与发送者准入、用户操作授权分别执行。
[compatibility.js](../../extension/src/shared/compatibility.js) 定义协议范围、最低版本、必要 capabilities，以及 `compatible/update-available/incompatible` 分类和允许方法矩阵。
[taskRunnerRuntime.handleRequest](../../native-host/src/taskRunnerRuntime.js) 的 `bridge.ping` 报告 Native 版本、协议、能力和环境；基础 capabilities 取自共享常量，另宣告按功能协商的可选能力；能力宣告不能视作逐项业务实测结果。

Content 的 [NativeCompatibilityController.ensureForMethod](../../extension/src/content/nativeCompatibilityController.js) 先 ping，再用传入的 `gatedMethods` 集合决定是否阻止目标方法。
该方法接受可选的 `{assertCurrent}`：普通运行与 skill-installer 共用的 `sendTrackedCodexRun` 传入原运行句柄、AbortSignal 和账号/项目校验。controller 在 `bridge.ping` 返回后、兼容评估及 blocked 通知前执行回调，sender 在 gate 返回后再次执行，再消费通过或拒绝结果；旧运行的迟到响应不能向后继运行派发请求或追加兼容失败。Guide另将同一可选回调交给 `sendBackgroundNative(payload,{assertCurrent})`：controller在ping后和业务派发前复核原指导身份；该阶段抛出的拒绝标为 `requestDispatched:false`，供Guide保留可操作队列。其他通用调用保持各自取消语义，未统一获得这一运行身份回调。
集合定义在 [contentRuntime.NATIVE_COMPATIBILITY_GATED_METHODS](../../extension/src/content/contentRuntime.js)；只有集合内方法会附加兼容性 evidence，并执行对应派发前取消检查。
其中 `mirror.invalidate` 豁免该取消检查，用于保留 Undo 后的镜像失效处理；不能从豁免推定其他操作可在取消后继续。
后台 [getNativeCompatibilityBlock](../../extension/src/background.js) 再检查请求 evidence；它不会为普通请求重新执行独立 ping。

**字面 focus 的可选能力门。** [RunController.buildCodexRunParams](../../extension/src/content/runController.js) 为文件 chip 中已经解析为项目路径的 focus 数组设置 `focusFilesAreLiteral:true`；runtime 的首次运行与参数重建共用该生产者。只有布尔 `true` 开启字面语义。Native 的 `hasRunnableProjectSnapshotEvidence`、`validateOtFocusedWarmMirrorReuse` 与 `codexSessionRunner.filterSyncChangesForFocus` 按该标志解释 focus 数组；结构化文件、OT 状态、覆盖层及变更路径始终按字面身份匹配。Content 的 OT producer 同样显式启用字面 focus。因而名为 `@file:main.tex` 的真实文件不会被当成 `main.tex` 的提示语。

`bridge.ping` 额外宣告 `capabilities.literalProjectPaths:true`，该项不加入全局 `REQUIRED_CAPABILITIES`。后台 `getNativeCompatibilityBlock` 对 `codex.run` 增加条件：当 `focusFilesAreLiteral===true`，且 focus 数组非空或 `restrictToFocusFiles===true` 时，兼容 evidence 必须含 `native.capabilities.literalProjectPaths===true`。缺少能力时，在 Native 派发前返回 `native_update_required`、`status:native_capability_missing` 和缺失能力名，提示安装协调版本并重载扩展；同产品版本号也不能代替此能力证据。

无 focus、无范围限制的普通运行继续使用原兼容规则；旧调用者未声明字面标志时保留 focus 提示语兼容，例如 `@file:/main.tex`，不会自动获得新的字面保证。该兼容分支只解释 focus 输入，不能重新解释结构化 `file.path` 或 `change.path/to`。相关边界由 [literalFocusIdentity](../../test/literalFocusIdentity.test.js)、[otWarmMirrorContract](../../test/otWarmMirrorContract.test.js) 与 [backgroundNativeError](../../test/backgroundNativeError.test.js) 定位；新增该能力或调整字段时需同时核对生产者、后台门控和 Native 消费者。

| 范围 | 方法族及例外 |
| --- | --- |
| Content 与后台 required 集合共同覆盖 | `codex.run/steer`、`task.run`、镜像 `sync/patchFiles/confirmWriteback/invalidate/scanSensitive`、当前 `codex.providers.*` 七个方法、`codex.history.clearPlugin`、`skills.list/install/remove`、`writing-style.get/set`、`codex.thread.fork`、`asset.readChunk/release` |
| Content gate 中的额外项 | `mirror.status`、`codex.models`；后台将其列入 recoverable 集合 |
| 后台 required 集合中的额外项 | `task.confirm`；当前 Native 返回 Suggest 模式已移除 |
| 后台 recoverable 集合 | `bridge.ping`、`mirror.status`、`codex.models`、`codex.cancel`；无 evidence 不按 required 规则拦截，有 evidence 时仍应用分类规则 |

`writingStyleSettings`、`sessionForkController` 与 `assetTransferBroker` 的上述五个业务方法由runtime注入sender，Content取得不兼容结果后阻止派发；兼容请求附带evidence，后台在evidence缺失或不允许该方法时拒绝。该方法集合对齐不增加全局 `REQUIRED_CAPABILITIES`，也不改变 `bridge.ping`、取消或未列名未来方法的原政策。

**Current behavior 限定：**未进入Content集合的方法仍保持既有ping及非gated放行策略；后台无evidence时仅阻止required方法，显式evidence继续按共享分类矩阵判定。`bridge.ping`由分类规则始终放行。生产集合、controller和真实后台准入的专项见 [nativeCompatibilityBusinessMethods.test.js](../../test/nativeCompatibilityBusinessMethods.test.js)。
后台 `sanitizeNativeRequest` 在发送前剥离兼容性 evidence。Native `handleRequest` 执行配额、方法路由及各业务检查，没有再实施同一版本 gate。
托管更新的 `requestManagedInternal` 显式使用 `skipCompatibility`；更新安全点、授权、签名与事务检查见[安装与更新](installation-and-updates.md)，不能按普通业务方法解释这条内部通道。

`2.5.0 → 2.5.1`的固定层修复增加内部`update.bootstrap`接续调用。产品版本`2.5.1`、Bootstrap协议`3`与固定入口revision `3.1`属于三个不同身份：协议3保持旧updater的归档/安装兼容性，revision说明重载后执行的固定入口实现。`bootstrapRevision`不授予升级资格；[bootstrapUpdate](../../native-host/src/bootstrapUpdate.js)仍重验原release签名、journal保存的manifest/bundle摘要和大小、bound授权及transaction ID，限定真实旧源摘要和封闭Bootstrap文件列表。目标payload位于签名bundle内旧归档器已允许的`native-runtime/native-host/bootstrap-payload/`；扩展manifest权限形状、Native注册及bridge保持原边界。

`bootstrap_pending`阻止旧worker按原`awaiting_health`路径提前confirm；最终`update.confirm`同时消费相同事务的目标版本、已加载revision和目标磁盘摘要。独立watchdog的随机token/PID/心跳仅用于恢复进程归属，文件WAL仅记录待执行/已执行事实，二者均不替代原用户授权和签名。回滚先核对源字节再切回旧Native，未知来源内容、缺失恢复材料或失配事务保持失败。[bootstrapMigrationContract](../../native-host/src/bootstrapMigrationContract.js)、[bootstrapMigration](../../native-host/src/bootstrapMigration.js)和[backgroundBootstrapMigration](../../extension/src/backgroundBootstrapMigration.js)分别管理文件合同、落盘进度与浏览器接续，完整状态和恢复边界见安装专题。

**Target contract：**新增或更改 Native 方法时，同步决定两个 gate 集合、能力宣告、分类规则、evidence 传播、取消和旧版本行为。
兼容性方法矩阵与后台重试分类分别修改；“只读”不能自动推导兼容放行或断线重放。
后台重试由 `getNativeRetryClass/canRetryNativeRequest` 控制，未列方法默认 `no_silent_retry`；允许重连的方法最多重试一次，细节见[Native 执行](native-execution.md)。

## 5. Chrome Native Messaging 的扩展身份

[manifest.buildHostManifest](../../native-host/src/manifest.js) 将有效扩展 ID 转换成 `chrome-extension://<id>/`，写入 Native host manifest 的 `allowed_origins`。
这决定 Chrome 允许哪个扩展连接本地 host。注册错误可使 Native Messaging 连接失败，即使 Node 程序本身可以启动。
它不携带 Overleaf 账号、项目、会话或运行身份；连接建立后仍由后台与业务 handler 处理这些归属。
本地 host 使用 stdio 信封，直接启动本地程序也不能用来证明浏览器的 `allowed_origins` 注册正确。
扩展 ID、Direct/Managed 安装和 doctor 检查入口见[安装与更新](installation-and-updates.md)。

## 6. Provider loopback token 与通知 nonce

[prepareProviderLaunch](../../native-host/src/codexProviderLaunch.js) 为 Custom Provider 准备桥，将传给 Codex 的 URL 替换为本地地址、wire API 设为 Responses，并把 API key 字段替换为桥 token。
真实上游 API key 由桥的 upstream launch 使用；prepared launch 中的本地 token 与上游凭据是两个生命周期不同的值。
三桥实现为 [Responses](../../native-host/src/responsesPassthroughBridge.js)、[Chat](../../native-host/src/chatCompletionsBridge.js)、[Anthropic](../../native-host/src/anthropicMessagesBridge.js)。
各桥使用随机字节创建 token，监听 `127.0.0.1` 的临时端口；在路由和正文处理前验证 bearer token，等长后使用 `timingSafeEqual` 比较。
loopback 约束监听地址，token 约束请求持有的口令；二者都不能证明调用方的项目、运行或线程身份。
桥按本次 prepared 生命周期维护请求与 history，关闭时中止活动请求并清理 history；上游协议转换、续传和关闭时序见[Provider 与协议](providers-and-protocols.md)。

另有用于变化通知的 `nonce`：共享会话的 `notify` 与 [writingStyleSettings](../../extension/src/content/writingStyleSettings.js) 向扩展存储写入新通知值。
该值帮助产生可观察的变化，消费者随后重新读取状态；它没有参与上述 Page 或 Provider 认证，也没有提供通用防重放承诺。
新增字段应按实际消费者命名与说明，避免将所有随机值统称为授权 token。

## 7. 修改与验证入口

| 修改范围 | 必须联动 | 最近验证入口及范围 |
| --- | --- | --- |
| Page 方法或握手 | client、capability guard、contract、dispatcher、Page 加载清单与消费者 | [pageRpcContract](../../test/pageRpcContract.test.js)、[pageBridgeClient](../../test/pageBridgeClient.test.js)、[pageBridgeStaleGuard](../../test/pageBridgeStaleGuard.test.js)、[writebackCancellationRecovery](../../test/writebackCancellationRecovery.test.js)、[assetTransferCancellation](../../test/assetTransferCancellation.test.js)：目录、模拟消息、Page 局部守卫和取消后回执收束 |
| 后台消息准入 | 对应 listener、sender helper、manifest 注入、站点及 frame 范围 | [backgroundNativeError](../../test/backgroundNativeError.test.js)、[globalPreferences](../../test/globalPreferences.test.js)：worker VM 或存储 mock；不能代替 Chrome 投递验证 |
| Native 兼容 gate | runtime 集合、controller、后台集合、共享分类、Native ping 与调用者 | [nativeCompatibilityController](../../test/nativeCompatibilityController.test.js)、[nativeCompatibilityRunDispatch](../../test/nativeCompatibilityRunDispatch.test.js)、[nativeCompatibilityBusinessMethods](../../test/nativeCompatibilityBusinessMethods.test.js)、[compatibility](../../test/compatibility.test.js)：须区分集合注入测试与生产集合完整性 |
| Bootstrap兼容迁移 | 原签名/授权、源/目标摘要、封闭写入清单、loaded revision、事务及监护身份 | [bootstrapMigrationFiles](../../test/bootstrapMigrationFiles.test.js)、[bootstrapMigrationUpdate](../../test/bootstrapMigrationUpdate.test.js)、[bootstrapMigrationBuild](../../test/bootstrapMigrationBuild.test.js)、[bootstrapMigrationBrowser](../../test/bootstrapMigrationBrowser.test.js)：分别覆盖文件中断、Native事务恢复、产物合同与浏览器VM；真实签名资产及Chrome加载另行验收 |
| 迁移专用安全probe | backgroundUpdateSafety、updateSafetyReceiver、updateSafetyProbe、文档/事务/nonce、guarded刷新清单 | [updateSafetyRecovery](../../test/updateSafetyRecovery.test.js)：局部消息与存储装配；真实reload后的文档寿命和原页面状态有独立浏览器证据 |
| Provider 本地边界 | prepared launch、三桥 token/地址验证、关闭与取消 | [providerReliability](../../test/providerReliability.test.js)；具体依赖替换和网络范围需按用例核对 |

纯 helper、源码断言和模拟消息能验证确定分支；真实 frame、Chrome sender 字段、不同扩展加载版本和实际 Native 注册需要对应环境验收。
验证结论应标明所覆盖的通道、身份字段与方法族，再沿调用者确认是否进入该检查；协议目录存在不等同整条调用链已受同一策略保护。
