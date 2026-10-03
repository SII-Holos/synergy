# CI 验证

本页定义 required CI 的计划、执行证据和准入。任务目录在 `script/ci/catalog.ts`，执行配方在 `script/ci/run.ts`，覆盖率阈值仍由 `script/coverage-exempt.json` 管理。Oryn 审查队列独立运行，配置检查属于 policy 任务。

## 执行模式

`script/ci/rollout.json` 默认为 `affected`：PR 按影响范围执行；dev/main 每次 push 和每天针对最新 dev 的冷运行始终全量。PR 新提交取消旧运行，主线每个提交保留自己的运行。仓库变量 `SYNERGY_CI_FORCE_FULL=1` 强制 PR 全量。

模式由代码评审后的配置决定，不依赖历史样本数量。full/shadow 运行把未选任务失败与选择策略、catalog 摘要写入 `ci-admission-<attempt>`，用于审查漏选；任务耗时和分组不改变选择策略摘要。diagnostic 不提供合并证据。

PR 使用 base/head 两侧的 workspace、测试和静态资源导入关系计算反向依赖闭包，执行 GitHub 合并提交，计划分别记录三个 SHA。Desktop 显式依赖嵌入的 Web 与 Runtime。新增未登记 workspace、根锁文件、工具链、共享测试设施、CI 规则和未知路径升级全量。只有明确白名单中的说明文档与 Skill 描述可选 policy，代码混合改动仍按代码计算影响；包内 Markdown 按程序输入处理。单独的 Pi/OpenCode observer 改动选择公共 benchmark 契约与该 native harness；共享协议、准备与调度改动选择全部 harness。

变更路径从 base/head 的共同祖先比较到 head；base 独有更新不计作 PR 修改。依赖图使用当前两侧快照，使主线新增使用者仍可被选中。重命名的旧、新路径和删除文件均参与影响分析。

普通包运行完整 suite；PostgreSQL 与长流任务另从实际测试入口追踪两侧输入。跨 workspace 输入包含生产和测试依赖；无法解析的别名、动态导入或资源使该任务对代码改动保守选中。输入图完整时才允许跳过未触及的昂贵任务。

## 任务和报告

普通包测试执行一次，同时产生 JUnit、lcov 和批次耗时。Harness、Web、Presets、UI、Local Runtime 分别使用 4、4、4、2、2 个分区，按登记的历史文件耗时均衡分配；原有批次与特殊隔离文件保持完整，执行清单逐文件核对，无遗漏或重复。每批拥有独立 Home 和 fixture 根。六个 UI DOM 夹具共享一次 Solid/Vite 编译，每个测试仍使用独立进程和 DOM；缓存校验实际输入和输出字节。真实 sandbox、macOS/Windows 原生 Workspace、PostgreSQL 16/17/18 与安装产物保持独立任务。Windows 原生与 Desktop 分成可分别重跑的任务，同平台串行；原生结果生成 JUnit 与 lcov，要求两个 Local Runtime 分区的完整基线共同计算原有覆盖率门槛。

Linux 基础准备、core 分发、full 分发和 benchmark 准备各有独立生产任务；消费者只在需要时等待对应产物。core binary 验证独立启动与真实工具调用，core 包验证实际安装、启动和完成任务；full 保留六类业务结果、一次完整导入导出和组件安装、升级、移除、managed/attach 生命周期。基础准备并行生成一次 Web 生产产物，构建契约和浏览器 smoke 消费经过清单校验的同一产物。消费者验证计划、提交、run、原始计划 attempt、Bun、ABI、完整文件列表、字节摘要和模式；每个场景有独立 Home，结束时验证发行树未变。

压缩业务控制在真实读取、修改和原生压缩后继续执行，并验证磁盘结果、导出与完整用量；完成条件是业务事件，执行上限只防止挂死。四组短语义控制继续覆盖协议、模型与 JIT 的成对配置。历史 ARM/JIT 的四组 120 轮压力复现通过显式诊断开关运行。五种 native harness 均保留实际接入和适配器行为；正常、故障、短语义、压缩等场景组各自执行，公共纯逻辑只验证一次。长流完成态保留 30 MiB 完整性，取消和失败使用小数据保留终态、已接收字节、用量和 Runtime 清理。PostgreSQL 三版本执行登记的 PG 入口，缺少配置必须失败。取舍见 [业务反馈决策](../decisions/implemented/testing/2026-09-30-business-ci-feedback.md)。

执行池上限为 Linux 12（含一个直接启动的 contracts worker）、Docker 8，Windows、PostgreSQL、macOS 各 1。同平台 Windows job 保持串行；原生覆盖率由两个独立 Home 的进程执行，报告目录互不覆盖。普通 Linux 包分片分散到不同 runner，同一 runner 最多两个独立进程，contracts 与本地诊断仍串行。Docker 场景分配到最多八个 job，每个 job 最多并行两个独立 Home、进程和容器的任务，共享只读准备；每个任务独立产生报告，重跑以 job 为单位。公开仓库所在 GitHub Free 组织同时最多 20 个 job，准备任务和其他 PR 共享容量；排队计入实际反馈时间。Linux/macOS 的 Bun 下载、Python 下载和 Rust 编译使用覆盖锁文件、平台、实际工具链及输入的缓存；Windows 跳过实测慢于直接安装的 Bun 缓存解压，Desktop 只安装自身 workspace 依赖；跨 job 构建恢复验证完整清单、摘要和模式。core/full 分发缓存键还包含 tested SHA 和已校验基础构建的完整清单摘要；缓存命中先核对平台、工具链、文件字节与权限，再为当前计划发布产物。缓存保存依赖与构建，不保存测试成功结论或运行 Home。测试子进程移除协调器的 GitHub token 与父级文件选择；需要特殊凭据的夹具必须显式提供。共享 UI 编译在独立进程内完成，按输入摘要锁定编译与发布，避免 Vite 改变调用方环境和并行进程覆盖有效产物。准备等待由 workflow job 超时约束；生产者失败立即报错，完成后一分钟仍缺失产物则要求全量重跑。每日运行或手动 `build_cache=disabled` 跳过跨 run 构建缓存，依赖下载缓存可复用。

`All checks passed` 始终执行，核对计划摘要、测试 SHA、run、模式、全部选中任务、job 结果、报告摘要和逐文件执行清单。安装和矩阵的 JUnit 场景必须恰好执行一次且成功。结果版本 2 记录 `unit`、`planAttempt`、`executionAttempt`；报告按产物目录隔离。GitHub“仅重跑失败 job”沿用原计划和成功产物，汇总根据 API 的最近一次实际 unit 执行选择证据。GitHub 会给未执行的兄弟 job 复制新的 attempt 编号；已完成且开始、结束均早于记录创建时间的复制记录不算新执行，也不重复计入计算时间。最新失败、缺失、重复、损坏、旧 SHA、错误 run 或计划不能通过。产物过期须全量重跑。新提交重新计算当前 PR 影响范围，不能沿用上一个 SHA 的通过结论。覆盖率只合并所选最新完整成功报告，阈值与 exemption 不变。

选中的 core/full 分发消费者必须让基础准备生成并发布 Linux sandbox helper，即使计划没有选中安装产物或 sandbox 测试。独立的 Web 分发验收同样依赖该原生包；普通 Web suite 不因此额外准备 sandbox。准备条件来自选中任务的分发 profile 和显式 prerequisites，不能只按测试 kind 判断。

## 维护验证成本

测试的价值由它保护的业务行为、实际故障和独有覆盖决定。开发变更同时审视新增与已有测试，合并重复覆盖、移除过时场景，保留安装、生命周期、迁移、恢复、平台差异与覆盖率门槛。具体步骤由 [testing-guide](../../.synergy/skill/testing-guide/SKILL.md#review-test-value-and-ci-cost) 拥有，源开发入口 [develop-synergy](../../.synergy/skill/develop-synergy/SKILL.md#verify-and-diagnose) 必须执行这项审视。

全量反馈以约 10 分钟为优化目标，不设仅凭超过 10 分钟就失败的质量门禁。有业务价值的增长可以保留；昂贵夹具、新增组合、准备或关键路径改变需对照相同负载和缓存条件的实际运行，说明新增覆盖与耗时增量，检查能否复用准备或合并重复场景。报告最终耗时、队列、runner 分钟、失败阶段和重跑次数；重跑变绿不能证明 flaky 已修复。超过目标或重复出现长尾时按实测热点优化，不能只新增测试而放任重复和无效断言累积。

## 开发接口

```bash
bun run ci:plan --base <base-sha> --head <head-sha> --sha <tested-sha> --mode affected
bun run ci:run --plan .artifacts/ci/plan.json --unit linux-0
bun run ci:verify --plan .artifacts/ci/plan.json --jobs '<job-result-json>'
```

本地窄测沿用包内测试命令。需要同 CI 配方重现时，先生成 `--mode diagnostic` 计划，通过 `--only <task-id>`、`--package packages/<owner>` 或 `--file packages/<owner>/test/<file>.test.ts` / `--file benchmark/test/test_<name>.py` 选择，然后运行计划中的 unit。未构建时先按计划准备依赖；Linux 共享构建由 `bun script/ci.ts prepare` 生成，选中的分发产物由 `bun script/ci.ts prepare-distributions --plan <file> --profile <core|full>` 分别生成。不要在 macOS 上把 Linux sandbox、安装产物或 Windows 配方当作通过结果。

GitHub 的 `CI diagnostics` 工作流提供相同选择器，执行矩阵最多同时两个 job，不产生 required check。产物和结果只能用于定位失败；单文件诊断不能满足包覆盖率门槛。

## 测量与验收

带 attempt 后缀的 `ci-plan-*`、`ci-results-*`、`ci-summary-*`、`ci-admission-*` 保留计划、任务证据、计时和准入样本。构建产物保留 1 天，测试报告保留 3 天，计划与汇总保留 7 天；完整诊断仅失败时上传。每个 job 的队列和运行时间来自 GitHub 当前 attempt API；汇总采集器自身尚未结束，因此同次运行的 metrics 标记 `partial`，不能作为最终性能验收。完成后运行 `bun script/ci/metrics.ts --repo SII-Holos/synergy --run <id> --attempt <n> --cache <cold|hit|miss> --load <isolated|concurrent-pr|unknown> --output <file>`，以最终 GitHub job 时间重新统计；采集器排除重跑 attempt 继承的旧 job、重复记录和未启动任务的计算时间。根据仓库运行时间线确认是否存在重叠 PR 后填写负载标签，未知负载不能算作单 PR 对照。分别报告冷缓存、缓存命中、缓存未命中和并发 PR 的样本。

全量 CI 的约 10 分钟反馈目标包含准备、测试、上传、最终检查和队列；分别完成一轮冷构建缓存与一轮热缓存，以最终 GitHub 时间和完整报告判断。验收对照需确认组织容量可用；多个 PR 占满容量的排队另列并计入用户实际等待。记录累计 runner 分钟与非确定性失败；拆分后的估计耗时、局部绿灯或影子模式的选测估算不能证明全量耗时。增长的取舍遵循 [维护验证成本](#维护验证成本)。

实现取舍与热点正确性见 [CI 决策](../decisions/implemented/testing/2026-09-24-ci-verification-plans.md)。

录制完成态保留 30 MiB 完整性，默认 32 KiB 分块；历史 1 KiB checkpoint 压力可显式组合 `SYNERGY_ROLLOUT_LONG_STREAM=1 SYNERGY_ROLLOUT_CHECKPOINT_STRESS=1` 运行 Harness 的 `test/session/rollout-long.test.ts`。

准备依赖对应独立执行队列：普通 Linux 6、core 1、full 4、contracts 1；Docker 无准备依赖 2、冻结准备消费者 6。core/full/冻结消费者在其生产者完成后才申请 runner。`build_cache=disabled` 同时关闭 Rust 编译与经过校验的跨 run 构建缓存，依赖下载缓存仍可复用。

基础准备在同一 runner 并行执行原生构建与 Web 生产构建，完整产物纳入基础清单。full 分发仅在基础清单验证成功后使用 `--skip-web-build`，缺少生产 manifest 时失败；普通发行与诊断继续自行构建 Web。安装生命周期拆为独立组件、公司 preset/schema 与 Web 三组，各自从新 Home 开始。

Task Home 的真实工具执行和空 provider 停止分为独立任务，保留原生重试策略，按 runner 实测时间分配；pytest 收集检查继续要求全部场景恰好执行一次。构建产物的临时仓库夹具显式设置自身 Web 模式，避免继承全量 CI 的准备配置。

规划 job 仅安装 testing workspace 需要的依赖，不恢复整仓下载缓存。四组短协议/JIT 控制和 Task Home 控制使用两次真实工具调用验证首末阶段；完整文件修改循环继续由业务压缩控制和显式 120 轮诊断承担。
