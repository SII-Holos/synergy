# Synergy 本地评测

用固定小型任务集比较 Synergy 的完成率、token、缓存、金额和耗时。这里负责实验输入、执行编排和原始证据；产品执行、模型配置、计量与 rollout 继续由现有 runtime 提供。结果不自动做统计分析，也不调用 LLM judge。

## 开始一次 A/B

需要 POSIX 宿主环境（Linux、macOS 或 WSL）、Python 3.12、uv、Docker Linux containers 和源码声明的 Bun 版本。首次准备会下载任务、Linux 依赖和镜像；后续实验复用准备产物。依赖安装使用完整 monorepo 的 frozen lockfile，不运行整套产品发布构建。准备产物包含 Bun 和由被测 runtime 下载的 ripgrep；缺少 Git 的任务镜像通过 Pier 安装步骤补齐 Git。

```bash
bun bench list
bun bench plan benchmark/configs/ab.yaml
bun bench prepare benchmark/configs/ab.yaml
bun bench resume /absolute/path/printed/by/prepare
```

编辑 [配置示例](configs/ab.yaml)，填写实际模型和凭据环境变量，再执行 `run` 可一次完成 prepare 与 resume。示例有两个 variant：HEAD 和当前工作目录。模型必须显式指定；评测器不会读取个人 Synergy Home 或推断付费账号。

```bash
bun bench run benchmark/configs/ab.yaml
bun bench inspect /absolute/path/to/run --trial 0
bun bench debug /absolute/path/to/run --trial 0
bun bench recover-export /absolute/path/to/run --trial 0 --attempt 1
bun bench clean /absolute/path/to/run
```

`debug` 创建额外 attempt 并保留它的容器，不覆盖正式 A/B 数据。容器的 Compose project 写在对应 `environment.json`；可用 Docker 的 project label 找到容器后进入调试。`clean` 删除指定实验的证据和所属容器、网络；不会执行全局 Docker prune。

## 配置约定

所有相对路径以 YAML 所在目录为基准。配置严格校验未知字段；模型及能力配置在准备好的 Linux runtime 中离线解析，包括实际 provider/model、角色模型、agent、variant 和 Experiment。模型目录来自冻结源码的固定 fixture，并随产物校验；不会在线刷新目录。缺少任务、配置文件或映射凭据时，在构建前失败。

| 配置                                 | 含义                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `suite`                              | 锁定的数据集清单 JSON                                                  |
| `selection.tasks` / `tags` / `limit` | 精确任务 ID、必须同时满足的标签、按 ID 排序后的数量上限                |
| `repeat` / `seed` / `concurrency`    | 每题重复次数、调度种子、并发 task-repeat 对数；默认 1 / 0 / 1          |
| `platform`                           | Linux Docker 平台，默认 `linux/amd64`；原题镜像也必须支持所选架构      |
| `timeout_seconds`                    | 可选实验时间上限；未填写时使用原题 agent 时间限制                      |
| `cleanup_seconds`                    | CLI 取消与子任务收尾期限，默认 60 秒                                   |
| `export_timeout_seconds`             | 导出及 ZIP 校验的独立期限，默认 300 秒                                 |
| `preparation_timeout_seconds`        | 每个源码产物准备的期限，默认 1800 秒                                   |
| `variants.<name>.source.path`        | 被测 Git checkout                                                      |
| `source.revision`                    | 可选固定 revision；省略则冻结当前 tracked 与非 ignored untracked 文件  |
| `source.artifact`                    | 复用已准备的源码产物，要求平台和 runtime recipe 一致                   |
| `runtime`                            | `core`、`core-library`、`full`，或 `runtime/` 内的相对 TS recipe 路径  |
| `model` / `agent` / `variant`        | 显式 provider/model、Synergy agent 名和模型 variant                    |
| `config`                             | 原生 Synergy JSON 配置：provider、各角色模型、模型参数、工具与执行参数 |
| `experiment`                         | 原生 versioned Experiment JSON；复用产品已有 overrides/runtime 校验    |
| `env`                                | 容器环境变量名到宿主环境变量名的映射，只保存名字                       |
| `network_domains`                    | 模型服务需要的域名；交给 Pier 处理原题网络策略与 agent egress          |

任务容器默认使用 `full_access`，隔离边界是 Docker；可在原生配置中显式覆盖。未指定的 nano/mini/mid/thinking/long_context/creative/vision 角色默认使用该 variant 的主模型，防止辅助调用悄悄选到其他模型。需要单独评测某个角色时，在 `config` 或 `experiment` 中配置它。

原生配置中的凭据使用 `{env:VARIABLE_NAME}`，并在 `env` 中声明传入关系。`SYNERGY_HOME`、PATH 等评测器控制的环境变量不能通过这个映射覆盖。凭据值经权限为 0600 的临时文件上传到容器临时目录，包装器读取后立即删除，并仅通过子进程环境传给 Synergy。每个 attempt 都有全新的 Home、进程和任务容器；云服务端 prompt cache 仍由服务商管理，不能把 fresh Home 当作远端 cold cache。

## 数据集及可比性

[local-24](suites/local-24.json) 锁定 12 个 DeepSWE 1.1 原题和 12 个 Terminal-Bench 2.1 原题。清单记录 upstream commit、任务路径、内容摘要、标签与原始时间限制。选择使用 seed 0 对任务名做 SHA-256 排序，并按以下配额分层；只纳入 Linux CPU、最多 4 CPU / 8192 MiB 的任务，没有使用模型表现挑题。

- DeepSWE：Python、Go、TypeScript 各 3，Rust 2，JavaScript 1。
- Terminal-Bench：software-engineering 3、system-administration 2，其余 scientific-computing、security、data-science、file-operations、debugging、mathematics、data-processing 各 1。

这是本地开发样本，不代表官方榜单成绩或统计显著性。小样本仍可能有长任务；选择少量题或明确降低 `timeout_seconds` 可以缩短实验，但后者改变了评测条件。A/B 使用相同 task-repeat 对，并平衡 variant 首次执行位置；每对内顺序执行，配对之间可并发。

原始 instruction、environment、solution、tests 和 verifier 协议不会被改写。尤其 DeepSWE 使用独立 verifier，并通过原题 collect hook 收集基于 HEAD 的 patch；评测器不会替 agent 自动提交代码。任务自身要求提交时，未提交改动可能不会被评分。

Provenance: [DeepSWE 锁定源码](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)、[Terminal-Bench 锁定源码](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b)、[Pier 0.3.1](https://pypi.org/project/datacurve-pier/0.3.1/)。

Local adaptation: 仅固定子集、冻结源码与运行组合、配对调度及保存原始证据；使用 Pier 的 task lifecycle、网络策略、artifact collect 和 verifier，不复制其任务执行协议。上游内容按清单下载到 ignored cache，许可证保留在完整 checkout 中。

## 源码与结果管理

评测工程、被测源码、运行组合和数据集分别标识。源码准备读取 Git 内容，不改分支、index 或创建实验 commit；保存未提交改动、删除、新文件、可执行位和内部 symlink。忽略文件不进入快照，外部 symlink 与 submodule 被拒绝。试验执行只挂载冻结副本及 Linux 依赖，全部只读。包装器按冻结 workspace manifest 的公开包名建立依赖链接，不依赖根目录依赖提升，也不要求被测 revision 已包含 `benchmark/`。

运行前校验源码文件清单和内容、依赖 bundle、recipe、输入及任务摘要。原 checkout 后续变化不影响已有实验。`resume` 拒绝使用变化后的评测器、Python 版本或输入继续已有实验；已有终态证据优先于滞后的调度状态；只修复状态，不重复模型调用。已结束的失败也是结束，不能借 resume 自动重抽样。新 attempt 使用 v2 结果；历史结果可 inspect，但新评测器不会续跑或改写旧实验。中断重跑使用新 attempt，并保留旧 Home 和证据。固定输入仍不能冻结外部模型服务版本或消除服务端缓存、网络负载变化。

```text
run/
  owner.json
  plan.json                 # 完整解析输入、顺序、各类身份及内容摘要
  state.json                # 原子更新的 trial / attempt 状态
  inputs/<variant>/         # 原生配置快照，不包含凭据值
  trials/<index>/attempt-001/
    trial.json
    environment.json        # 本次 Docker project
    evidence.json           # 执行、评分、完整性与文件摘要
    sb-.../
      config.json           # Pier 实际 trial 配置
      result.json
      agent/
        environment.json    # 实际镜像 ID、CPU / memory、Bun 版本
        events.jsonl
        execution.json
        accounting.json
        export.json         # 导出/校验期限、退出码、信号与最终状态
        archive.json        # 产品校验器认证及 archive 哈希
        rollout.zip
        stderr.log
        export.log
        home/               # 原始独立 Home，含不完整记录
      verifier/
      artifacts/
  debug/                    # 手动重现，独立于正式 trial
```

`execution` 表示 CLI 是否完成、失败、超时或中断；`verifier` 原样保存原题 reward；`evidence.valid` 表示证据链路是否有效，记录和 usage 的覆盖程度单独表示。三者不能互相替代。文件摘要覆盖留存的证据，ZIP 内部逐项验证 size 和 SHA-256。

`accounting` 使用 Synergy 原生字段：token 的 known/unknown/total、cache read/write、reasoning、API estimate、subscription equivalent、reported currencies 等原样保存。未知 total 保持 null，reported cost 与估算金额保持不同语义。`execution.wall_ms` 是 CLI 运行耗时，Pier result 另外记录环境准备和 verifier 时间。这里不计算成功率、tokens/s、置信区间或金额汇率；后续分析只消费这些固定记录。

## 维护与扩展

| 位置                                       | 所有权                                           |
| ------------------------------------------ | ------------------------------------------------ |
| `src/synergy_bench/config.py`              | 实验配置和配对计划                               |
| `catalog.py`、`suites/`                    | 数据集版本、原题身份和选择                       |
| `source.py`、`prepare.py`                  | 源码冻结、Linux 依赖准备、能力预检               |
| `runner.py`、`storage.py`、`background.py` | 调度、终态核对、原子状态、所有权锁、受限后台工作 |
| `trial.py`、`recovery.py`                  | Pier 评分与清理期限、保留证据的恢复导出          |
| `agent.py`                                 | Pier 到 Synergy CLI 的单一适配边界               |
| `evidence.py`、`results.py`                | 版本化结果、原始记录与完整性校验                 |
| `runtime/`                                 | 公开包组合、worker、CLI 执行及 export            |

新增 benchmark 时添加一份 Suite 清单，并保持 task.toml 兼容 Pier；不同 suite 可以有不同题型、标签和 verifier reward 名称，无需改调度器。新增能力组合时在 `runtime/` 中编写具名 recipe，通过公开包 register/open 接口组合，父进程与 worker 使用同一 recipe。不要向 Harness 塞入评测调度，也不要复制 agent loop、CLI parser 或 accounting。

```bash
uv run --locked --project benchmark pytest benchmark/test
uv run --locked --project benchmark ruff check benchmark
uv run --locked --project benchmark mypy benchmark/src/synergy_bench
bun run --cwd benchmark test
bun run --cwd benchmark typecheck
SYNERGY_BENCH_DOCKER=1 uv run --locked --project benchmark pytest -s benchmark/test/test_docker.py
```

普通测试不启动 Docker 或付费模型。显式 Docker 测试使用固定本地 chat/embedding provider，覆盖三种 runtime、共享及独立 verifier、真实工具执行、A/B、reward、cache token、rollout 和 resume。24 个官方任务的全套 oracle/nop 结果必须实际运行后另行记录，静态清单校验不能替代这些结果。

CI 将 30 MiB、30,720 次 checkpoint 的成功、取消和失败样本分别放到独立 runner，三个结果都必须通过；Docker 回归独立执行。长流测试自身允许 20 分钟，并输出持久化和校验进度，适应 CI 磁盘耗时。这不改变任何正式任务或 verifier 的时限。

## 结束与恢复

进度写 stderr，最终 JSON 摘要写 stdout。摘要包含完成、失败、超时、评分和记录问题；不能把仅输出目录当作运行成功。退出码为：0 编排完成且结果有效（包括正常答错）；1 基础设施、导出或记录失败；2 配置或输入无效；130 用户中断。

执行沿用原题时限，随后保留 cleanup 期限，再给导出和校验独立 export 期限。Pier 外层 agent 期限覆盖三者，并留 15 秒退出余量。正常取消保留收到的响应前缀，缺失 usage 保持未知；部分响应、文件缺失、写入失败和损坏 ZIP 分别记录。v2 的 `evidence.valid` 表示证据链路有效，`archive_valid` 表示归档结构有效，`recording` 与 `usage` 分别描述记录和计量覆盖程度；正常部分记录可以是有效结果。

`recover-export` 在 retained Home 的副本中重新导出，输出到 run 下独立的 `recoveries/`。它不调用模型，不覆盖原 attempt、评分或失败状态。恢复导出完成只表示新归档已通过结构校验，不表示原始记录失败得到修复。恢复容器退出前将副本与新产物的所有权交还宿主用户，私有权限保持不变；不会修改原 Home 的所有权。清理、恢复和执行共享位于 run 目录之外的所有权锁，删除 run 不会解除另一个进程持有的锁。

Linux 源码准备与发行资产使用同一 watcher 构建器，固定 Parcel 源码及 EINTR 补丁，验证实际 native binding。首次准备需要额外的固定 Node 编译镜像。

Pier 0.3.1 的独立 verifier 由本包的 `BenchmarkTrial` 固定生命周期：评分环境准备和评分仍使用原题期限，容器清理在评分结果提交后进行；评分超时不自动重跑。清理另有期限及所有权审计，清理失败保持为基础设施问题，不会丢掉已有评分。该边界依赖固定版本 Pier 的扩展接口，升级依赖必须同时通过独立 verifier、超时与取消测试；来源与许可证位于 `third_party/pier/`。

`resume` 也会检查 attempt 内的原始执行记录与 CLI 终态事件；宿主在汇总落盘前退出时，已有终态会重建证据并修复调度状态，模型调用数保持为零。缺失评分、导出或计量文件仍保留对应问题，不会由恢复动作补成成功。
