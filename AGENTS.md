# Codex Overleaf Link 维护入口

本仓库为 Overleaf 提供本地 Codex 对话、项目理解、修改和恢复能力。维护任务从对应功能的实际入口、状态所有者及协议开始定位。

## 按需阅读

1. 首次接手阅读[指南入口](docs/architecture/README.md)与[系统总览](docs/architecture/system-overview.md)。
2. 按需求查[功能修改索引](docs/architecture/feature-map.md)，只展开相关领域和源码。
3. 修改、保存、Accept、Undo 读[Auto 修改与撤销](docs/architecture/auto-edit-undo.md)；提交、队列、持久化、刷新读[运行状态与恢复](docs/architecture/run-state-and-recovery.md)。
4. 涉及旧描述或边界假设时，查[证据与差异登记](docs/architecture/evidence-and-drift.md)。索引中尚未展开的领域须继续读取所列源码，不能将导航条目当作完整设计。

`docs/agents/`、其他本地历史文档及 `.local-handoff/` 可能只存在于某台机器，不是新克隆的必备依赖。其旧数值、安装步骤和 Known gap 必须重新核对。

## 证据与工作方式

重要结论区分 `Current behavior`（源码事实）、`Target contract`（应保持的契约）、`Known gap`（有证据的差异或验证缺口）。测试定义存在、测试本轮通过、浏览器验收通过分别记录。

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
| 身份 | 写操作必须核对捕获的项目及运行归属；身份缺失或不匹配时应停止。现有 page-state RPC 的例外见差异登记。 |
| 队列 | 已提交执行快照固定；后续 UI 或 Provider 设置变化不能静默改写队列、活动运行或历史。 |
| 空文件 | `""` 是合法内容；缺失、未读取和空白必须区分。现有空白基线限制见差异登记。 |
| 成功证据 | applied、readback、saved、mirrored、compiled、settled 分别表达；部分失败和保存未知不能合并成完全成功。 |
| 秘密数据 | 禁止凭据进入浏览器持久状态、运行事件 journal、诊断及日志。本地专用凭据与恢复事务存储按 `providerStore` 的权限及生命周期管理。 |
| 协议 | 同步检查 owner、生产者、消费者、兼容处理、错误映射及契约测试；重试须遵守操作幂等性。 |
| 镜像 | Overleaf 镜像按 `overleafWorkspaceRules` 使用，禁止在其中运行 Git。开发仓库正常使用 Git。 |

## 文档与验证

入口、状态归属、协议、加载或恢复策略变化时，同步维护对应指南与功能索引。文档使用仓库相对链接和实际符号，重要数值优先指向权威常量。

[指南入口](docs/architecture/README.md)列出验证方式；专项测试与真实 Chrome/Overleaf 验收各自提供不同证据。纯文档改动检查链接、符号、基线和定位可用性，不据此声称运行时测试通过。

发布工作使用环境中可用的 `codex-overleaf-link-release` 技能，并从当前 package metadata 推导版本。旧发布记录和旧标签的 workflow 只作为历史证据；本指南不授权重新发布、移动标签、覆盖资产或操作真实论文。
