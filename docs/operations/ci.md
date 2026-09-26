# CI 验证

本页定义 required CI 的计划、执行证据和准入。任务目录在 `script/ci/catalog.ts`，执行配方在 `script/ci/run.ts`，覆盖率阈值仍由 `script/coverage-exempt.json` 管理。Oryn 审查队列独立运行，配置检查属于 policy 任务。

## 执行模式

`script/ci/rollout.json` 默认为 `shadow`：PR 计算影响范围，同时实际执行全量；dev/main 每次 push 和每天针对最新 dev 的冷运行始终全量。PR 新提交取消旧运行，主线每个提交保留自己的运行。仓库变量 `SYNERGY_CI_FORCE_FULL=1` 强制 PR 全量。

切换为 `affected` 前，准入器要求同一选择策略至少 20 个不同提交、不同 run 的成功全量样本，包含文档、前端、Runtime、benchmark 和工具链变更；任何未选任务失败都会拒绝切换。`ci-admission-<attempt>` artifact 保存证据。修改选择策略会改变 policy 摘要，旧样本不能认证新策略。只通过代码评审修改模式配置；诊断结果不计入样本。

PR 使用 base/head 两侧的 workspace、测试、动态资源导入关系计算反向依赖闭包，执行 GitHub 合并提交，计划分别记录三个 SHA。Desktop 显式依赖嵌入的 Web 与 Runtime。新增未登记 workspace、根锁文件、工具链、共享测试设施、CI 规则和未知路径升级全量。只有明确白名单中的说明文档可选 policy；包内 Markdown 按程序输入处理。单独的 Pi/OpenCode observer 改动选择公共 benchmark 契约与该 native harness；共享协议、准备与调度改动选择全部 harness。

## 任务和报告

普通包测试执行一次，同时产生 JUnit、lcov 和批次耗时。Harness 使用四个稳定哈希分区，特殊隔离文件保持独立进程。每批拥有独立的 Home、fixture 根和 Link Home，fixture 自己分配数据库与动态端口。真实 sandbox、macOS/Windows 原生 Workspace、PostgreSQL 16/17/18、安装产物和三种 30 MiB 长流结果保持独立任务。原生 Workspace 任务生成本次 JUnit 与 lcov，依赖完整 Runtime Local suite 的覆盖率基线；required check 等待两个平台的计划结果并共同计算覆盖率。

普通 Linux、Docker、PostgreSQL、Windows、macOS 矩阵的并发上限分别为 6、3、2、1、1；小任务按历史估计耗时分配到 worker，worker 内顺序执行，避免独立包的原生写占用在同一宿主互相阻塞。构建准备作为独立前置节点，纯检查使用一个直接启动的 Linux worker，其余五个 worker 等待共享构建。Docker 的两个外部 harness worker 可与准备任务同时运行；准备完成后启动一条场景通道，外部任务退出后再开放其余两条通道，整个 DAG 最多占用三个 Docker runner。构建缓存包含输入、配方、Bun、runner 镜像、OS/架构/ABI 身份，恢复时校验完整文件列表、内容摘要和文件模式。缓存保存构建产物，不保存测试成功结论或运行 Home；冷运行跳过跨 run 缓存。core、full、benchmark 维持独立配方。

`All checks passed` 始终执行。它核对计划摘要、测试 SHA、run、attempt、模式、全部选中任务、job 结果、报告摘要和逐文件执行清单。缺失、取消、失败、重复、诊断或陈旧结果均不能通过。产物名带 attempt，重跑 required CI 使用 Re-run all jobs；只重跑失败 job 会因旧计划身份而拒绝，单项排查使用诊断工作流。未选择任务在计划摘要中显示原因。覆盖率只合并本次完整成功任务的报告，未加载文件和 exemption 规则保持原样。

## 开发接口

```bash
bun run ci:plan --base <base-sha> --head <head-sha> --sha <tested-sha> --mode shadow
bun run ci:run --plan .artifacts/ci/plan.json --unit linux-0
bun run ci:verify --plan .artifacts/ci/plan.json --jobs '<job-result-json>'
```

本地窄测沿用包内测试命令。需要同 CI 配方重现时，先生成 `--mode diagnostic` 计划，通过 `--only <task-id>`、`--package packages/<owner>` 或 `--file packages/<owner>/test/<file>.test.ts` / `--file benchmark/test/test_<name>.py` 选择，然后运行计划中的 unit。未构建时先按计划准备依赖；Linux 共享构建由 `bun script/ci.ts prepare` 生成。不要在 macOS 上把 Linux sandbox、安装产物或 Windows 配方当作通过结果。

GitHub 的 `CI diagnostics` 工作流提供相同选择器，执行矩阵最多同时两个 job，不产生 required check。产物和结果只能用于定位失败；单文件诊断不能满足包覆盖率门槛。

## 测量与验收

带 attempt 后缀的 `ci-plan-*`、`ci-results-*`、`ci-summary-*`、`ci-admission-*` 保留计划、任务证据、计时和准入样本。每个 job 的队列和运行时间来自 GitHub 当前 attempt API；汇总采集器自身尚未结束，因此同次运行的 metrics 标记 `partial`，不能作为最终性能验收。完成后运行 `bun script/ci/metrics.ts --repo SII-Holos/synergy --run <id> --attempt <n> --cache <cold|hit|miss> --load <isolated|concurrent-pr|unknown> --output <file>`，以最终 GitHub job 时间重新统计；采集器排除重跑 attempt 继承的旧 job、重复记录和未启动任务的计算时间。根据仓库运行时间线确认是否存在重叠 PR 后填写负载标签，未知负载不能算作单 PR 对照。分别报告冷缓存、缓存命中、缓存未命中和并发 PR 的样本。

性能目标：明确纯文档 P90 ≤ 3 分钟，普通选测 PR 中位数 ≤ 10 分钟且 P90 ≤ 15 分钟，全量中位数 ≤ 20 分钟且 P90 ≤ 25 分钟，全量累计中位数 ≤ 120 runner 分钟。目标包含队列，必须用相同变更类型、runner 和缓存状态的托管样本验证，并记录非确定性失败。影子模式仍执行全量，不能用预计选测时间宣称达标。

实现取舍与热点正确性见 [CI 决策](../decisions/implemented/testing/2026-09-24-ci-verification-plans.md)。
