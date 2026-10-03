# 架构指南逐节代码核验

核验日期：2026-10-03。产品源码基线为 `2073ae74747431aab8d529803d4e9f8197262388`，文档审查起点为 `d5109f1`。
本轮从八个领域页逐节向源码追踪，再从实际入口反向检查文档遗漏。以下记录核查范围、发现、修订及仍需执行的证据。

## 方法与结论范围

八个领域分别由独立 agent 静态核对；每节检查主调用、参数、状态写入、异常分支和最近测试的实际装配。
审阅者读完相关实现后直接修订所属文档，再由其他领域审阅者交叉复查。额外新增的上下文治理页由另一位审阅者独立核对，两处初稿表述也已校准。

本轮没有运行产品测试、模型、浏览器、构建、安装或外网请求，也没有读取真实凭据、论文素材或旧私人交接。代码中的例子均为静态反例，不能当作真实事故记录。
八页共确认并处理35项主要说明或导航修订，包含缺漏与表述不准确；它们不等同35个已经复现的产品缺陷。

结论是：主要领域已有可用入口和源码路线，但先前指南仍遗漏了一些完整分支，并把局部能力推广到了持久化、重试或恢复全过程。本轮已补齐这些已证实缺漏；完备性仍绑定下表实际核验范围。

## 逐节覆盖矩阵

“对应”表示已读源码支持原有表述；“补正”表示本轮修订了事实或必要导航；两者均不表示运行验收通过。表中节号取审查起点，新增小节已落入对应领域页。

### Auto 修改与撤销

详见 [Auto 修改与撤销](auto-edit-undo.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 内容及身份 | mirror 基线、executionSnapshot、Page RPC、运行项目 | 身份对应；补正 Retry sync 的自动编译例外 |
| §2 主调用图 | runTask、runner、orchestrator、broker、page dispatcher | 补 Native diff/patch 生成及二进制分路 |
| §3 快照 | getRunProjectSnapshot、resolveWarmMirrorReuse、snapshotRouter、mirrorWorkspace | 完整/部分基线对应；测试页面与 ZIP 为模拟 |
| §4 写回编排 | WritebackPlan、模式准备、stage/apply/checkpoint/save | 先后顺序对应；恢复保存 stub 的范围明确 |
| §4.1 文本 | textPatch、diffEngine、applyTextPatches、staleGuard | 改正生成与应用 owner；补 UTF-16 坐标、倒序应用及测试 |
| §4.2 新建及二进制 | textFileCreator、binaryAssetUploader、assetTransferBroker | 补独立上传回执、commit 不确定、abort 与 token 清理 |
| §5 保存及镜像 | writebackController、saveState、confirmWritebackFiles | 取证主链对应；补本地重新哈希的信任前提 |
| §6、§6.1 Undo | undoRun、callPageBridge wrapper、trackedChangesLifecycle | 主路由对应；补 broker/deadline 传递及测试范围 |
| §6.2 混合 Undo | 分段保存、创建证明、advanceUndoCheckpoint | 对应；保留 G-06 的中间保存异常 |
| §6.3 Accept | prepareNativeReview、acceptNativeReview、reviewMergedInsertion | 补生产原生、合并插入及 legacy 三路与 History-OT 限制 |
| §7 恢复 | intent、saveCheck、retryRunWriteback、取消序号 | 既有 G-04/G-05 对应；补恢复时 autoRecompile 的当前值回退 |
| §8 验证 | diffEngine/textPatch、原生及 legacy Accept、binary round trip、Undo deadline | 补真实入口与 helper/模拟依赖的边界 |

### 运行状态与恢复

详见 [运行状态与恢复](run-state-and-recovery.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 范围 | AGENTS、入口、证据分级 | 对应 |
| §2 身份及状态 | startRunView、SessionState、StorageDb | 补内存 runAccountScopeId 与会话外层持久 accountScopeId 的区别 |
| §3.1 快照 | runtime、Snapshot/Codec、ProviderRuntime | 白名单对应；补队列提升时另读指令、技能、附件等输入 |
| §3.2 队列与指导 | Queue、Scheduler、QueuePolicy、SessionPersistence | 调用顺序对应；persist/start 替身不能证明真实耐久性 |
| §3.3 取消 | cancelActiveRun、finally、afterSettlement | 调度策略对应；实际退出与页面结果仍需执行 |
| §4.1 存储迁移 | SharedSessionBridge、writeMany/recoveryCopy、StorageDb | 账号导入与恢复副本对应；旧迁移测试未覆盖共享服务全链 |
| §4.2 锁及合并 | connect/ensureLock/mergeValue、BrowserAdapter | CAS、墓碑及在途提交限定对应 |
| §4.3 提交 | saveState、Coordinator、Transaction、Receipt | fence/receipt 与 fallback 对应；保留 G-07 早退 |
| §5.1 加载与 owner | ActiveTurnControl、journal、SessionState、ViewSync | 补两类已持久终态修复；改正先 adopt baseline 再 apply 的顺序 |
| §5.2 导航 | DetachedCommit、PostNavigationPersistence | 原归属对应；真实 SPA 与存储组合未执行 |
| §6 Undo/分叉 | StorageRunActions、PanelState、ForkController | 补分叉复制和补偿主链，以及两条压缩 schema 丢字段的差异 |
| §7 验证 | cross-tab、settled/failure recovery、fork 与 persistence 测试 | 分开片段、真实 helper、模拟 journal 和共享后台服务 |

### Native 执行

详见 [Native 执行](native-execution.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 owner | nativeChannel、background、index、taskRunnerRuntime | 主归属对应；补 CLI 选择和插件 home |
| §2 RPC及终态 | Native decoder/envelope、pending/journal、app-server 消息 | 格式、异步分派及终态范围对应 |
| §3 准入 | handleCodexRun、runCodexSession、参数透传 | 补 skipMirrorSync 独立入口和真值 request.id 的登记前提 |
| §4 thread/turn | resume/fork/steer、summary fallback、事件 scope | Native 路线对应；补 Content 业务恢复导航 |
| §5 互斥与停止 | token 锁、活动表、timing、stop barrier | 既有限定对应；无 ID 的活动表例外已补 |
| §6 重试与断连 | watchdog、后台重试分类、Content 重发、外部 runner | 补三层重试，避免将禁传输重放视为没有业务重试 |
| §7 配额 | quotas、decoder、response budget、asset transfer、debugLog | 定义及已有内层缓冲/日志限定对应 |
| §8 验证 | projectLock、nativeDispatchCancellation、readProgressGuard 等 | 补真实入口、源码断言、替换 runner、合成进程的层次 |
| §9 反例 | 取消、重启、超限、终态与请求身份 | 原反例对应；补直达参数和活动登记反例 |

### Provider 与协议

详见 [Provider 与协议](providers-and-protocols.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 定义、§2 owner | ProviderProfile、ProviderStore、runtime/TaskRunner | 主结构对应；补模型缺省值遮蔽父配置 |
| §3.1 目录 | ModelPicker、缓存候选、resolveProviderModels | 迟到与 fallback 规则对应，保留既有错误包例外 |
| §3.2 身份 | resolveRunProvider、upsert、recordProviderDiagnostic | profile/store revision 及诊断作用对应 |
| §4 Save/Test/Use | dialog/coordinator、testProvider、test process | 修正确认/加载顺序，补准备期间预取消仍可 spawn 的窗口 |
| §5 引擎 | prepareProviderLaunch、config args、app-server | 主链与临时资源职责对应 |
| §6、§6.1 转换 | 三桥请求、SSE/JSON、工具及签名处理 | 既有 buffered/bodyOverrides/EOF 限制对应 |
| §6.2 Reasoning | reasoning control、Anthropic thinking | 原公式对应；新增输出预算迁移、优先级和 DeepSeek 抬升 |
| §7.1 续传 | Responses lineage、Chat/Anthropic history | 内存寿命和各自续传分支对应 |
| §7.2 计时 | StreamLifecycle、桥计时器、异常恢复 | idle/total 与既有 EOF 限制对应 |
| §8 数据边界 | URL/键名检查、凭据事务、错误清洗 | 补披露只核配置 URL，未固定重定向终点或 DNS |
| §9、§10 验证 | reliability、sessionBinding、Anthropic、模型测试 | 补 helper/VM/替身范围，未宣称外部协议已认证 |

### 并行子代理

详见 [并行子代理](parallel-subagents.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 两路线 | broker、Native observer、activity ingest | 调度与观察分工对应 |
| §2 启动与目录 | worker 创建、skill strip、thread 参数 | 继承与共享 cwd 对应；禁递归的技能边界保留 |
| §3 文件协议 | intake/validateJob/writeResult/broker.json | 补拒绝非法 ID 的回执路径缺口及 activeWorkers 非实时投影 |
| §4 生命周期 | fillSlots、stop、deadline、drain | 原路径别名/预算限制对应；图按 broker 最终状态分类 |
| §5 接管 | finishWorker、endWave、processAdoptions | 原哈希及接管限制对应；补 runner 终态映射与隔离前提 |
| §6 写回 | runner drain、collect diff、focus/selection、blockedPaths | 顺序对应；测试主要为装配断言 |
| §7 历史及 UI | observer.snapshot、activity model/view、存储 | 补 readDisabled 的寿命、renderViewer 局部恢复 |
| §8、§9 验证 | broker、parallel、telemetry、view、terminal clock | 注入 worker/进程/DOM 的边界明确，新增反例已同步 |

### 写作风格与技能

详见 [写作风格与技能](writing-style-and-skills.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 术语、§2 owner | localSkills、profile validator、UI/Native装配 | 定义及 owner 对应 |
| §3 时序 | generate/startBuild/build/capture/forRun | 主链对应；补 ready 与可消费的区别 |
| §4 资料读取 | referenceProjects、snapshotRouter、附件封装 | 读取和取消信号对应；真实资料读取未执行 |
| §5 生成验证 | PDF worker、profile/evidence、recovering runner | 结构与证据校验对应，质量和真实 CLI 恢复待执行 |
| §6 身份与资产 | get/set、saveConfig、readBundle、forRun | 补损坏版本影响关闭/新提交、输出限额与跨进程竞争 |
| §7 失败清理 | controller epoch、Native build/get、finally | 原取消限定对应；补 try 前初始化失败未清理 |
| §8 配额与数据 | REFERENCE_LIMITS、quotas、worker、source-index | 输入约束对应；补 800000 字符的资产消费限制 |
| §9 普通技能 | CRUD、CodexHome、approval、installer | 已有限定对应；不以 completed 证明产物可用 |
| §10、§11 验证 | limits、快照、技能、UI stub及反例 | 未找到完整 build/profile/evidence 的专项保证，保持待验证 |

### 界面与加载

详见 [界面与加载](ui-and-loading.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 双入口 | canonical entry、build、manifest、Bootstrap | 对应；构建 fixture 和清单检查不替代实际首载 |
| §1 registry | define/resolve、REQUIRED/SUPPORT、runtime init | 对应；VM 与源码顺序断言范围明确 |
| §1 MAIN | 注入表、OT可选依赖、capability、RPC | 对应；真实消息/脚本加载待执行 |
| §2 Panel/Settings | slots、Workbench、dialog | 主链对应；补历史维护和结果动作 |
| §3 作用域 | global/project/session写入、快照 | 主要区分对应；附件保存/加载断点明确 |
| §4 模型 | generation、revision、fallback、unavailable | 既有失败包例外对应 |
| §5 选区 | attach、normalize、sent chip、ContextTray | 对应；编辑器与 Native 联动未执行 |
| §5 附件 | 预算、FileReader、serialize、StorageDb/hydration | 补 helper 与真实刷新持久链不一致 |
| §6 输出 | Markdown/Math/LineReferences、activity投影、WrittenChangesView | 补活动及写后回执，区分已打包的交互 legacy diff |
| §7 诊断/Popup | 导出身份、health、双HTML、launcher | 对应；浏览器与真实导出待执行 |
| §8、§9 配方 | 历史清理、edit-resend、fork、活动测试 | 补缺失功能路线和对应测试装配 |

### 安装与更新

详见 [安装与更新](installation-and-updates.md)。

| 原章节 | 关键源码和测试入口 | 核验结果 |
| --- | --- | --- |
| §1 五层身份 | buildContentBundle、inspectInstalledRuntime | 对应 |
| §2 加载 | CLI、install、manifest、registerManagedRuntime | 对应；源码安装与预构建包分开 |
| §3 安装注册 | managedInstall、平台路径、launcher、卸载 | 补不同根共享入口及卸载跨副本影响 |
| §4 owner | coordinator、projection、revocation、Native journal | 对应；补 consumed 后授权文件清理 |
| §5 正常链 | authorize/stage/apply、requireAuthorization | 限定两小时过期检查只在 authorized 状态 |
| §6 安全点 | UpdateIdle、二次检查、Native gate | 既有计数/进程退出边界对应 |
| §7 恢复 | cancel/revoke/recover/supersede/rollback | 补严格更高版本条件和同 target 重装保留账本 |
| §8 信任网络 | trust/archive/transport/proxy | 主链对应；补不同平台代理来源 |
| §9 手动升级 | protocol、protected paths、promotion | 对应；补 RC→同数字 stable 的手动升级条件 |
| §10 发布 | HEAD workflow、build/sign/verify/hop | 补签名声明与实际 bundle 字节未闭合的验证链 |
| §11、§12 验证 | update/managedInstall/Bootstrap/release 测试 | 定义入口对应；静态清单不承担完整注册/恢复证明 |

## 反向能力检查新增的专题

[上下文与治理](context-and-governance.md) 来自源码入口反查，原指南仅零散提及这些能力。
本轮追踪了 `runSensitivePreflight`、`mirror.scanSensitive`、项目规则读写、`WritebackPlan`、`GovernanceRules`、prompt 组装和审计消费者。

| 检查点 | 结论及修订 |
| --- | --- |
| 哪些材料被扫描 | 主调用传 task/文本 files，未传完整组装 prompt；其他渠道另行定位 |
| 镜像扫描是否完整 | 扩展名、512 KiB、100项限制；浏览器仅消费 findings，skippedFiles 不构成完整性阻断 |
| 新快照重试 | 完整或聚焦部分快照准入后重发，当前分支未再次调用预检 |
| 规则何时生效 | 当前项目规则分别在扫描与写回读取，不在执行快照白名单 |
| 写入许可与权限 | readonly 优先、allowlist 非空时收窄；约束 Overleaf 主写回路径，不能替代本地沙箱或读取权限 |
| 审计范围 | 入口为 createAuditDraftForRun；摘要来源是传入 task，不能代表完整模型输入 |

新增页经过独立核对。初稿中“完整快照”与审计入口/摘要来源两处已校准并复查；没有运行真实扫描。

## 修订规模与交叉复核

| 领域 | 主要修订点 | 交叉复查 |
| --- | ---: | --- |
| 写回与撤销 | 4 | 通过 |
| 运行与恢复 | 5 | 通过 |
| Native | 5 | 通过 |
| Provider | 4 | 通过 |
| 子代理 | 4 | 通过；进一步修正成功处理回调异常也进入 broker catch |
| 风格与技能 | 4 | 通过 |
| UI | 5 | 通过 |
| 安装更新 | 4 | 通过 |
| 合计 | 35 | 已报告文档修订完成 |

这些修订主要属于三类：补足漏掉的可达功能、校正状态和参数传播范围、标明测试替换依赖造成的证明边界。
当前产品中的缺口仍然存在，具体证据放在相应领域页；[差异登记](evidence-and-drift.md)保留旧问题身份，避免同一风险在多处被当作不同问题。

## 后续仍缺的证据

1. 浏览器真实 save→load、附件恢复、分叉标记、历史清理和编辑重发的组合路径。
2. 非正常结束帧、正常 EOF、准备期间取消等真实 Codex/Provider 进程及协议场景。
3. 新旧文件混合 Undo、取消后回执丢失、镜像基线与下一轮执行之间的时序。
4. 多 Native 进程共用配置、版本包输出上限、安装根并存、同版本重装与旧更新事务。
5. 构建、签名声明、实际归档字节、运行时 staging 及公开发布资产之间的联合验证。

纯源码能确认字段未传、白名单未保存、守卫缺失或异常绕过。它不足以确定现场触发概率、实际数据损失或所有外部环境表现，不能把本轮交叉复查改写成产品回归全绿。

## 交付检查

文档链接、锚点、符号、测试选择器、Git 白名单及非文档改动范围进行机械检查。测试选择器仅使用 `--list`，不执行产品测试。
本轮检查通过：17份文件（含 AGENTS）、1015个相对链接、74个可从链接标签提取的源码符号；132个测试文件被运行器成功列出。符号检查只覆盖可机械提取的标签，其他关键调用及字段由逐节源码核对与交叉复查确认。
历史审阅统计保留在各自记录，本轮统计单独记录。文档覆盖以实际入口和行为链评估，不计算“源码文件被链接比例”作为完备率。
