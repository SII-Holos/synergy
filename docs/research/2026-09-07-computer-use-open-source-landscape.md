# Computer Use 开源实现调研

This investigation includes alternatives considered before selecting native, window-targeted background integration. The [native Computer decision](../decisions/implemented/feature/2026-09-07-first-party-computer-use.md) owns the selected scope.

## 问题、范围与证据

调研日期：2026-09-07。问题是哪些开源组件能用于 Synergy 的正式 Computer Use 能力，尤其是 macOS 原生应用控制。产品约束与架构建议以 [Computer Use 提案](../decisions/implemented/feature/2026-09-07-first-party-computer-use.md) 为准：仅 Full Access、按应用窗口操作、仅在单次操作期间处理同应用冲突，复用现有任务取消和模型循环。正式实现不增加任务级桌面独占或单独的停止与接管面板。

本次检查了上游 README、许可证、仓库元数据，并深入阅读 Cua 的嵌入进程管理以及 Peekaboo 的 Bridge 停止实现和相关测试。文中的“源码存在”“上游声明”和“建议”分别表示不同证据强度。没有安装、编译或运行候选的桌面服务，没有执行真实输入，也没有验证上游测试通过。默认分支快照不等同于正式发布版本；仓库活跃度和 benchmark 宣传不能替代 Synergy 的验收。

## 结论

建议保留 Cua Driver 与 Peekaboo 两个 macOS 验证候选。Cua 更接近可以嵌入其他产品的驱动，Peekaboo 提供值得复用的 macOS 操作、窗口证据和取消处理。优先验证 Cua 私有 daemon 的打包和生命周期，再用同一组用例对比 Peekaboo；验证结束后只选一个生产后端。完整 Agent 框架、视觉定位模型和 VM 管理器分别解决不同问题，不应作为同一种依赖横向排名。

Synergy 应拥有任务身份、Full Access 准入、跨 runtime 的桌面租约、Stop/接管状态、证据和 UI。上游驱动负责发现应用、读取辅助功能树、截图和输入。具体宿主和执行器布局根据选定驱动调整；不预先要求重新实现 Swift 驱动，也不先构建多后端切换框架。

## 开源方式如何区分

| 方式                 | 代表                                                              | 开放了什么                                     | 对 Synergy 的作用                                                          |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| 原生驱动、SDK 或 MCP | Cua Driver、Peekaboo、Terminator、Windows-MCP、computer-use-linux | 操作系统观察与操作，部分包含权限宿主和生命周期 | 最直接的复用层；MCP 只是调用协议，不能自动提供任务租约或停止保证           |
| 输入基础库           | PyAutoGUI、nut.js                                                 | 鼠标、键盘、截图与部分图像匹配                 | 原型或局部基础设施；需要自行补齐应用身份、证据、权限宿主和取消             |
| 完整 Agent           | UI-TARS Desktop、Agent S、UFO                                     | 模型循环、规划、动作转换、工具和产品界面       | 借鉴动作表达、定位和评测，整体接入会重复 Synergy 已有能力                  |
| 视觉解析或定位模型   | OmniParser、UI-TARS grounding                                     | 将截图转为元素或坐标                           | 是观察和定位的补充，不能替代真实输入驱动；代码、权重和推理服务需要分别评估 |
| 隔离桌面与实验环境   | Cua Lume、Anthropic computer-use-demo                             | VM 生命周期或容器内桌面、VNC、示例循环         | 适合后续独立电脑和回归环境；不等于操作当前登录桌面                         |

初版不要求专用 Computer Use 模型。原生辅助功能树和截图可以作为现有工具结果进入 Synergy 的模型循环；画布、图标和缺少辅助功能信息的界面才需要更强的视觉定位。专用定位服务是否值得引入，应由实际错误类型、延迟和成本决定。

## 候选比较

| 项目                             | 已核实的定位与接口                                                                        | 许可证证据与限制                                                                        | 选型建议                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cua Driver [S1]                  | Rust 驱动；stdio MCP、CLI、TypeScript/Python UniFFI SDK、私有嵌入宿主；本次重点检查 macOS | 仓库 MIT；仍需检查采用版本的依赖、素材及产物                                            | 第一验证候选，优先使用受监督的私有进程                         |
| Peekaboo [S2]                    | macOS Swift 自动化模块、CLI、MCP、菜单栏宿主，包含自己的可选 Agent                        | 根 LICENSE 为 MIT；构建涉及子模块，需逐项固定和核实                                     | 第二验证候选；仅复用自动化与宿主相关模块                       |
| opensymph/open-computer-use [S3] | 原生 MCP/CLI；macOS 使用应用宿主与本地 socket                                             | 根声明 MIT，但 notices 明确包含从 Codex 提取的光标图片；macOS 部分路径使用私有 SkyLight | 备用候选；替换未建立分发授权的素材并验证原生路径后再考虑采用   |
| Terminator [S4]                  | Windows UI 自动化，Rust 与 Node SDK、MCP                                                  | GitHub 根许可证元数据为 MIT；当前 README 明确仅支持 Windows                             | Windows 后续优先评估，不当作 macOS 候选                        |
| Windows-MCP [S5]                 | Windows 辅助功能树和桌面操作的 Python MCP                                                 | LICENSE.md 为 MIT；README 声明默认收集使用遥测，可配置关闭                              | Windows MCP 路线候选；需裁剪与 Computer 无关工具并检查遥测行为 |
| computer-use-linux [S6]          | Rust MCP/CLI，AT-SPI、Wayland portal、按 compositor 区分窗口管理，提供结构化 doctor       | 根元数据与 README 声明 MIT；依赖外部输入组件和桌面权限                                  | Linux 候选；不能把一个 compositor 的验证推广到全部 Linux       |
| UI-TARS Desktop [S7]             | UI-TARS 桌面应用及 Agent TARS，包含本地/远端 computer 和 browser operators                | 根元数据与 README 声明 Apache-2.0；具体 operator 依赖仍需审查                           | 借鉴动作转换和观察组织；暂不整合其 Agent/Browser 产品          |
| Agent S [S8]                     | Python Agent 框架，主模型与 grounding 模型分离，示例通过 PyAutoGUI 执行                   | 根元数据为 Apache-2.0；模型和托管产品分别审查                                           | 借鉴视觉定位与失败评测；benchmark 不证明驱动的停止能力         |
| UFO [S9]                         | UFO² Windows UIA/Win32/COM 自动化；Galaxy 加入多设备 Agent 编排                           | 根元数据为 MIT                                                                          | 借鉴 Windows 混合 API/UI 动作，不引入另一套编排                |
| PyAutoGUI [S10]                  | Python 跨平台鼠标、键盘和截图库                                                           | 根元数据为 BSD-3-Clause                                                                 | 适合对照原型；不承担正式产品的应用定位和桌面所有权             |
| nut.js [S11]                     | Node 原生自动化库；README 区分源码构建和订阅预编译包，所检查文档只支持 X11 而非 Wayland   | GitHub 根许可证元数据为空，不能据此判定授权；本次未建立完整源码及预编译依赖许可证链     | 与 TS 接近不代表集成最便宜；先核实依赖构建、许可证与维护版本   |
| OmniParser [S12]                 | 将截图解析成可定位元素；OmniTool 示例另含 Windows VM 控制                                 | README MIT 徽章与根 LICENSE 的 CC-BY-4.0 不一致；检测及描述权重另有说明                 | 后续视觉增强候选，先按具体代码和权重版本澄清授权               |
| Anthropic quickstarts [S13]      | Docker 内 Linux X11/VNC 桌面与示例模型循环                                                | 根元数据 MIT；开放示例不代表模型权重或完整产品开源                                      | 适合隔离环境和动作/图像处理参考                                |

## 两个 macOS 候选的源码证据

### Cua Driver

`libs/cua-driver/README.md` 区分 MCP/CLI 与应用 SDK：SDK 可以在应用进程内加载原生 runtime，也提供连接 daemon 的方式。Synergy 应先验证独立执行进程，以免原生调用阻塞控制面。文档还明确区分独立 CuaDriver.app、direct MCP 和嵌入宿主的 macOS 权限归属；嵌入 daemon 必须处于持有权限的应用责任链中，不能简单由无关 gateway 代为启动。[S1]

`EmbeddedCuaDriverHost` 已有启动 generation、父进程存活管道和 `kill_on_drop`。其 `finish_stop()` 先关闭存活管道，等待配置的退出期限，再尝试终止子进程并等待回收。这提供了实际进程生命周期机制，强于只关闭一个 MCP 客户端。但这里管理的是一个嵌入进程，不是 Synergy 跨 home、跨任务的完整桌面租约；停止等待被取消、执行器派生进程、按键释放和原生事件已入队时的行为仍需验证。[S1a]

CLI `stop.rs` 使用 `shutdown_if_pid`，并检查 socket 是否释放。该检查可以避免误停一个不匹配 PID 的 daemon，但 socket 消失本身不证明桌面输入全部结束，不能直接映射为产品“已停止”。[S1b]

建议探针：从签名的 Synergy Desktop 责任链启动私有 daemon；观察权限归属；启动两个隔离 Synergy runtime 竞争同一登录桌面；在长输入、截图阻塞和宿主崩溃时测量撤销效果。Cua 权限模式在进程启动时固定，Synergy 仍要在每次调用时检查有效 Full Access，并在降级时撤销任务；不能依赖修改共享 daemon 的模式代替任务准入。[S1]

### Peekaboo

Peekaboo 将自动化、Core/Bridge、CLI 和 macOS 应用拆为可检查模块。README 声明精确窗口观察、元素标识、后台动作的观察前提以及前台动作的显式策略。这些适合借鉴；Synergy 初版仍采用已约定的独占前台控制，不因上游宣称后台操作而承诺人机同时使用。[S2]

`PeekabooBridgeHost.stopOnce()` 停止接收、取消请求并断开连接。请求未能在期限内排空时，它返回 `ownershipRetained`，保留 socket 所有权，等待实际排空后才释放。`PeekabooBridgeCancellationTests` 覆盖超时排队请求不执行、跨进程锁解除后已取消请求不执行，以及非协作请求未结束时不能启动替代宿主。这些是具体实现和测试用例存在的证据，本次没有运行这些测试。[S2a, S2b]

关键区别是“保留所有权直到旧请求结束”可以防止两个宿主同时执行，却不等于“旧请求立即停止”。socket 租约也不天然等于整台登录桌面的任务租约。需要核实请求取消如何到达原生输入循环，并让独立停止路径能够阻止剩余事件；不能仅将 Bridge 的取消成功显示为停止完成。

建议探针：尝试只构建自动化/Bridge 与最小宿主，不携带其 Agent UI；验证稳定签名身份、socket 客户端认证和协议版本；复用其取消情形构建 Synergy 验收，再补长输入中断、人工接管、跨 runtime 任务所有权及进程崩溃测量。已有测试提供了很好的起点，但不是免测依据。

## 容易混淆的复用条件

### 开源源码、素材、模型和发布包

Codex 本机 Computer Use 插件声明 Proprietary，存在 MCP 入口并不意味着其原生实现开放。上次检查的内部 JS 依赖宿主能力和策略接口；相关证据保留在提案，不把本机文件复制进仓库。OpenAI 的 MIT `openai-cua-sample-app` 是另一份示例工程，也不建立 Codex 私有原生服务的分发权。[S14]

open-computer-use 的第三方说明明确标出了提取自 Codex 的光标资源，以及从 Cua/yabai 衍生的 macOS 事件路径。因此应逐项处理素材与原生代码来源，而不是据根 MIT 标签整体放行。未评估的私有 macOS API 不用于承诺跨系统版本的稳定后台控制。[S3]

OmniParser 的当前 README 区分新 `icon_detect_v3` 路线、较早 Ultralytics 检测器和 caption 模型的授权说明，同时根 LICENSE 与 README 徽章存在不一致。本次没有完成权重仓库审查；采用时必须锁定确切代码、权重、推理依赖及各自许可，不能笼统标为“MIT 模型”。[S12]

### 后台输入与独立电脑

Cua/Peekaboo 的后台窗口操作仍发生在同一个登录桌面，焦点、菜单、输入法、剪贴板和应用全局状态都可能耦合。窗口可后台点击不代表多个任务可以任意并发。首版继续保持一个任务的控制权；该承诺约束通过 Synergy 管理的 Computer 输入，不是对 Full Access 进程或其他本地自动化软件的操作系统隔离。

Cua Lume 则提供基于 Apple Virtualization Framework 的 macOS/Linux VM 管理。它可以用于以后独立桌面和原生回归环境，但会引入镜像、资源、登录态、文件交换和展示需求。本次不将其作为控制用户现有桌面的前置条件。其 README 声明默认遥测，采用时应按 Synergy 自身产品策略处理。[S15]

### MCP 包装与正式产品集成

MCP 可缩短协议适配路径，但一个通用 MCP 服务器可能附带 shell、浏览器、文件或安装系统组件的工具。应只映射选定的观察/输入操作进入 Synergy Computer 工具，保留现有 Browser 和其他领域的实现。尤其是 Linux 候选的 setup 会涉及系统组件和桌面设置，不能将安装脚本作为普通观察命令运行。[S6]

驱动取消不应触发自动重试未知结果的点击或输入。允许观察重试需要重新检查租约和目标；动作结果丢失应标记不确定，重新观察后由当前任务决定下一步。对已交给目标应用执行的上传、保存等业务动作，Stop 只能停止后续自动化输入，不能承诺撤回已经产生的效果。

## 下一步验证及退出条件

| 验证           | 需要得到的证据                                                                             | 不通过时的处理                                       |
| -------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 固定源码与构建 | 源码、子模块、依赖、素材和二进制的版本与许可清单；能够构建最小宿主                         | 采用可验证版本或保留为参考，不把默认分支当发布依赖   |
| 权限与打包     | 新装、拒绝授权、撤销权限、签名更新后权限归属与错误一致                                     | 先解决宿主身份，不加不透明的启动绕路                 |
| 登录桌面所有权 | 两个 home、两个 runtime、不同任务与旧进程竞争时仅一个可以派发输入                          | 在选定宿主补缺失的仲裁，不能只在单个 server 加 mutex |
| 停止与接管     | 长输入、拖拽、截图/AX 阻塞、控制面卡住时，测量 Stop 到禁止后续派发的延迟分布；验证按键释放 | 修补执行器取消和独立停止路径，必要时更换驱动         |
| 崩溃与恢复     | 断连接、父进程退出、执行器未退出、旧 generation 回包和重连均不恢复旧动作                   | 保留未完成状态和所有权，明确显示故障，禁止盲重放     |
| 真实应用覆盖   | 原生文本框、Electron 应用、系统弹窗、菜单、中文输入、多显示器和缩放                        | 明确支持范围与结构化失败，避免从单个示例推导通用能力 |

先运行不接触桌面的编译和协议检查，再在任务专用宿主与受控 fixture 中验证输入。停止延迟和成功率在完成测量前保持未验证，不给出估算数字冒充结果。若两个候选都能满足要求，按额外宿主代码量、打包复杂度和长期跟进成本选择，而不是按项目星数或完整 Agent 的 benchmark 排序。

## 上游来源定位

以下是本次阅读的第一方来源；默认分支地址用于定位调查证据，采用时需换成经过构建验证的提交或发布版本。仓库 README 的平台与许可证说明属于上游声明，表中单独注明深入源码检查的部分。

| 标识 | 来源                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `https://github.com/trycua/cua/blob/e926a34a9ac5283f17c414f17c4992e0a09d106e/libs/cua-driver/README.md`；根 `LICENSE.md`                                            |
| S1a  | `https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cua-driver-sdk/src/embedded.rs`，`EmbeddedCuaDriverHost`、`finish_stop`、`StopTransitionGuard` |
| S1b  | `https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cua-driver/src/stop.rs`                                                                        |
| S2   | `https://github.com/openclaw/Peekaboo`，`README.md`、`LICENSE`                                                                                                      |
| S2a  | `https://github.com/openclaw/Peekaboo/blob/main/Core/PeekabooCore/Sources/PeekabooBridge/PeekabooBridgeHost.swift`，`stopOnce`                                      |
| S2b  | `https://github.com/openclaw/Peekaboo/blob/main/Core/PeekabooCore/Tests/PeekabooTests/PeekabooBridgeCancellationTests.swift`                                        |
| S3   | `https://github.com/opensymph/open-computer-use`，`README.md`、`docs/ARCHITECTURE.md`、`THIRD_PARTY_NOTICES.md`                                                     |
| S4   | `https://github.com/mediar-ai/terminator/blob/main/README.md`，平台支持表                                                                                           |
| S5   | `https://github.com/CursorTouch/Windows-MCP`，`README.md`、`LICENSE.md`                                                                                             |
| S6   | `https://github.com/agent-sh/computer-use-linux/blob/main/README.md`，支持矩阵、doctor、安装与工具说明                                                              |
| S7   | `https://github.com/bytedance/UI-TARS-desktop/blob/main/README.md`                                                                                                  |
| S8   | `https://github.com/simular-ai/Agent-S/blob/main/README.md`，grounding 配置与 Python 示例                                                                           |
| S9   | `https://github.com/microsoft/UFO/blob/main/README.md`，UFO² 与 Galaxy 区分及平台说明                                                                               |
| S10  | `https://github.com/asweigart/pyautogui/blob/master/README.md`                                                                                                      |
| S11  | `https://github.com/nut-tree/nut.js/blob/develop/README.md`，源码构建、订阅预编译包及 Linux 限制                                                                    |
| S12  | `https://github.com/microsoft/OmniParser/blob/master/README.md` 与 `https://github.com/microsoft/OmniParser/blob/master/LICENSE`                                    |
| S13  | `https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/README.md`                                                                            |
| S14  | `https://github.com/openai/openai-cua-sample-app`；本机 Codex 插件证据见提案                                                                                        |
| S15  | `https://github.com/trycua/cua/blob/main/libs/lume/README.md`                                                                                                       |

## 调查时的仓库快照

以下提交来自 GitHub API 的默认分支元数据，记录日期用于识别调查基线，不代表发布日期或全部文件的哈希校验；上面部分文件通过默认分支 URL 读取。没有用最近 push 时间推断稳定性或维护承诺。

| 仓库                            | 默认分支提交                               | 提交日期（UTC） |
| ------------------------------- | ------------------------------------------ | --------------- |
| `CursorTouch/Windows-MCP`       | `08ddee78c26182b103d62c1c84c1fbec82a280b2` | 2026-09-06      |
| `agent-sh/computer-use-linux`   | `c9ab855e5d35420faafadc41a7ab0474b26358a2` | 2026-09-05      |
| `anthropics/claude-quickstarts` | `3313e9716fb5b977248bcd06cb0cc86a8c547b9b` | 2026-08-25      |
| `asweigart/pyautogui`           | `b4255d0be42c377154c7d92337d7f8515fc63234` | 2023-06-07      |
| `bytedance/UI-TARS-desktop`     | `c2ad42e3eb9b27830db41a3e6f51ca7179d9b168` | 2026-07-01      |
| `mediar-ai/terminator`          | `73a381c0c1c33eda55f2c0ecb1d918bf5ec7561a` | 2026-06-02      |
| `microsoft/OmniParser`          | `354021201345a96178360b28733573e27269f2de` | 2026-07-20      |
| `microsoft/UFO`                 | `364eb7969d392e857299ceaf14bd6057e5b00078` | 2026-09-02      |
| `nut-tree/nut.js`               | `e413fa1f19a19c4631812e4e1eaf47aa732b5cbe` | 2024-05-01      |
| `openclaw/Peekaboo`             | `dc3dc4a43e8593eb7ccacb1377b2f3c2154dbd14` | 2026-09-07      |
| `opensymph/open-computer-use`   | `5b433b98019c18201a15d11e8c3cb0010879a3d8` | 2026-08-26      |
| `simular-ai/Agent-S`            | `3aa272d23d2994c7bbde1acbbe0ef8e8d06b8693` | 2026-09-05      |
| `trycua/cua`                    | `e926a34a9ac5283f17c414f17c4992e0a09d106e` | 2026-09-07      |
