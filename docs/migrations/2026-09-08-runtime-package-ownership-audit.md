# 业务分离后的全仓体验审计

本轮在[迁移验收](2026-09-08-runtime-package-ownership-verification.md)之后追加源码、安装产物和开发流程审计。首轮记录保留其原始时间及源码指纹；本记录描述后续修复和重新执行的验收。最后一个实现提交为 `930506962`，后续文档提交不改变下面测量的源码与配置。

## 发现并修复的问题

| 范围                | 实际问题与处理                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser 与 sandbox  | Browser Host 仍按旧 Desktop 路径查找源码；独立安装缺少源码时需使用 managed Host。Linux Cargo helper 路径及 Linux/Windows helper 的 home 解析已归回 Runtime Local，OS 权限边界仍按真实 OS home 处理。                                                              |
| 文档、命令与命名    | 更新 CONTRIBUTING、开发文档、架构总览、CLI 指南、包指南、Skills 与本地 commands。CLI 的 `run.ts` 改为 `send.ts`，同步命令目录、测试、覆盖率豁免路径及迁移映射。SDK 示例移除不存在的目录与重复执行。                                                               |
| 验证与发行接线      | 包验证、独立核心打包采用 SDK 只编译入口，避免并行类型检查期间清空生成源码。门禁依赖等待前置任务真正完成。包验证和发行共用完整 wrapper 装配；CI smoke 使用明确的隔离 home 与退出清理。                                                                             |
| 编译后的 namespace  | 同名 namespace 的别名导入在 Bun bundle 内发生错误绑定：完整产品生命周期递归，模型 schema 与业务工作流委托也受影响。按职责区分 `ProductRuntimeHandle`、`ModelsCatalog`、`WorkflowSessionService`，更新全部消费者，并增加真实 bundle 回归与完整二进制 CI 执行验收。 |
| Library 完成时序    | 经验编码仍有模型调用时，执行账本已经结算。完成贡献返回并等待完整异步工作，包括嵌套奖励计算；核心保持通用贡献接口，完整产品继续启用 Library。                                                                                                                      |
| 普通 workspace 构建 | Turbo 依赖构建误触发跨平台二进制发行，导致本机缺少其它平台 sandbox 资产时测试失败。CLI/Product Runtime 的普通 `build` 编译 `dist/modules`，显式 `script/build.ts` 保留二进制发行职责。Web 重命名后的文件标题测试期望同步为新目录名。                              |

设计依据见[验证稳定性](../decisions/implemented/bug-fix/2026-09-08-validation-source-stability-and-gate-order.md)、[编译 namespace 所有权](../decisions/implemented/bug-fix/2026-09-08-compiled-runtime-namespace-ownership.md)和[完成贡献结算](../decisions/implemented/bug-fix/2026-09-08-await-completion-context-contributions.md)。核心生命周期、业务算法、宿主实现与界面职责见[架构总览](../architecture/README.md)。用户安装名称、`synergy` 命令、配置和数据路径不因源码目录迁移改名。

## 源码与公开包核对

- [迁移映射](2026-09-08-runtime-package-ownership.json)重新核对：基线 5,557 个文件，3,262 个移动项、2,295 个路径不变、3,261 个不同移动目标，缺失目标为 0；Agenda 的唯一合并保留具体理由。
- 扫描跟踪文件中的目录字面量，并以 TypeScript AST 检查可静态求值的路径表达式。构建输出、虚拟模块、外部工具路径与故意引用旧路径的负向测试分别核查；历史记录不做盲目替换。
- 按真实 cwd 核对 workspace scripts 与 GitHub workflows 中 119 个显式源码命令入口，没有缺失入口。文档检查覆盖本地 commands、所有 workspace README/AGENTS，包括 apps 与嵌套 SDK。
- 22 个本次构建的归档中，765 个公开入口、2,219 个条件导出目标均可解析或定位实际文件；通配导出按实际归档文件展开。解析路径不回落到仓库；核心 8 个公共入口另在真实安装后加载，私有和测试入口拒绝解析。
- 333 个原有 API operation ID、path/method 全部保留；Config、Session、ScopeBootstrapResponse、ManagedProjectArchiveError、NoteConflictError 与迁移前精确一致。SDK 生成契约检查通过。

## 运行、安装与开发验收

| 验证                     | 结果                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实际 npm 安装            | 本次 full 平台包与 wrapper 经临时 registry 下载，以真实 npm 安装并执行生命周期脚本。局部安装、隔离的全局 prefix、版本和领域帮助均通过；全局安装的二进制与已验证产物字节一致。没有替换机器上正在使用的全局安装。  |
| 完整产品二进制           | 6 场景、49 断言：模型协议、真实 shell 与文件工具、权限、预算、取消恢复、JSON/ZIP 导入导出和账本；默认 Library 保持启用。                                                                                         |
| 核心二进制与 CLI tarball | 两者分别通过同一套 6 场景、49 断言。源码完整装配也通过相同执行流程。                                                                                                                                             |
| 能力组合                 | core、core + Browser、core + Library、core + Notes、Computer 独立服务与 full 均从实际 tarball 在仓库外安装、持久化操作、关闭资源并退出。                                                                         |
| Web 与源码开发           | `bun dev server` 健康检查、`bun dev app` 的 HTML 与 Chromium 渲染通过；生产 private HTTP 在非安全上下文、没有 randomUUID 的情况下正常启动，页面错误为空。                                                        |
| Desktop                  | 当前 full 产物重新打包；源码托管后端启动、重启和停止通过。标准套件 245 pass、746 断言，5 个既有条件测试保留；其中原生浏览器场景另显式执行。                                                                      |
| Browser                  | 真实 Electron 2 测试、13 断言通过，覆盖 renderer 崩溃恢复、两种创建次序及协议/CDP 控制。WebRTC/data channel 由对应 Browser/Web 标准套件覆盖。                                                                    |
| 完整资源与独立 Host      | 复制到仓库外的 full 产物可加载 Playwright Core 1.61.0 并初始化 ONNX。独立 Host ZIP 打包通过；ASAR 为 615,685 bytes，只有 dist、宿主入口和 package.json，不含 Harness、Library、Computer driver 或 node_modules。 |
| Link                     | 模块与本机二进制构建通过；相关 CLI、协议及生命周期标准测试通过。                                                                                                                                                 |

组合安装曾遇到第三方 `@ai-sdk/openai` 下载内容的完整性校验失败；保留校验，用新隔离缓存重试后通过，未修改依赖版本或关闭校验。模块闭包测试使用禁止安装脚本的依赖安装方式；完整产品的 npm 生命周期安装另作真实验收，不能混为同一项。

开发命令仍由仓库根 `bun dev` 编排，常用入口是 `bun dev prepare`、`bun dev web` 和 `bun dev desktop --managed`。具体模式、独立 home、端口与凭据处理遵循[开发参考](../reference/development.md)和 [develop-synergy](../../.synergy/skill/develop-synergy/SKILL.md)，不把测试临时路径写入用户配置。

## 标准测试与覆盖率

- 非 Harness workspace 的 Turbo 标准图：47/47 构建与测试任务成功，0 个缓存命中。
- Harness 最终 CI 编排：3,525 pass、9,854 断言，无失败或跳过。
- 根脚本与发行契约：303 pass、935 断言；包括 installer、wrapper、SDK 验证及 CI 拓扑测试。
- 16 项静态质量门禁通过，包含类型、格式、lint、依赖、公开包、文档、决策、Skills、指南、工作流及生成契约。

完整覆盖率于 `2026-09-08T06:10:53.335Z` 至 `2026-09-08T06:23:27.268Z` 执行，27 个包的覆盖率命令和原有门槛全部通过。纳入指纹核对的 5,515 个非 Markdown、非 docs 文件在执行前后完全一致：`0e2aa355465a8a4eb8204a21e297250600ea129085eaae55289316f28f098a65`。报告来自本次完整执行，不复用旧覆盖率报告；未降低门槛或增加跳过条件。

| Workspace                      | 行覆盖率 | 函数覆盖率 | 门槛：行/函数 | 缺失受检文件 |
| ------------------------------ | -------- | ---------- | ------------- | ------------ |
| apps/desktop                   | 90.30%   | 79.73%     | 60/50         | 0            |
| apps/web                       | 65.37%   | 78.30%     | 60/50         | 0            |
| packages/agent-integrations    | 75.08%   | 78.00%     | 75/75         | 0            |
| packages/browser               | 91.22%   | 94.33%     | 80/75         | 0            |
| packages/browser-runtime       | 76.15%   | 81.67%     | 75/75         | 0            |
| packages/cli                   | 76.16%   | 75.57%     | 75/75         | 0            |
| packages/computer              | 100.00%  | 100.00%    | 80/75         | 0            |
| packages/computer-runtime      | 92.37%   | 83.33%     | 75/75         | 0            |
| packages/connections           | 75.96%   | 81.99%     | 75/75         | 0            |
| packages/harness               | 80.09%   | 83.63%     | 75/75         | 0            |
| packages/library               | 75.93%   | 84.08%     | 75/75         | 0            |
| packages/media                 | 87.52%   | 92.80%     | 75/75         | 0            |
| packages/note                  | 82.17%   | 85.49%     | 75/75         | 0            |
| packages/plugin                | 94.24%   | 89.95%     | 80/75         | 0            |
| packages/plugin-host           | 79.54%   | 76.00%     | 75/75         | 0            |
| packages/plugin-kit            | 81.11%   | 88.89%     | 80/75         | 0            |
| packages/product-runtime       | 80.44%   | 80.69%     | 75/75         | 0            |
| packages/runtime-local         | 77.18%   | 81.40%     | 75/75         | 0            |
| packages/sdk/js                | 87.28%   | 100.00%    | 80/75         | 0            |
| packages/server                | 89.00%   | 75.00%     | 75/75         | 0            |
| packages/synergy-link          | 80.27%   | 89.08%     | 80/75         | 0            |
| packages/synergy-link-protocol | 92.42%   | 100.00%    | 80/75         | 0            |
| packages/testing               | 95.17%   | 91.11%     | 75/75         | 0            |
| packages/ui                    | 68.98%   | 81.38%     | 60/50         | 0            |
| packages/util                  | 86.77%   | 91.15%     | 80/75         | 0            |
| packages/workbench             | 89.96%   | 83.79%     | 75/75         | 0            |
| packages/workflows             | 77.85%   | 77.04%     | 75/75         | 0            |

## 验收边界与保存

本机为 macOS arm64、Bun 1.3.14。Linux/Windows 及其它架构的原生执行、跨平台安装器、代码签名、公证和远端 GitHub CI 没有在本机实际执行，不计作已通过。CI/CD 配置、依赖图、发行脚本和本机产物已验证，但未运行正式发布。真实邮件账号、所有外部模型/MCP 供应商和用户 OS 自动化动作没有逐个调用；现有功能由所属领域测试与上述实际运行验收覆盖，不能据此声称所有外部环境下绝无问题。

实现已按问题分批本地提交：`9ab062eeb`、`5c03dfcbd`、`5c9bed6b7`、`d9a2071c1`、`930506962`。详细日志、失败复现和安装摘要保存在任务私有记录中。未推送、开 PR、正式发布或操作用户正在使用的 Synergy 实例。
