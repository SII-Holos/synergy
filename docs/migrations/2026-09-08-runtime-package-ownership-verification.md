# 全仓业务分离迁移验收记录

本记录对应迁移基线 `e11c17094` 及本次迁移代码。目录职责见[架构所有权图](../architecture/README.md#ownership-map)，逐文件去向见[迁移映射](2026-09-08-runtime-package-ownership.json)。本次保持唯一 `synergy` CLI，完整产品仍默认装配全部能力；Harness 和 Runtime Local 可由独立程序及同一 CLI 使用。

后续源码、开发流程与实际完整产品安装审计见[修复后全仓验收](2026-09-08-runtime-package-ownership-audit.md)；该记录包含后续实现提交及重新执行的完整覆盖率。本记录保留首轮验收快照。

## 迁移核对

基线的 5,557 个跟踪文件全部核对：3,262 个移动项、2,295 个路径未变、3,261 个不同的移动目标，缺失目标为 0。唯一的两处合并是 Agenda 信号实现归入 Workflows；映射记录具体原因。旧聚合包已移除。所有 27 个 workspace 具备所属包指南；源码、测试、fixtures、worker、资产和注册入口随业务所有者迁移。

Harness 的主要公共入口为 session、scope、tools、context、lifecycle、config、persistence 和 rollout，额外宿主接口逐项声明。依赖检查覆盖静态导入、动态导入、类型查询、模块扩展和 worker URL；私有跨包引用与依赖违规为 0。处理器、解析器、调度器和底层 journal 未作为生产入口发布，测试接口不会进入 tarball。

## 运行与安装验收

| 验证面           | 已通过结果                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 核心安全 CI      | 3,523 测试、9,850 断言；使用隔离测试 home                                                                              |
| 独立 CLI tarball | 6 场景、49 断言：模型协议、真实文件与 Shell、权限、预算、取消与恢复、JSON 与 ZIP 导入导出、执行账本                    |
| 编译核心二进制   | 同一 CLI 的 6 场景、49 断言通过；取消后可重新取得 home 锁                                                              |
| 独立组合         | core、Browser、Library、Notes、Computer、full 均在仓库外安装实际 tarball 后运行和退出                                  |
| 安装解析         | 8 个核心公共入口可加载；旧私有入口和测试入口拒绝解析；模块 realpath 不逃出临时安装目录；清除 NODE_PATH 与 NODE_OPTIONS |
| 数据兼容         | 已加载领域执行原 migration ID；未加载领域的旧日志与未知持久化字段保留；反复启动、注册锁定、领域恢复和导入导出测试通过  |
| 领域调用         | 业务工具和路由使用所属服务；嵌套插件工具保持权限、调度、取消及证据记录；单并发槽不会死锁                               |
| SDK              | 333 个原有 operation ID 和对应 path/method 保留；Config、Session、ScopeBootstrapResponse 与既有错误 schema 精确一致    |

安装使用最终 SDK 生成后的 22 个实际归档，通过临时本地 registry 提供正常包版本，第三方依赖来自 npm。核心安装包含 156 个依赖包，安装闭包没有 Browser、Library、MCP 或 Electron。Library 验证真实 SQLite 与向量写读；Browser 组合验证持久化 owner 恢复和无隐式 Chromium 启动；Computer 组合验证独立 HTTP 服务。完整产品组合验证实际 HTTP 健康检查与完整 OpenAPI。第三方 sharp、canvas 等包下载或解包曾失败，保留失败记录并使用新隔离缓存重试。Full 的成功重试将下载并发从 48 降到 8，其余组合此前使用默认并发；安装验收脚本最终保留 8 并发限制。没有绕过完整性校验或更换 Synergy 归档。

SDK 的剩余文本差异是六个领域枚举的次序、Event 分支次序和 SessionEndpoint 描述；没有删除操作或 schema。配置 schema 生成器同时验证 core/full 的 JSON 语义及仓库格式，构建不会重新生成格式不合规文件。

## 产物验收

| 产物          | 本机验证                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core          | Darwin arm64 二进制 138,889,442 bytes；严格资源清单通过，未携带 Web、Playwright、ONNX 或 Holos 产品资产                                                 |
| Full + Web    | Darwin arm64 二进制 190,852,706 bytes；完整资源清单和生产 Web 构建通过                                                                                  |
| 仓库外 Full   | 复制产物到独立目录后，版本命令、实际 Playwright 模块加载与 ONNX WASM 初始化通过                                                                         |
| Desktop       | unsigned Darwin arm64 打包通过，托管 Full 资源清单通过；标准套件覆盖 managed/remote 与托管进程生命周期                                                  |
| Browser Host  | 独立 ZIP 打包通过；实际 app.asar 为 615,685 bytes，恰有 dist 目录、入口 bundle、package.json 三项，无 Harness、Library、Computer driver 或 node_modules |
| 浏览器呈现    | 真实 Electron 2 测试、13 断言覆盖 renderer 崩溃恢复、两种创建顺序、Host 协议和 CDP；Browser/Web 套件验证 WebRTC 与 data channel                         |
| Web 私有 HTTP | 非安全上下文生产页面完成渲染，缺少 randomUUID 时仍正常，pageErrors 为空                                                                                 |
| Link          | 模块与 Darwin arm64 二进制构建通过，实际版本命令通过                                                                                                    |

上述大小是磁盘字节数，不表示运行内存。Browser Host ZIP 的 Electron 框架仍占发行体积；小型 ASAR 验证的是应用依赖已分离。Playwright 资源检查验证模块加载，实际 Chromium 生命周期由 Electron 测试验证。

## 全仓测试与覆盖率

完整覆盖率执行时间：`2026-09-07T22:02:04.606Z` 至 `2026-09-07T22:14:53.890Z`。本次从清理后的报告开始，所有 27 个包的标准覆盖率命令成功后才合并同次执行的共享源码命中。源码及配置指纹在执行前后均为 `0f7523ace3437652fdc8545d2a8d554c330f57091ffec1d7de50819c49108123`，文件数 5509，指纹一致。各包原有门槛保持，未通过跳过测试、宽泛 mock 或降低门槛消除失败。

| Workspace                      | 行覆盖率 | 函数覆盖率 | 门槛：行/函数 | 未加载源码文件 |
| ------------------------------ | -------- | ---------- | ------------- | -------------- |
| apps/desktop                   | 90.16%   | 79.57%     | 60/50         | 0              |
| apps/web                       | 65.37%   | 78.30%     | 60/50         | 0              |
| packages/agent-integrations    | 75.08%   | 78.00%     | 75/75         | 0              |
| packages/browser               | 91.22%   | 94.33%     | 80/75         | 0              |
| packages/browser-runtime       | 76.12%   | 81.50%     | 75/75         | 0              |
| packages/cli                   | 76.16%   | 75.57%     | 75/75         | 0              |
| packages/computer              | 100.00%  | 100.00%    | 80/75         | 0              |
| packages/computer-runtime      | 92.37%   | 83.33%     | 75/75         | 0              |
| packages/connections           | 75.96%   | 81.99%     | 75/75         | 0              |
| packages/harness               | 80.09%   | 83.61%     | 75/75         | 0              |
| packages/library               | 75.93%   | 84.48%     | 75/75         | 0              |
| packages/media                 | 87.52%   | 92.80%     | 75/75         | 0              |
| packages/note                  | 82.17%   | 85.49%     | 75/75         | 0              |
| packages/plugin                | 94.24%   | 89.95%     | 80/75         | 0              |
| packages/plugin-host           | 79.54%   | 76.00%     | 75/75         | 0              |
| packages/plugin-kit            | 81.11%   | 88.89%     | 80/75         | 0              |
| packages/product-runtime       | 80.44%   | 80.69%     | 75/75         | 0              |
| packages/runtime-local         | 76.86%   | 81.39%     | 75/75         | 0              |
| packages/sdk/js                | 87.28%   | 100.00%    | 80/75         | 0              |
| packages/server                | 89.00%   | 75.00%     | 75/75         | 0              |
| packages/synergy-link          | 80.29%   | 89.21%     | 80/75         | 0              |
| packages/synergy-link-protocol | 92.42%   | 100.00%    | 80/75         | 0              |
| packages/testing               | 95.17%   | 91.11%     | 75/75         | 0              |
| packages/ui                    | 68.98%   | 81.38%     | 60/50         | 0              |
| packages/util                  | 86.77%   | 91.15%     | 80/75         | 0              |
| packages/workbench             | 89.96%   | 83.79%     | 75/75         | 0              |
| packages/workflows             | 77.85%   | 77.04%     | 75/75         | 0              |

覆盖率豁免随原文件迁移；额外精确豁免仅用于三个纯类型契约和两个通过真实子进程及产物行为验证的 worker 入口。Bun 不合并子进程覆盖率，因而这些 IPC 入口以行为验收补充。既有平台或环境限定测试保持原条件，未新增 skip 来接受迁移失败。

静态质量检查包含格式、lint、类型、依赖、manifest、包指南、测试布局、文档、决策、Skills、本地化、生成资产、公开包和工作流等 16 项。根脚本 289 测试、866 断言通过，其中包含 release 契约；浏览器 crypto、生成文档和 API 契约另行核验。详细本机日志和归档摘要保留在任务私有记录中；共享仓库不记录个人运行路径、home 或凭据。

## 本机验收范围

本机环境为 macOS arm64、Bun 1.3.14。没有执行其他平台的签名、公证、安装器和原生运行验证，Linux/Windows 及其他架构仍需对应 CI；这些不计作已通过。没有以实际用户 OS 自动化操作替代 Computer 驱动的单元及打包检查，也未逐一调用外部邮件、MCP 或 LLM 供应商的生产账号。

所有运行验证使用独立 home、明确或测试分配的端口和任务所属进程。没有操作承载当前任务的 Synergy 实例。本报告记录提交前的验收快照；验收过程中没有推送、PR、正式发布或签名操作。

## 开发启动复查与修正

提交后的实际启动复查发现，根开发编排器、Desktop 源码托管后端、运行时内存基准和 sandbox helper 工作流仍引用旧目录。此前产物和覆盖率验收不能证明这些源码入口可运行；原报告中的已通过项目应按其具体范围理解，不代表全部启动方式均已验证。

修正将开发和基准目录接到 typed catalog，恢复 Desktop 对完整产品源码入口的定位，并修复 helper 工作流和准备命令。helper 本地安装同时遵守隔离 home。回归测试检查真实 checkout 中的命令入口，读取实际工作流执行跨平台 helper dry-run，并覆盖 Desktop 源码定位和隔离安装路径。

修正后，在独立 home 和测试分配端口实测根 `bun dev server` 健康检查、`bun dev app` 页面加载及 Chromium 完整渲染，页面无未捕获错误；Desktop 源码托管后端启动、重启和关闭均通过。测试进程及临时 home 已清理。本次未重新执行完整 Electron 界面冷启动、所有生产账号集成或远程跨平台 CI；不能把源码后端检查当成这些项目的通过结果。上文完整覆盖率结果保留为原迁移提交的验收快照。

复查修正通过 16 项静态质量门禁、根脚本 298 测试／923 断言、Desktop 245 测试／746 断言（5 项原有环境条件 skip）、helper 6 测试／21 断言和开发编排 14 测试／56 断言；Desktop 与 Browser Host 源码构建通过。运行时内存基准的 trajectory smoke 完成执行并自行清理。根脚本第一次与静态门禁并行运行时有两项文档生成测试触发原有 5 秒超时，停止重叠运行后整套通过；没有修改超时或跳过测试。
