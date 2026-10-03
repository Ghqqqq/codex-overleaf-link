# Codex Overleaf Link 架构指南

Codex Overleaf Link 将 Overleaf 项目读取、本地 Codex 执行、文件写回与撤销恢复连接起来。这套指南说明各功能的实现位置、状态归属、调用关系、已知限制及修改时需要联动的模块。

初始参考产品版本：`2.5.0`；初始运行时梳理基线：`2073ae74747431aab8d529803d4e9f8197262388`。指南随本仓库当前受维护代码同步，安装副本和浏览器已加载代码的版本需单独确认。

新功能、debug 与其他代码修改统一执行[功能开发与故障修复 SOP](change-workflow.md)。维护时核对受影响章节及其基线声明；局部同步不代表全仓重新验收，具体变更可由 Git 历史定位。

## 阅读路径

| 任务 | 对应章节 | 主要内容 |
| --- | --- | --- |
| 开始功能开发、debug 或其他代码修改 | [开发与修复 SOP](change-workflow.md) | 定位、契约/复现、实现验证、指南同步及完成条件 |
| 首次理解项目 | [系统总览](system-overview.md) | 执行环境、加载入口、主调用链和领域概念 |
| 定位一个功能的修改位置 | [功能修改索引](feature-map.md) | 入口、状态所有者、必要联动和测试 |
| 修改文件写回、保存、Accept 或 Undo | [Auto 修改与撤销](auto-edit-undo.md) | 差异、补丁、文本及二进制传输、保存证据和恢复 |
| 修改任务、队列、会话或刷新恢复 | [运行状态与恢复](run-state-and-recovery.md) | 执行快照、共享历史、持久化、分叉与状态投影 |
| 修改本地消息、进程、取消或锁 | [Native 执行](native-execution.md) | 请求归属、app-server、重试、终态与退出证据 |
| 修改消息准入、身份检查或兼容策略 | [协议与信任边界](protocols-and-trust.md) | 通道、发送者、Page token、Native gate 与方法消费者 |
| 修改模型连接、协议或凭据配置 | [Provider 与协议](providers-and-protocols.md) | 配置修订、协议转换、流式生命周期和数据边界 |
| 修改子代理调度或结果采用 | [并行子代理](parallel-subagents.md) | broker、遥测、共享文件、隔离与采纳 |
| 修改风格参考、生成或技能应用 | [写作风格与技能](writing-style-and-skills.md) | 资料读取、资产版本、取消、运行引用和技能安装 |
| 修改面板、设置、附件或模块加载 | [界面与加载](ui-and-loading.md) | 注册、控件状态、配置作用域和结果呈现 |
| 修改安装、更新或发布 | [安装与更新](installation-and-updates.md) | 版本身份、授权、安全点、事务和分发 |
| 修改扫描、上下文范围或写入规则 | [上下文与治理](context-and-governance.md) | 扫描输入、路径许可、放行条件与审计 |

普通维护任务从功能索引进入相关领域页，再沿入口符号、调用方和最近测试读取代码。无需每次加载全部章节。跨领域功能由相关章节共同说明，例如 Undo 同时涉及页面操作、镜像基线与运行记录持久化。

## 修改前需要确认的关系

1. **执行环境**：代码位于 content、页面主世界、扩展后台或 Native，分别具有不同权限与寿命。
2. **状态所有者**：确认负责写入事实的模块，以及只展示或缓存该事实的消费者。
3. **身份与时序**：检查账号、项目、会话、运行、请求和配置修订如何穿过异步调用。
4. **失败与恢复**：对照取消、超时、部分成功、导航和重载分支，确认已经发生的操作及恢复材料如何保留。
5. **联动范围**：同步检查协议、注册、兼容处理、持久化白名单、界面投影和测试。

领域页区分当前实现、目标契约和已知限制。当前实现以对应源码为依据；目标契约说明应维持的要求；已知限制说明哪些路径尚未满足要求或需要额外验证。局部 helper 的能力不能直接推广为完整运行链的保证。

## 按修改选择验证

各领域页列出最近测试及其装配范围。纯函数、源码断言、模拟消息、合成子进程和真实浏览器场景提供不同层次的证据，需按改动选择。测试文件名中的 `browser` 或 `e2e` 不能独自说明运行了真实 Chrome 或模型；应核对测试装配、模拟替身和实际调用链。

运行器支持指定文件与只列出选择：

```sh
node scripts/run-tests.mjs --list test/ordinaryUndoRouting.test.js test/undoMirrorInvalidation.test.js
node scripts/run-tests.mjs test/ordinaryUndoRouting.test.js test/undoMirrorInvalidation.test.js
```

第一条仅列出测试；第二条执行所选测试。命令从仓库根目录运行，按修改范围选择：

| 修改或验证目的 | 入口 | 作用与证据范围 |
| --- | --- | --- |
| 文档入库与源码卫生 | `npm run verify:source`；`node --test test/architectureGuidePublication.test.js` | [源码规则](../../scripts/verify-release.mjs)仅放行指定正式指南，其他文档和本地交接仍拒绝；[专项测试](../../test/architectureGuidePublication.test.js)同时检查 `.gitignore` 对齐和 npm 排除。 |
| 领域专项回归 | `node scripts/run-tests.mjs <文件…>`；带 `--list` 可先查看选择 | 直接运行所选文件；具体测试可能创建 fixture、子进程或构建产物。`npm run test:focus -- <文件…>` 还前置模块图检查。 |
| 快速回归 | `npm run test:fast` | 执行 [run-tests.mjs](../../scripts/run-tests.mjs) 中 `FAST_TEST_FILE_NAMES` 的固定选集；不会自动按改动选测试，仍需补充相关专项。可用 `node scripts/run-tests.mjs --fast --list` 查看名单。 |
| 完整 Node 测试 | `npm test` | 执行运行器在 `test/` 顶层发现的全部 `.test.js`；包含源码断言、VM 与合成进程等不同装配，不能据此宣布真实浏览器验收通过。 |
| Content 加载与构建 | `npm run check:module-graph` | [检查脚本](../../scripts/check-content-module-graph.mjs)重新生成 bundle 与 metadata，核对输入、隐式依赖及包体限制。`npm test`、`test:fast`、`test:focus` 均前置此步骤。 |
| 受预算约束的模块修改 | `npm run check:architecture` | [架构预算](../../scripts/check-architecture-budget.mjs)检查所列文件存在且行数不超过各自上限；通过只证明这些数值约束，完整职责与依赖关系仍需审阅。 |
| 镜像、差异、补丁及大项目回归 | `npm run benchmark:large` | [合成基准](../../scripts/benchmark-large-project.mjs)调用生产模块并混用近似指标，创建并清理临时镜像；命令自带 `--gate`，耗时越界会失败。`--output <路径>` 会额外写报告。 |
| OT 点击、滚动与重绘时序 | [真实 Chrome 本地夹具](../../test/browser/README.md) | `node scripts/serve-ui-regression.mjs` 启动本地 HTTP 服务，随后在 Chrome 中操作；要求真实指针点击。夹具不连接 Overleaf 或 Native，检查结束后需停止服务。 |
| 已加载扩展与真实项目连接 | [项目 smoke 命令](../../README.zh-CN.md#开发)及 [smoke-extension.mjs](../../scripts/smoke-extension.mjs) | `npm run smoke:extension` 先构建，再启动 Chrome。探针覆盖面板、Native 握手、项目摘要和诊断入口；项目写回、保存、Accept、Undo 及模型执行需另有具体场景。默认临时 profile，指定 profile 会使用其登录状态；`--json` 写脱敏结果。 |
| 安装本地构建供 Chrome 验收 | `npm run smoke:prepare:chrome` | 顺序执行构建、快速选集与真实 `install:managed`，会修改本机托管安装；随后仍需重载扩展和刷新 Overleaf，准备完成本身不构成验收证据。 |

构建写入 [build-content-bundle.mjs](../../scripts/build-content-bundle.mjs) 所定义的 `extension/src/content/generated/content.bundle.js` 和配套 metadata；这些生成文件不手改。直接调用运行器的 `--list` 会在执行测试前返回；通过 npm 测试命令传入 `--list` 仍会先构建。

合成基准中的镜像同步、状态、变更收集、diff 和 patch 调用生产模块；`snapshot.zip_parse_ms` 实际测量 `JSON.parse`，`context_tray.render_ms` 测量合成目录树构造，`storage.prepare_ms` 测量脚本内对象准备。它们用于固定合成输入的回归比较，真实 ZIP 解压、浏览器绘制和 IndexedDB 写入耗时需要分别取证。

跨平台验证参照 [CI](../../.github/workflows/test.yml) 的 macOS、Ubuntu、Windows 和 Node 版本配置；本机结果只覆盖实际执行的平台与路径。Chrome 加载、Overleaf DOM、真实保存与刷新恢复仍需对应交互验证。源码卫生与开发元数据使用 `npm run verify:source`；npm 包范围、更新边界，以及正式发布的打包、签名和更新演练见[安装与更新](installation-and-updates.md)。

## 维护约定

- 每次代码任务按 [SOP](change-workflow.md)完成指南影响判断；必要的正文和索引修改与代码一起交付，无需修改时说明核对范围和理由。
- 入口、状态归属、协议、加载方式或恢复策略变化时，同步修改对应领域页和功能索引。
- 源码常量与协议目录保持权威，指南使用仓库相对链接和实际符号，避免复制完整配置目录。
- 文档描述项目的当前结构和行为；未来设计应明确标注其目标状态。
- 已知限制放在所属功能章节，和受影响的调用链、源码及测试入口一起维护。
- 正式指南按 Git 跟踪路径的精确白名单维护，新增页面须同步核对 [.gitignore](../../.gitignore) 与[源码卫生规则](../../scripts/verify-release.mjs)；npm 包和 release 归档仍排除 `docs/`。源码可协作范围与产品分发范围分别判断。
