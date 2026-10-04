# Codex Overleaf Link 维护入口

本仓库为 Overleaf 提供本地 Codex 对话、项目理解、修改和恢复能力。维护任务从对应功能的实际入口、状态所有者及协议开始定位。

## 代码与指南同步要求

所有新功能、行为调整、debug、重构及配置/工具修改均执行[功能开发与故障修复 SOP](docs/architecture/change-workflow.md)。开始时沿指南核对真实入口、owner、调用链及验证方式；交付前按最终代码同步受影响领域页、功能索引和已失效限制。代码与必要指南修订属于同一任务的完成条件。

每次代码任务必须作指南影响判断。若现有描述仍完整准确，可以不改正文，但最终回复或已有 PR/任务说明必须列出核对的章节及具体理由。实际行为、定位路径或限制发生变化时须完成对应修订。交付说明包含行为变化、指南同步、实际验证和遗留项；审阅过程与独立问题记录继续置于指南之外。

涉及运行时代码的本机修复完成并通过相关自动检查后，默认直接构建、备份并更新现有 Managed 安装，无需再次询问安装许可。核对扩展、Native 和构建摘要后，提示使用者在现有 Chrome 扩展条目点击重新加载；收到已重载后继续刷新项目并执行 CUA 验收。纯文档变更不触发安装；发布及真实项目写入仍按各自授权范围执行。具体交付顺序见 SOP 的本机验收流程。

真实模型验收与烟测统一选择 Luna，以 UI 中实际可用的模型标识核验，并逐次记录运行使用的模型。Luna 不可用时记录阻塞，不自动改用 Sol 或其他模型。此约定只约束测试选择，不修改产品默认模型。

后续新增子 agent 任务统一显式选择 `gpt-6.1-sol`。该约定用于开发、验证和审阅的子任务调度；真实模型验收仍遵守上一段的 Luna 约定。

## 按需阅读

1. 首次接手阅读[指南入口](docs/architecture/README.md)与[系统总览](docs/architecture/system-overview.md)。
2. 按需求查[功能修改索引](docs/architecture/feature-map.md)，只展开相关领域和源码。
3. 修改、保存、Accept、Undo 读[Auto 修改与撤销](docs/architecture/auto-edit-undo.md)；提交、队列、持久化、刷新读[运行状态与恢复](docs/architecture/run-state-and-recovery.md)。
4. 本地进程与消息读[Native 执行](docs/architecture/native-execution.md)；模型连接读[Provider 与协议](docs/architecture/providers-and-protocols.md)；其他领域按功能索引进入对应专题。
5. 上下文出站、敏感扫描与只读/可写路径规则读[上下文与治理](docs/architecture/context-and-governance.md)。这些检查有各自的入口与数据范围。
6. 消息准入、Page 握手、Native 兼容 gate 与本地桥身份读[协议与信任边界](docs/architecture/protocols-and-trust.md)，按实际通道区分发送者、项目归属与版本能力。
7. 已知限制、异常分支与测试边界在对应领域页中说明；实际修改仍需核对调用者和测试。

正式指南只保存项目架构、实现路线、已知限制与维护方法。审阅报告、定位验收记录、修改统计和临时研究材料不进入指南，也不作为阅读依赖；审阅结论应直接用于修正对应章节。

## 证据与工作方式

重要结论区分 `Current behavior`（源码事实）、`Target contract`（应保持的契约）、`Known gap`（已知限制或验证缺口）。测试定义存在、实际执行通过、浏览器验收通过分别判断。

| 问题 | 优先证据 |
| --- | --- |
| 当前如何执行 | 实际调用方、运行时源码、有效 manifest 与生成入口 |
| 谁决定状态 | 该状态的写入者、协议定义和持久化所有者 |
| 自动检查覆盖什么 | 最近的行为或契约测试及验证脚本 |
| 应实现什么 | 当前任务要求及明确标注的目标契约 |
| 为何采用旧设计 | 对应历史决策；仍须核对适用版本 |

编辑前定位 owning execution context、状态所有者、协议边界及最近测试。保留无关工作树修改，按最小连贯范围修改；验证从相关专项开始。发现文档与代码冲突时记录差异，不把期望行为描述成已实现事实。

## 修改时必须保持的契约

| 主题 | 维护约束 |
| --- | --- |
| Content 加载 | 源码纳入由 `extension/entries/content-entry.mjs` 管理，模块依赖通过 registry 或组合根显式传入；两份 manifest 注入生成 bundle。不要手改生成文件。 |
| Page world | 核对 `pageBridgeClient.PAGE_WORLD_SCRIPTS`、资源公开清单、托管 allowlist、dispatcher、`pageRpcContract` 与测试。 |
| 身份 | 写操作必须核对捕获的项目及运行归属；身份缺失或不匹配时应停止。现有 page-state RPC 的例外见写回章节及 `pageRpcContract`。 |
| 队列 | 执行快照与 submissionContext 分别固定配置和入队指令/技能；排队附件不受支持，提升时不得从后来草稿读取附件或单次技能。旧项兼容、容量和其他输入捕获时机见运行状态页，不能推广为全部项目内容冻结。 |
| 空文件 | `""` 是合法内容；缺失、未读取和空白必须区分。有效空基线参与新鲜度检查；空编辑器覆盖层需有成功读取证据，见写回章节。 |
| 成功证据 | applied、readback、saved、mirrored、compiled、settled 分别表达；部分失败和保存未知不能合并成完全成功。 |
| 秘密数据 | 禁止凭据进入浏览器持久状态、运行事件 journal、诊断及日志。本地专用凭据与恢复事务存储按 `providerStore` 的权限及生命周期管理。 |
| 协议 | 同步检查 owner、生产者、消费者、兼容处理、错误映射及契约测试；重试须遵守操作幂等性。 |
| 镜像 | Overleaf 镜像按 `overleafWorkspaceRules` 使用，禁止在其中运行 Git。开发仓库正常使用 Git。 |

## 文档与验证

入口、状态归属、协议、加载或恢复策略变化时，同步维护对应指南与功能索引。文档使用仓库相对链接和实际符号，重要数值优先指向权威常量。

新增正式指南页面时同步维护 `.gitignore` 与 `scripts/verify-release.mjs` 的精确白名单；私人材料与报告继续排除。Git 跟踪范围与 npm、release 分发范围分别维护。

高风险契约需追踪参数是否穿过各层、状态是否有其他写入者、取消或断线是否跳过收尾、测试是否覆盖真实调用链。局部函数性质不能直接推广为整条链路保证；未证明的项保留明确范围。

[指南入口](docs/architecture/README.md)列出验证方式；专项测试与真实 Chrome/Overleaf 验收各自提供不同证据。纯文档改动检查链接、符号、基线和定位可用性，不据此声称运行时测试通过。

发布工作使用环境中可用的 `codex-overleaf-link-release` 技能，并从当前 package metadata 推导版本。旧发布记录和旧标签的 workflow 只作为历史证据；本指南不授权重新发布、移动标签、覆盖资产或操作真实论文。
