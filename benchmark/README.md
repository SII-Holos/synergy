# 多 Harness × 多模型本地评测

配置 v2 分离 harness、model、task 和 repeat；结果 v3 分离执行、原生 reward、判题状态、归档和计量覆盖。Synergy、Codex CLI、OpenCode、Pi、DeepSeek Harness 保留各自的提示词、工具、循环与压缩策略。评测层负责冻结输入、安装、受限网络、请求账本、独立判题和统计报告。

## 开始实验

需要 POSIX 宿主（Linux、macOS 或 WSL）、Python 3.12、uv、Docker Linux containers 和源码声明的 Bun 版本。首次准备下载不可变输入和依赖，后续复用缓存。编辑 [A/B 配置](configs/ab.yaml) 的独立模型端点、协议、模型名和凭据环境变量引用。

```bash
bun bench list
bun bench plan benchmark/configs/ab.yaml
bun bench prepare benchmark/configs/ab.yaml
bun bench prewarm /absolute/path/to/run
bun bench doctor /absolute/path/to/run
bun bench resume /absolute/path/to/run
```

`run config.yaml` 串联上述流程。`prewarm` 准备 agent 与独立 verifier 镜像，不调用模型或执行 oracle。`doctor` 在一次性任务环境中经过实际网络策略、原生 harness、流式记录和工具结果；调用消耗计入报告，预检产物不进入正式任务。预检失败阻止正式运行。

```bash
bun bench inspect /absolute/path/to/run --trial 0
bun bench report /absolute/path/to/run --output /absolute/path/to/report
bun bench report /absolute/path/to/scoring-run --include-run /absolute/path/to/related-run
bun bench compare /absolute/path/to/run /absolute/path/to/run --left-harness baseline --right-harness candidate --model selected
bun bench compare /absolute/path/to/run-a /absolute/path/to/run-b --left-harness baseline --right-harness baseline --left-model first --right-model second
bun bench oracle benchmark/suites/local-24.json --output /absolute/path/to/oracle-runs --cache /absolute/path/to/cache
bun bench debug /absolute/path/to/run --trial 0
bun bench recover-export /absolute/path/to/run --trial 0 --attempt 1
bun bench cache /absolute/path/to/cache
bun bench cache /absolute/path/to/cache --collect
bun bench clean /absolute/path/to/run
```

`debug` 创建独立 attempt；`recover-export` 在 retained Home 副本中重新导出，不调用模型、不替换评分或原失败状态。`clean` 明确删除指定实验的证据及所属容器、网络和卷，并释放缓存引用。所有操作遵循实验所有权锁，不执行全局 Docker prune。

## 配置与实验条件

相对路径以 YAML 所在目录为基准。未知字段、不支持的模型参数、缺失的凭据引用和无法表示的原生配置均报错。

| 字段                                         | 含义                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `harnesses.<name>`                           | 原生 `kind`、固定 package version 或源码、Synergy runtime/config/experiment      |
| `harnesses.<name>.bun_jit`                   | OpenCode 可选布尔值；省略使用原生默认值，false 显式关闭其内嵌 Bun JIT            |
| `models.<name>`                              | 模型 ID、协议、端点、凭据环境变量名、上下文/输出限制、采样与推理参数             |
| `matrix.include` / `exclude`                 | 指定或排除 harness/model 组合；省略 include 时展开完整矩阵                       |
| `suite`                                      | 锁定的原题清单、上游 revision、内容摘要及原生期限                                |
| `selection.tasks` / `tags` / `limit`         | 明确任务、必须同时满足的标签、按 ID 排序后的数量上限                             |
| `repeat` / `task_repeats`                    | 默认每题重复次数及逐题覆盖                                                       |
| `seed` / `concurrency`                       | 固定调度与分析 seed；默认并发 `auto`，初始上限 8                                 |
| `resources`                                  | Docker 配额预留、构建并发、缓存预算和磁盘余量                                    |
| `platform`                                   | 默认 `linux/amd64`；原始镜像也必须支持该架构                                     |
| `timeout_seconds`                            | 可选 agent 期限；省略时保留原题期限                                              |
| `cleanup_seconds` / `export_timeout_seconds` | 独立清理与导出期限，默认 60 / 300 秒                                             |
| `preparation_timeout_seconds`                | 准备期限，默认 1800 秒                                                           |
| `startup_timeout_seconds`                    | harness 启动到首个实际模型请求的期限，默认 120 秒；原题 agent 时限从首次派发开始 |

[GLM 验收示例](configs/glm53-acceptance.yaml) 声明五种 harness、六道原题，以及证书和多语言任务各三次重复，共 50 个评分单元。平台实现不绑定该模型或智谱端点。

模型协议为 `chat-completions` 或 `responses`。`supports_developer_role` 显式声明是否支持 developer 消息；采样和推理参数以模型 profile 为准，记录原生参数到有效参数的差异。Codex 原生使用 Responses；跨协议调用保留桥版本、转换前后请求和原始响应。桥不执行工具、不增加 agent 循环、不自行压缩历史。加密推理状态、previous_response_id、托管搜索等无法表示的能力明确报错。Codex 的原生 hosted web search 显式关闭，这属于实验条件。

各辅助模型角色指向当前 cell 的模型，账本核对实际 model 字段。Synergy 的 core、core-library、full 是不同条件；full 失败不得自动改跑 core。源码变体冻结 Git tracked 与非 ignored untracked 内容、删除项、权限和内部 symlink；拒绝外部 symlink 与 submodule。执行只读取冻结副本，不运行可变 checkout。

OpenCode 的 `bun_jit: false` 映射为原生进程的 `BUN_JSC_useJIT=0`；它是运行时执行条件，可能改变延迟和资源消耗。需要比较时声明独立名称，例如 `opencode-native` 和 `opencode-jitless`。该值随配置和每次尝试的有效环境冻结，不改变模型、提示词、工具或压缩策略，也不根据宿主或失败结果自动切换。其他 harness 使用此选项会报错。运行时适配的取舍见[矩阵决策](../docs/decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md)。

API key 通过 `api_key_env` 引用，保留在宿主账本服务中。容器使用本次尝试的临时入口凭据，经 0600 文件传入、读取后删除。每次尝试均有新 Home、进程和任务可写层。服务商 prompt cache 独立存在，fresh Home 不等于远端 cold cache。

v1 配置仅供显式迁移：

```bash
bun bench normalize old.yaml --models bindings.yaml --output new.yaml
```

bindings 文件需要完整 `models`，以及旧 `provider/model` 到新模型键的 `bindings`。评测器不从历史结果推断模型限制。新 CLI 拒绝直接执行 v1；旧结果可读、可导入报告，不能用新 evaluator 续跑或补造缺失字段。

## 数据集和网络

[local-24](suites/local-24.json) 固定 12 个 DeepSWE 1.1 原题和 12 个 Terminal-Bench 2.1 原题。原选择使用 seed 0 对任务名做 SHA-256 排序并按语言/类别分层，只纳入 Linux CPU、最多 4 CPU / 8192 MiB 的任务，没有按模型表现选题。这个本地样本不代表官方榜单或统计显著性。

Provenance: [DeepSWE 锁定源码](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)、[Terminal-Bench 锁定源码](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b)、[Pier 0.3.1](https://pypi.org/project/datacurve-pier/0.3.1/)。上游内容下载到 ignored cache，完整 checkout 保留许可证。

原始 instruction、镜像语义、资源、期限、网络、collect hook 和 verifier 不被改写。DeepSWE 使用独立 verifier，原生 hook 收集基于 HEAD 的 patch；要求提交的任务不会由评测器代为提交。模型破坏环境后不在判题前偷偷修复。`oracle` 使用 Pier 原生 OracleAgent 在独立环境逐题验证参考解和 verifier，失败题保留在清单中。`oracle-resume --recorded-evaluator` 核对已完成证据或保留中断结果，不自动重新判题。

模型进程接收 Pier 的 `agent_process_env`；Node CLI 显式启用环境代理。Squid 只放行推理入口主机和端口，对该 Docker 主机地址固定 IPv4 解析。准备、清理、verifier 和 agent 的网络环境独立。预检不能预置解题依赖、答案或 oracle 产物。

## 证据与统计

```text
run/
  owner.json
  plan.json
  state.json
  evaluator/
  evaluator.json
  inputs/<variant>/
  prewarming/
  probes/
  trials/<index>/attempt-001/
    trial.json
    environment.json
    stages.json
    resources.json
    wire/<request-id>/
      request.json
      downstream.json
      upstream.json
      upstream.bin
      downstream.bin
      response.bin
    evidence.json
    sb-.../
      result.json
      agent/
        execution.json
        accounting.json
        archive.json
        export.json
        events.jsonl
        home/
      verifier/
      artifacts/
  debug/
  recoveries/
```

账本在发送网络请求前持久化意图，正常结束、错误、取消、未知送达和缺失 usage 分开记录。原生记录交叉核对主任务、辅助调用、重试和压缩请求。累计 usage 帧及重复终态不重复计量；未知输入/输出保留已知下界，缓存和推理保持输入/输出子集关系。字节不冒充 token。Synergy 继续使用公开 rollout/accounting 合同；按公开归档中的请求摘要逐条核对。Codex 使用原生 token_usage_record 的 response ID，与账本中的下游 response ID 逐条核对，累计事件不重复计量。协议桥同时保留转换前后的响应字节。

报告统计所有 attempts，包括预检和失败重跑；评分预先选定每个计划单元的首次模型执行。已结束的失败是终态，resume 不自动重抽样。恢复先核对原有执行终态、归档和账本摘要，再修复调度状态；改变 evaluator、Python 版本、冻结输入或任务摘要会拒绝续跑。`resume`、`doctor`、`prewarm` 和 `debug` 的 `--recorded-evaluator` 显式使用已校验的冻结评测器；它不会用新代码续跑旧实验。

只有明确发生在首次模型请求前的原生启动超时可以自动重试：原生生命周期确认模型未开始、请求账本目录为空、归档已完成且没有清理错误。预检每次调用最多三次启动尝试；正式任务的三次上限随调度状态持久化，恢复不重置。退避为 1、2 秒，每次创建新的 attempt 并记录原因，原失败证据保持终态。账本残片、送达不明、已请求模型、输出中断或原生判题失败都不进入这条自动重试路径。

CLI 汇总保留全部记录或基础设施失败数，另列已恢复的启动失败和未解决失败。只有同一任务或预检的后续模型尝试留下完整终态证据，才将符合上述条件的早期启动失败计为已恢复；未解决失败或缺失任务返回非零状态。恢复不改变原始失败、分数或全部 attempts 的消耗统计。

原生 reward、判题执行、功能测试启动、归档有效性、记录覆盖和 usage 完整性彼此独立。reward.txt 不证明测试已启动；只有原生日志或测试报告中的正面证据才能确认启动，其他情况保持 unknown。部分记录可构成有效失败证据。

`report` 输出 JSON、CSV 和离线中文 HTML。成功率仅在计划单元的 reward 全部可见时给出；缺失时公开上下界和原因。Wilson 区间描述已观测 reward。横向差值限定同模型、任务、repeat 和实验条件，公开缺失配对，用固定 seed 按任务聚类 bootstrap。只有完整可核对的用量参与精确 token 差值。没有版本化价格来源就不换算货币，订阅 token 不虚构金额。`--include-run` 将关联实验的全部消耗纳入报告，但评分仍来自位置参数指定的 run；不得在看到分数后更换评分 run。不同模型在同一 harness 下作描述性比较，不混入同模型配对 bootstrap。

## 缓存、并发与维护

调度读取 Docker CPU/内存配额，预留至少 2 核及 max(2 GiB, 15%) 内存；不满足静态资源需求时提前报错。宿主内存压力或磁盘余量不足会延迟新任务，不杀正在运行的任务。agent 与独立 verifier 的原生资源声明共同决定准入。8 GB 任务等待时允许有限次数的轻任务补位，随后为队首释放容量；无人运行而宿主持续受压时有界报错。每项准入另计 0.2 核与 128 MiB 的代理和记录服务余量，容器自身的原生资源限制不变。源码和安装包构建预留 2 核、4 GiB，与执行共享预算；构建默认最多两项，跨进程使用可自动释放的锁。实际峰值另行采样，构建资源预留属于准入估计。

暖任务镜像按原题内容、原生声明、安装步骤和平台复用。冻结镜像缺失或 ID 改变会报错；预热与执行使用相同镜像条件。正常清理只删除本次容器、网络和卷，避免 Pier 的 `--rmi all` 删除共享镜像。缓存发布校验内容、按键合并构建并原子发布。活动构建/运行与回收互斥，冻结 run 持有产物引用；只回收明确属于 benchmark 的无引用对象，不自动认领共享镜像。

维护边界：`config.py` 与 `harnesses.py` 拥有矩阵和原生映射；`gateway.py` / `bridge.py` / `usage.py` 拥有协议及计量；`trial.py` / `environment.py` 拥有固定 Pier 生命周期扩展；`cache.py` / `resources.py` / `monitor.py` 拥有准备和资源；`evidence.py` / `results.py` / `report.py` 拥有结果和统计。上游来源与修改边界保留在 [Pier NOTICE](third_party/pier/NOTICE)。

```bash
uv run --locked --project benchmark pytest benchmark/test
uv run --locked --project benchmark ruff check benchmark
uv run --locked --project benchmark mypy --config-file benchmark/pyproject.toml benchmark/src/synergy_bench
bun run --cwd benchmark test
bun run --cwd benchmark typecheck
SYNERGY_BENCH_DOCKER=1 uv run --locked --project benchmark pytest -s benchmark/test/test_matrix_docker.py
SYNERGY_BENCH_DOCKER=1 uv run --locked --project benchmark pytest -s benchmark/test/test_docker.py
```

普通测试不启动 Docker 或付费模型；Docker 接入使用确定性 provider。30 MiB / 30,720 checkpoint 的长流成功、取消和失败测试分别运行，允许 20 分钟测试期限，不改变正式原题时限。实际 provider 验收留在隔离本地环境。新 CI runner 必须安装自己的执行和构建依赖。

原生 Pi 压缩测试通过多次真实工具输出构造足够历史，并提供明确的确定性 usage 触发其原生阈值；要求会话记录包含 compaction、工具任务通过，且主调用与压缩调用均逐条核对。精确 token 差值要求全部请求关联覆盖和总量核对都完整，不能只靠累计用量相等。

退出码：0 编排结束且证据有效（包括正常答错）；1 基础设施、导出或记录失败；2 配置或输入无效；130 中断。进度写 stderr，最终 JSON 写 stdout。

120 行读取下限保留，用于减少过小读取引起的多轮工具调用和重复上下文成本。本轮不修改读取策略、提示词或推理效率，也不把单次返回字节较多直接视为 token 缺陷。

原生 oracle 记录可通过 `oracle-report RUN --output REPORT.json` 只读导入。报告读取明确的 `reward` 主字段，并保留 DeepSWE 的辅助指标；不会再次执行判题或改写旧记录。

隔离的性能验收使用确定性 provider、固定 Pi 安装包和含 Git 的轻任务，对 1/2/4/6 并发各执行 12 次。每次请求固定延迟 2 秒，工具任务执行固定 CPU 工作并分配 192 MiB；报告分别记录初始化、预热、执行时间、吞吐和资源峰值。第一轮任务镜像冷准备，其后必须没有重复构建或拉取。运行期间应让其他实验结束，避免把共享预算的排队计入吞吐对比：

```bash
SYNERGY_BENCH_PERFORMANCE=1 SYNERGY_BENCH_NATIVE_ARTIFACTS='{"pi":"/absolute/path/to/prepared-pi"}' \
  uv run --locked --project benchmark pytest -s benchmark/test/test_performance_docker.py
```

完整矩阵共享只读安装包挂载和镜像前置依赖，预热按题目去重并分批检查缓存预算；每个 harness/model 的真实运行兼容性仍由 doctor 独立检查。冻结输入受 run 引用保护，执行期间允许回收其他无引用缓存。缺失的冻结镜像只能恢复到记录的 image ID；重新构建应使用新的缓存目录和实验，原实验继续只读保留。

CI 使用轻量确定性任务（1 核、2 GiB），并为临时 runner 显式设置 10 GiB 缓存、2 GiB 磁盘余量。研究实验仍默认 32 GiB 缓存与 20 GiB 余量；CPU/内存预留不变。CI 配置依据 [GitHub 标准 runner 资源说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，实际可用资源仍由 doctor 检查。

runtime 缓存按实际执行入口区分：Synergy 由 Bun 执行 `trial.ts`，其配方覆盖 TypeScript 源码及共享的 `deadline.mjs`；外部 CLI 由 Node 执行 `external.mjs`，其独立安装产物对 `engines.NATIVE_RUNTIME` 中全部入口和 capture helper 求摘要。外部 CLI 不执行 Synergy bundle 内附带的 `.mjs` 副本。增加 Synergy 使用的非 TypeScript 依赖时，必须同步扩展其配方与失效回归；不得把新执行依赖排除在缓存身份之外。每个已冻结 bundle 仍逐字节校验自身 receipt。

CI 保留 `archive.json`、`export.json` 和归档验证结果。外部 CLI 的 `rollout.tar.gz` 包含原生 Home（包括认证存储），因此只在本地私有实验中保留，不上传 CI artifact；这与 Synergy 公开 rollout 合同的 `rollout.zip` 不同。省略原生 Home payload 是证据发布边界，不能省略本地归档校验或用量核对。

Docker `exec` 未显式指定命令期限时继承调用方的原生阶段期限；准备阶段默认 1800 秒上限不能截断原生 10800 秒的 agent 执行。显式命令期限仍有效，取消仍回收所属进程树。跨阶段期限回归同时验证未指定、显式长期限和准备期限；不能只用短任务证明长任务可靠。阶段及预热失败保留异常类型、模块、函数、行号和因果链，不持久化异常文本、源代码行或局部变量；可结合冻结源码定位原因，避免错误值携带凭据。

父进程异常退出后的恢复先交还容器私有日志的文件所有权，再读取原有终态；交接保持文件内容与 0600/0700 权限，通过原容器的不可变镜像完成，运行中和已停止的容器均可恢复。

OOM 通过本地 Unix Docker Engine API 在执行期间持续订阅并落盘，关闭时按容器 ID、纳秒时间戳和事件类型合并并去重最终事件窗口，避免遗漏已发生但尚未消费的事件。订阅中断或只能取得历史窗口时，精确 OOM 数保持 unknown，另列已观察到的下界；远端 Docker 端点目前只有历史窗口覆盖。CPU/RSS 峰值来自定期采样，报告保留采样间隔并声明可能漏过短峰值。

CI 的生命周期和矩阵任务共用 `benchmark/src/synergy_bench/ci_evidence.py` 收集诊断，只复制明确列出的证据文件，跳过 native home、wire、输入目录与符号链接；单个不可读文件不会丢弃其他诊断，收集错误单独保留。
