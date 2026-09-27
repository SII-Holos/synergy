# CI 验证

本页定义 required CI 的计划、执行证据和准入。任务目录在 `script/ci/catalog.ts`，执行配方在 `script/ci/run.ts`，覆盖率阈值仍由 `script/coverage-exempt.json` 管理。Oryn 审查队列独立运行，配置检查属于 policy 任务。

## 执行模式

`script/ci/rollout.json` 默认为 `affected`：PR 按影响范围执行；dev/main 每次 push 和每天针对最新 dev 的冷运行始终全量。PR 新提交取消旧运行，主线每个提交保留自己的运行。仓库变量 `SYNERGY_CI_FORCE_FULL=1` 强制 PR 全量。

模式由代码评审后的配置决定，不依赖历史样本数量。full/shadow 运行把未选任务失败与选择策略、catalog 摘要写入 `ci-admission-<attempt>`，用于审查漏选；任务耗时和分组不改变选择策略摘要。diagnostic 不提供合并证据。

PR 使用 base/head 两侧的 workspace、测试和静态资源导入关系计算反向依赖闭包，执行 GitHub 合并提交，计划分别记录三个 SHA。Desktop 显式依赖嵌入的 Web 与 Runtime。新增未登记 workspace、根锁文件、工具链、共享测试设施、CI 规则和未知路径升级全量。只有明确白名单中的说明文档与 Skill 描述可选 policy，代码混合改动仍按代码计算影响；包内 Markdown 按程序输入处理。单独的 Pi/OpenCode observer 改动选择公共 benchmark 契约与该 native harness；共享协议、准备与调度改动选择全部 harness。

变更路径从 base/head 的共同祖先比较到 head；base 独有更新不计作 PR 修改。依赖图使用当前两侧快照，使主线新增使用者仍可被选中。重命名的旧、新路径和删除文件均参与影响分析。

普通包运行完整 suite；PostgreSQL 与长流任务另从实际测试入口追踪两侧输入。跨 workspace 输入包含生产和测试依赖；无法解析的别名、动态导入或资源使该任务对代码改动保守选中。输入图完整时才允许跳过未触及的昂贵任务。

## 任务和报告

普通包测试执行一次，同时产生 JUnit、lcov 和批次耗时。Harness 使用四个稳定哈希分区，特殊隔离文件保持独立进程。每批拥有独立的 Home、fixture 根和 Link Home，fixture 自己分配数据库与动态端口。真实 sandbox、macOS/Windows 原生 Workspace、PostgreSQL 16/17/18、安装产物和三种 30 MiB 长流结果保持独立任务。原生 Workspace 任务生成本次 JUnit 与 lcov，依赖完整 Local Runtime suite 的覆盖率基线；required check 等待两个平台的计划结果并共同计算覆盖率。

正式安装验收由 Linux prepare 分别构建 core/full，并各发布独立、只读的本次分发产物。五个消费任务覆盖 core binary、core tarball、full 两组行为和 full 组合与 CLI 安装、升级、移除、managed/attach 生命周期。full 不依赖 core 构建；消费者验证计划、提交、run、attempt、Bun、ABI、完整文件列表、字节摘要和文件模式。每个场景拥有独立 Home，同一进程仅共享只读发行树副本。

长会话矩阵固定 fixture-one，保留 JIT × 两协议的四个 120 轮组合；四个短语义组合覆盖两个 fixture model 与协议、JIT 的成对关系，实际验证工具写读修订、磁盘结果、usage 和归档身份。PostgreSQL 三版本仅执行登记的 PG 能力入口，SQLite 专用用例由普通 suite 覆盖；缺少 PG 配置必须失败。三种长流保留原始负载和真实 Runtime 清理。布局与测试取舍见 [PR 反馈决策](../decisions/implemented/testing/2026-09-27-pr-ci-feedback.md)。

普通 Linux、Docker、PostgreSQL、Windows、macOS 矩阵的并发上限分别为 6、3、2、1、1；任务按历史估计耗时分配到 worker，worker 内顺序执行，避免独立包的原生写占用在同一宿主互相阻塞。构建准备作为独立前置节点，纯检查使用一个直接启动的 Linux worker，其余五个 worker 等待共享构建。Docker 在 benchmark preparation 后进入统一三并发矩阵，最长任务优先，每个任务独立报告；仅依赖准备物的消费者下载产物，只选外部 harness 时跳过 preparation。构建缓存包含输入、配方、Bun、runner 镜像、OS/架构/ABI 身份，恢复时校验完整文件列表、内容摘要和文件模式。缓存保存构建产物，不保存测试成功结论或运行 Home；冷运行跳过跨 run 缓存。core、full 分发产物仅在本次运行共享，benchmark 维持独立配方。

`All checks passed` 始终执行。它核对计划摘要、测试 SHA、run、attempt、模式、全部选中任务、job 结果、报告摘要和逐文件执行清单。安装行为与长短矩阵还校验 JUnit 场景恰好执行一次并成功；漏跑、重复、跳过、失败或损坏报告均拒绝。缺失、取消、失败、重复、诊断或陈旧任务结果均不能通过。产物名带 attempt，重跑 required CI 使用 Re-run all jobs；只重跑失败 job 会因旧计划身份而拒绝，单项排查使用诊断工作流。未选择任务在计划摘要中显示原因。覆盖率只合并本次完整成功任务的报告，未加载文件和 exemption 规则保持原样。

## 开发接口

```bash
bun run ci:plan --base <base-sha> --head <head-sha> --sha <tested-sha> --mode affected
bun run ci:run --plan .artifacts/ci/plan.json --unit linux-0
bun run ci:verify --plan .artifacts/ci/plan.json --jobs '<job-result-json>'
```

本地窄测沿用包内测试命令。需要同 CI 配方重现时，先生成 `--mode diagnostic` 计划，通过 `--only <task-id>`、`--package packages/<owner>` 或 `--file packages/<owner>/test/<file>.test.ts` / `--file benchmark/test/test_<name>.py` 选择，然后运行计划中的 unit。未构建时先按计划准备依赖；Linux 共享构建由 `bun script/ci.ts prepare` 生成，选中的 core/full 分发产物由 `bun script/ci.ts prepare-distributions --plan <file>` 生成。不要在 macOS 上把 Linux sandbox、安装产物或 Windows 配方当作通过结果。

GitHub 的 `CI diagnostics` 工作流提供相同选择器，执行矩阵最多同时两个 job，不产生 required check。产物和结果只能用于定位失败；单文件诊断不能满足包覆盖率门槛。

## 测量与验收

带 attempt 后缀的 `ci-plan-*`、`ci-results-*`、`ci-summary-*`、`ci-admission-*` 保留计划、任务证据、计时和准入样本。每个 job 的队列和运行时间来自 GitHub 当前 attempt API；汇总采集器自身尚未结束，因此同次运行的 metrics 标记 `partial`，不能作为最终性能验收。完成后运行 `bun script/ci/metrics.ts --repo SII-Holos/synergy --run <id> --attempt <n> --cache <cold|hit|miss> --load <isolated|concurrent-pr|unknown> --output <file>`，以最终 GitHub job 时间重新统计；采集器排除重跑 attempt 继承的旧 job、重复记录和未启动任务的计算时间。根据仓库运行时间线确认是否存在重叠 PR 后填写负载标签，未知负载不能算作单 PR 对照。分别报告冷缓存、缓存命中、缓存未命中和并发 PR 的样本。

性能目标：明确纯文档 P90 ≤ 3 分钟，普通选测 PR 中位数 ≤ 10 分钟且 P90 ≤ 15 分钟。包含完整长压力与安装控制的重型全量短期估计为 30–40 分钟，属于待托管验证的估算；持续跟踪累计 runner 分钟。时间包含队列，必须用相同变更类型、runner 和缓存状态的托管样本验证，并记录非确定性失败。影子模式仍执行全量，不能用预计选测时间宣称达标。

实现取舍与热点正确性见 [CI 决策](../decisions/implemented/testing/2026-09-24-ci-verification-plans.md)。
