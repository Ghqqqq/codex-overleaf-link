# 消息协议、准入与信任边界

适用产品版本：`2.5.0`；源码基线：`2073ae74747431aab8d529803d4e9f8197262388`。
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

`pageRpcContract.resolveDispatchPolicy` 固定 `automaticAttempts: 1`；`safe`、`idempotent` 等标签描述方法策略，client 不据此自动重发。
幂等表示重复执行应收敛到同一结果，例如开关设置；它与“请求只发送一次”属于不同性质。
文本写回回执由 [writebackReceiptJournal](../../extension/src/page/writebackReceiptJournal.js) 管理，二进制 staging、commit 和 status 由 [binaryAssetUploader](../../extension/src/page/binaryAssetUploader.js) 管理。
回执生命周期、部分结果、保存证据和恢复动作仍按具体 handler 解释，见[Auto 修改与撤销](auto-edit-undo.md)。
`content_abort` 取消 client 等待；页面 `cancelActiveWrite` 另行推进取消序号，具体写入循环在检查点停止。
取消等待、操作已停止、部分写入可恢复分别取证；相关时序与回执查询限制见写回专题。

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

共享会话写入还检查 scope、记录归属与锁 token；这些检查不能由允许访问某个站点推导。各共享方法的锁例外见[运行状态与恢复](run-state-and-recovery.md)。
普通 Native listener 的报错文案提到项目页面，但 `isAllowedOverleafSender` 有 tab 分支当前只检查主机和协议。
该 helper 的条件允许 Overleaf `/learn`，也未额外拒绝“顶层 tab 为 Overleaf、sender URL 指向其他源且 frameId 非零”的字段组合。
真实扩展消息的 sender 元数据由 Chrome 提供，网页脚本不能任意指定它；函数接受一个合成对象不证明现行注入与 Chrome 投递路径能够产生该组合，实际可达性需要独立浏览器验证。

**Target contract：**调整站点、路由、frame 注入或新增消息族时，逐项决定实际 sender URL、扩展身份、项目路径及 frame 要求，并检查所有相关 listener。
`sender.tab.url` 描述顶层标签页，`sender.url` 描述消息发送文档；两者在 frame 场景中可能不同，不能直接互换。
`frameId` 限定文档层级，业务 `projectId` 限定数据归属，扩展 ID 限定扩展身份；三者分别维护。

## 4. Native 兼容性门控的两个位置

兼容性门控决定当前版本与协议能否处理某个方法，与发送者准入、用户操作授权分别执行。
[compatibility.js](../../extension/src/shared/compatibility.js) 定义协议范围、最低版本、必要 capabilities，以及 `compatible/update-available/incompatible` 分类和允许方法矩阵。
[taskRunnerRuntime.handleRequest](../../native-host/src/taskRunnerRuntime.js) 的 `bridge.ping` 报告 Native 版本、协议、能力和环境；capabilities 取自共享常量，不能视作逐项业务实测结果。

Content 的 [NativeCompatibilityController.ensureForMethod](../../extension/src/content/nativeCompatibilityController.js) 先 ping，再用传入的 `gatedMethods` 集合决定是否阻止目标方法。
集合定义在 [contentRuntime.NATIVE_COMPATIBILITY_GATED_METHODS](../../extension/src/content/contentRuntime.js)；只有集合内方法会附加兼容性 evidence，并执行对应派发前取消检查。
其中 `mirror.invalidate` 豁免该取消检查，用于保留 Undo 后的镜像失效处理；不能从豁免推定其他操作可在取消后继续。
后台 [getNativeCompatibilityBlock](../../extension/src/background.js) 再检查请求 evidence；它不会为普通请求重新执行独立 ping。

| 范围 | 方法族及例外 |
| --- | --- |
| Content 与后台 required 集合共同覆盖 | `codex.run/steer`、`task.run`、镜像 `sync/patchFiles/confirmWriteback/invalidate/scanSensitive`、当前 `codex.providers.*` 七个方法、`codex.history.clearPlugin`、`skills.list/install/remove` |
| Content gate 中的额外项 | `mirror.status`、`codex.models`；后台将其列入 recoverable 集合 |
| 后台 required 集合中的额外项 | `task.confirm`；当前 Native 返回 Suggest 模式已移除 |
| 后台 recoverable 集合 | `bridge.ping`、`mirror.status`、`codex.models`、`codex.cancel`；无 evidence 不按 required 规则拦截，有 evidence 时仍应用分类规则 |
| 当前未进入上述 required / Content gate 的业务方法 | `writing-style.get/set`、`codex.thread.fork`、`asset.readChunk/release` |

**Current behavior 限定：**未进入 Content 集合的方法仍经过该 controller 的 ping，但 `allowed` 分支直接放行，`attachEvidence` 不附加检查结果。
后台在没有 evidence 时仅阻止 required 集合内方法；如果上述五个业务方法显式携带 incompatible evidence，仍会被兼容性分类规则阻止。`bridge.ping` 则由分类规则始终放行。
因此相同方法在“缺少 evidence”和“提供 incompatible evidence”两种输入下可有不同准入结果。
真实调用者包括 [writingStyleSettings](../../extension/src/content/writingStyleSettings.js)、[sessionForkController](../../extension/src/content/sessionForkController.js) 与 [assetTransferBroker](../../extension/src/content/assetTransferBroker.js)，均由 runtime 注入 `sendBackgroundNative`。
该分支使上述五个方法在 ping 为 incompatible 时仍可被发送；旧 Native 是否支持这些方法及其实际错误需另行验证。

后台 `sanitizeNativeRequest` 在发送前剥离兼容性 evidence。Native `handleRequest` 执行配额、方法路由及各业务检查，没有再实施同一版本 gate。
托管更新的 `requestManagedInternal` 显式使用 `skipCompatibility`；更新安全点、授权、签名与事务检查见[安装与更新](installation-and-updates.md)，不能按普通业务方法解释这条内部通道。

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
| Page 方法或握手 | client、capability guard、contract、dispatcher、Page 加载清单与消费者 | [pageRpcContract](../../test/pageRpcContract.test.js)、[pageBridgeClient](../../test/pageBridgeClient.test.js)、[pageBridgeStaleGuard](../../test/pageBridgeStaleGuard.test.js)：目录、模拟消息和局部页面守卫 |
| 后台消息准入 | 对应 listener、sender helper、manifest 注入、站点及 frame 范围 | [backgroundNativeError](../../test/backgroundNativeError.test.js)、[globalPreferences](../../test/globalPreferences.test.js)：worker VM 或存储 mock；不能代替 Chrome 投递验证 |
| Native 兼容 gate | runtime 集合、controller、后台集合、共享分类、Native ping 与调用者 | [nativeCompatibilityController](../../test/nativeCompatibilityController.test.js)、[nativeCompatibilityRunDispatch](../../test/nativeCompatibilityRunDispatch.test.js)、[compatibility](../../test/compatibility.test.js)：须区分集合注入测试与生产集合完整性 |
| Provider 本地边界 | prepared launch、三桥 token/地址验证、关闭与取消 | [providerReliability](../../test/providerReliability.test.js)；具体依赖替换和网络范围需按用例核对 |

纯 helper、源码断言和模拟消息能验证确定分支；真实 frame、Chrome sender 字段、不同扩展加载版本和实际 Native 注册需要对应环境验收。
验证结论应标明所覆盖的通道、身份字段与方法族，再沿调用者确认是否进入该检查；协议目录存在不等同整条调用链已受同一策略保护。
