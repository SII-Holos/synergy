# 多 Harness × 多模型本地评测

配置 v2 分离 harness、model、task 和 repeat；结果 v4 分离执行、原生 reward、判题状态、清理、归档和计量覆盖。Synergy、Codex CLI、OpenCode、Pi、DeepSeek Harness 保留各自的提示词、工具、循环与压缩策略。评测层负责冻结输入、安装、受限网络、请求账本、独立判题和统计报告。

## 开始实验

需要 POSIX 宿主（Linux、macOS 或 WSL）、Python 3.12、uv、Docker Linux containers 和源码声明的 Bun 版本。首次准备下载不可变输入和依赖，后续复用缓存。编辑 [A/B 配置](configs/ab.yaml) 的独立模型端点、协议、模型名和凭据环境变量引用。

```bash
bun bench list
bun bench plan benchmark/configs/local24-boyue.yaml
bun bench run benchmark/configs/local24-boyue.yaml
```

`run` 冻结配置、源码和题单后直接执行正式任务，按需准备任务镜像并复用缓存。首个模型请求属于正式任务或其辅助工作，没有独立探针、预热阶段或启动前 oracle 门槛。可用 `prepare CONFIG` 单独冻结输入；`resume RUN` 只派发从未启动的项。完整 [local-24 配置](configs/local24-boyue.yaml) 使用修复依赖的 24 题、两个冻结版本、一次重复，共 48 项，默认自动并发；运行前填写自己的模型端点和凭据环境变量。

单项解题、构建、判题、归档或计量失败写入记录后继续，未知评分不填成 0。无法保存记录、无法确认所属进程已清除、Docker 或共享凭据失效等全局条件阻止后续派发；已阻塞运行保留原因，修复后创建新实验。整项执行不自动重试。清理超时警告保留；确认资源已移除时不据此否定有效评分和归档。取舍见[直接执行与资源调度](../docs/decisions/implemented/simplification/2026-09-23-benchmark-direct-execution.md)。

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

| 字段                                         | 含义                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `harnesses.<name>`                           | 原生 `kind`、固定 package version 或源码、Synergy runtime/config/experiment          |
| `harnesses.<name>.bun_jit`                   | Synergy / OpenCode 可选布尔值；省略使用原生默认值，false 显式关闭 Bun JIT            |
| `models.<name>`                              | 模型 ID、协议、端点、凭据环境变量名、上下文/输出限制、采样与推理参数                 |
| `matrix.include` / `exclude`                 | 指定或排除 harness/model 组合；省略 include 时展开完整矩阵                           |
| `suite`                                      | 锁定的题目清单、上游 revision 和内容摘要                                             |
| `selection.tasks` / `tags` / `limit`         | 明确任务、必须同时满足的标签、按 ID 排序后的数量上限                                 |
| `selection.cells`                            | 精确选择 task/harness/model/repeat 单元，保留原矩阵的冻结优先顺序                    |
| `repeat` / `task_repeats`                    | 默认每题重复次数及逐题覆盖                                                           |
| `seed` / `concurrency`                       | 固定调度与分析 seed；默认 `auto` 按可用资源调度；正整数手动设置执行并发上限，包括 48 |
| `resources`                                  | Docker 配额预留、构建并发、缓存预算和磁盘余量                                        |
| `platform`                                   | 默认 `linux/amd64`；原始镜像也必须支持该架构                                         |
| `request_idle_timeout_seconds`               | 网关等待上游数据的期限，默认 null，不额外限制；正整数显式启用并冻结为实验条件        |
| `cleanup_seconds` / `export_timeout_seconds` | 独立清理与导出期限，默认 60 / 300 秒                                                 |
| `preparation_timeout_seconds`                | 准备期限，默认 1800 秒                                                               |
| `startup_timeout_seconds`                    | harness 启动到首个实际模型请求的期限，默认 120 秒；正式解题时钟从首次派发开始        |

正式解题、oracle 参考解执行和判题分别统一使用 10800 秒上限，由配置模块中的唯一常量定义。题目清单不接受逐题期限，实验配置不接受 `timeout_seconds` 或 verifier 期限覆盖；旧字段会报错，必须删除后才能准备新的实验。冻结 `plan.json` 的 `task_timeout_seconds` 记录同一预算，每次启动的 `inputs/options.json` 与 Pier 解题、判题参数均由它的唯一实现来源产生。所有预设和新增 YAML 走同一执行逻辑，[传播测试](test/test_experiment_presets.py)自动发现预设，真实 Docker 回归验证短时限任务仍可完成解题和判题。原始任务文件、旧计划及失败记录保持完整；它们不为新执行提供时限。历史实验只使用其已封存的报告。

[GLM 验收示例](configs/glm53-acceptance.yaml) 声明五种 harness、六道题，以及证书和多语言任务各三次重复，共 50 个评分单元。[GLM 长会话示例](configs/glm53-long-session.yaml) 使用相同任务与重复安排，并显式选择 `opencode-jitless`；两者与其他预设使用相同的三小时执行预算。平台实现不绑定该模型或智谱端点。

正式解题时钟从首个实际模型请求开始计时；Synergy 内部 CLI 的兜底期限包含启动和清理余量，不能先耗尽解题预算。准备、排队、导出和判题不占模型解题预算，模型在任务中安装依赖属于解题时间。网关默认不设读空闲期限，断连仍会报错，连接建立保留 30 秒期限。准备及清理期限不是正式题目预算，不得截断它。取舍见[统一三小时策略](../docs/decisions/implemented/architecture/2026-09-22-benchmark-fixed-three-hour-budget.md)。

模型协议为 `chat-completions` 或 `responses`。`supports_developer_role` 显式声明是否支持 developer 消息；采样和推理参数以模型 profile 为准，记录原生参数到有效参数的差异。Codex 原生使用 Responses；跨协议调用保留桥版本、转换前后请求和原始响应。桥不执行工具、不增加 agent 循环、不自行压缩历史。加密推理状态、previous_response_id、托管搜索等无法表示的能力明确报错。Codex 的原生 hosted web search 显式关闭，这属于实验条件。

Chat Completions profile 支持严格布尔值 `enable_thinking`；使用服务商实际接受的开关，不把 `false` 当成启用 reasoning 的信号。网关从原生请求移除所有受管参数后应用冻结 profile，因此辅助调用不能自行启用思考。[Boyue 编码观察预设](configs/coding-observations-boyue.yaml) 固定关闭思考及三道原生筛查题；运行前将占位端点写入私有配置，并通过 `BOYUE_API_KEY` 注入凭据。端点、凭据和直连配置保持在本地，完整评测另建实验并移除选题限制。参数语义见[开关决策](../docs/decisions/implemented/architecture/2026-09-21-benchmark-explicit-thinking-switches.md)。

启用思考的模型 profile 必须同时声明 `reasoning_effort`；思考档位是实验条件，不是实现细节。[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) 始终思考、只接受 `thinking.type: enabled`，并通过 `reasoning_effort` 暴露 `low`、`high`、`max` 三档且以 `max` 为服务商默认值，因此省略该参数等于静默选用最深档位。预设把档位写进模型键名（`glm53flash-max`）并显式设值，使该条件同时体现在 variant 名（`synergy-max-full__glm53flash-max`）、冻结的 `plan.json` 和账本保留的有效请求参数中。更低的档位是各自独立、各有证据的条件，不能用来重新解释已完成的运行。该规则由[预设契约](test/test_experiment_presets.py)强制，取舍见[档位决策](../docs/decisions/implemented/architecture/2026-09-20-benchmark-explicit-reasoning-tier.md)。

各辅助模型角色指向当前 cell 的模型，账本核对实际 model 字段。Synergy 的 core、core-library、full 是不同条件；full 失败不得自动改跑 core。源码变体冻结 Git tracked 与非 ignored untracked 内容、删除项、权限和内部 symlink；拒绝外部 symlink 与 submodule。执行只读取冻结副本，不运行可变 checkout。

历史基线 `v3.0.22` 必须使用明确的 release revision，按 `synergy-session-v1` 执行原生单体 CLI，只接受 `full`，不支持实验覆盖。归档保留原生 Home 和事件，工作进程继承 transport redirect，独立观察器在包装进程中记录已派发的请求，并与网关核对。原生进程退出后只在清理期限内完成观察；任务取消或超时立即中断，未知用量保持未知。不会生成该版本没有的 rollout/run 记录。其他历史布局须先审计再支持，取舍见[历史 release 评测](../docs/decisions/implemented/architecture/2026-09-21-benchmark-session-export-release.md)。

Synergy 和 OpenCode 的 `bun_jit: false` 映射为原生进程的 `BUN_JSC_useJIT=0`；它是运行时执行条件，可能改变延迟和资源消耗。需要比较时声明独立名称，例如 `opencode-native` 和 `opencode-jitless`。该值随配置和每次尝试的有效环境冻结，不改变模型、提示词、工具或压缩策略，也不根据宿主或失败结果自动切换。Synergy 的开关在启动 Bun 包装进程前生效，由 CLI、子进程和导出过程继承；模型密钥引用仍通过独立临时文件传递。其他 harness 使用此选项会报错。运行时适配的取舍见[矩阵决策](../docs/decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md)。

人工取消的执行保留首次评分、原生 reward 和全部消耗，并通过 `pairing_exclusions: [cancelled_execution]` 公开排除配对差值。按预先声明期限自然超时的尝试仍属于原实验条件；不能把人工提前结束伪装成相同期限的超时，也不能以取消为由挑选后续更高分的尝试。

API key 通过 `api_key_env` 引用，保留在宿主账本服务中。容器使用本次尝试的临时入口凭据，经 0600 文件传入、读取后删除。每次尝试均有新 Home、进程和任务可写层。服务商 prompt cache 独立存在，fresh Home 不等于远端 cold cache。

配置只接受 version 2 的 harness/model matrix；`variants` 输入、`normalize` 命令及自动转换均不存在。计划格式为 4，attempt 格式为 5；报告、检查、恢复与离线诊断拒绝其他版本。历史文件与冻结 evaluator 原样保留，历史成本通过 `prior_costs` 引用已封存汇总的标签、SHA-256、已观察请求数、已知 token 下界及缺失项，不重新解释旧记录。`--include-run` 只接受当前格式；历史账本不参与新实验评分。

两种 Synergy 启动适配都先使用各自原生 Session API 创建 `interaction.mode=unattended` 的会话，再把会话 ID 交给原生 CLI；子会话继承此属性。`question` 在可用工具目录中被禁止；异常交互调用保留错误，不代填答案。`--non-interactive` 和 stdin 状态不能替代会话属性。local-24 预设将主模型和辅助角色统一设为 Boyue `glm-5.3-flash`，显式 enabled thinking、low reasoning、temperature 1、1048576 context、131072 output。

## 数据集和网络

[local-24](suites/local-24.json) 固定 12 个 DeepSWE 1.1 原题和 12 个 Terminal-Bench 2.1 原题。原选择使用 seed 0 对任务名做 SHA-256 排序并按语言/类别分层，只纳入 Linux CPU、最多 4 CPU / 8192 MiB 的任务，没有按模型表现选题。这个本地样本不代表官方榜单或统计显著性。

Provenance: [DeepSWE 锁定源码](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)、[Terminal-Bench 锁定源码](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b)、[Pier 0.3.1](https://pypi.org/project/datacurve-pier/0.3.1/)。上游内容下载到 ignored cache，完整 checkout 保留许可证。

原始 instruction、镜像语义、资源、网络、collect hook 和 verifier 断言不被改写；执行期限统一由三小时策略拥有。DeepSWE 使用独立 verifier，原生 hook 收集基于 HEAD 的 patch；要求提交的任务不会由评测器代为提交。模型破坏环境后不在判题前偷偷修复。`oracle` 使用 Pier 原生 OracleAgent 在独立环境逐题验证参考解和 verifier，失败题保留在清单中。`oracle-resume RUN` 核对已完成证据或保留中断结果，不自动重新判题。

模型进程接收 Pier 的 `agent_process_env`；Node CLI 显式启用环境代理。Squid 只放行推理入口主机和端口，对该 Docker 主机地址固定 IPv4 解析。准备、清理、verifier 和 agent 的网络环境独立。准备环境不能预置答案或 oracle 产物。

Synergy 的两种原生适配器保留任务镜像的 `HOME` 和 XDG 环境，仅用独立 `SYNERGY_HOME` 隔离产品数据。原生 shell 的环境变量过滤属于被测产品行为；评测器不能搬移依赖缓存来掩盖环境差异。隔离原理与请求关联见[评测修复决策](../docs/decisions/implemented/bug-fix/2026-09-22-benchmark-execution-evidence-integrity.md)。

并发为 1 时按冻结 `schedule` 执行；并发大于 1 时所有正式项进入同一资源队列，同题不同版本可同时运行。配对关系用于报告，seed 固定优先顺序，`dispatch_sequence` 记录实际派发顺序。每项使用独立容器项目、工作区、运行目录、网关端口和账本。原生 reward 为 0 不改变调度；证据缺陷限制报告的配对资格，不阻止其他任务。

## 证据与统计

```text
run/
  owner.json
  plan.json
  state.json
  evaluator/
  evaluator.json
  inputs/<variant>/
  trials/<index>/attempt-001/
    trial.json
    environment.json
    cleanup.json
    stages.json
    resources.json
    resource-samples.jsonl
    scheduling.json
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

账本在发送网络请求前持久化意图，正常结束、错误、取消、未知送达和缺失 usage 分开记录。原生记录交叉核对主任务、辅助调用、重试和压缩请求。累计 usage 帧及重复终态不重复计量；未知输入/输出保留已知下界，缓存和推理保持输入/输出子集关系。字节不冒充 token。Synergy 继续使用公开 rollout/accounting 合同：网关返回带命名空间的 `X-Request-ID`，与原生归档的响应头关联后，再核对请求摘要和逐次 usage。没有响应头的历史或中断记录只允许唯一请求摘要匹配；重复、矛盾或缺失证据不能由聚合用量补足。Codex 使用原生 token_usage_record 的 response ID，与账本中的下游 response ID 逐条核对，累计事件不重复计量。协议桥同时保留转换前后的响应字节。

每个计划单元只启动一次；恢复先核对终态、归档和账本摘要，已启动但中断的项保留中断状态，不产生替代 attempt。终态缺失或损坏单列证据问题，不自动重跑。改变 evaluator、Python 版本、冻结输入或任务摘要会拒绝续跑。`run` 冻结并调用本次 evaluator；`resume` 和 `debug` 只接受相同 evaluator 身份与当前格式，版本不符明确报错，不自动转交旧 evaluator。

用户明确授权补跑时，用新配置的 `selection.cells` 列出所需的 `task`、`harness`、`model` 和从 0 开始的 `repeat`，然后执行 `bun bench run CONFIG` 创建新运行。该选择在矩阵展开后过滤，不改变 seed 决定的优先顺序，不自动加入另一侧或新增重复；空列表、重复项、未知项和被其他选择条件排除的项明确报错。配置省略 cells 时执行其他选择条件生成的完整矩阵。保留原运行的失败记录和全部费用，报告明确列出补跑来源及 evaluator 差异，不把两批结果冒充一次完整实验。

```yaml
selection:
  cells:
    - task: deepswe-1.1/drizzle-orm-window-function-builders
      harness: candidate
      model: boyue-glm53flash-low
      repeat: 0
```

报告保留正式任务、辅助请求和失败消耗，并单列封存历史成本。旧配置中的 `preflight_timeout_seconds`、`admission_policy`、`resources.max_concurrency` 被拒绝，不能通过这些字段恢复另一套执行逻辑。CLI 对证据失败、基础设施失败、中断和未启动项返回非零状态；正常答错保留 reward 0。

进行中或中断且未形成终态的 attempt，即使已观测请求都有完整 usage，任务总量也只报告已知下界。逐请求的完整用量照常保留；没有观测到未知请求时不虚构未知调用次数。

原生 reward、判题执行、功能测试启动、归档有效性、记录覆盖和 usage 完整性彼此独立。reward.txt 不证明测试已启动；只有原生日志或测试报告中的正面证据才能确认启动，其他情况保持 unknown。部分记录可构成有效失败证据。

流式请求收到首段数据时立即保存 `first_byte_at`；进行中的推理或正文输出不记为等待首字节。`model_waiting` 表示尚未结束的请求总数，逐请求的 `response_started` 区分已开始响应与仍未收到数据；usage 在实际收到前保持未知。

发布版 Synergy 的本地请求观察器关闭 HTTP 服务默认的空闲超时，模型流中途暂时没有数据时不会额外截断请求。解题、显式网关读空闲配置和清理分别使用各自已冻结的时限；观察器不增加隐含的更短限制。相关故障与回归见[转发层空闲超时复盘](../docs/postmortem/0024-benchmark-session-relay-idle-timeout.md)。

`progress.json` 每五秒保存完成数、活跃容器项、排队项、模型响应等待及资源压力原因；状态变化时打印进度。每项结束后自动更新 `reports/current`；整个运行完成、中断或阻塞时再次生成报告，派生报告写入失败不丢弃原始记录。`report` 输出 JSON、全部尝试 CSV、含未启动项的逐题配对 CSV 和离线中文 HTML。每对保留评分、失败原因、输入/输出/cache token、已知下界、耗时、排队时间及缺失项；JSON 同时包含符合条件的配对差值和数量。成功率仅在计划单元的 reward 全部可见时给出；缺失时公开上下界和原因。Wilson 区间描述已观测 reward。横向差值限定同模型、任务、repeat 和实验条件，公开缺失配对，用固定 seed 按任务聚类 bootstrap。只有完整可核对的用量参与精确 token 差值。没有版本化价格来源就不换算货币，订阅 token 不虚构金额。`--include-run` 将关联实验的全部消耗纳入报告，但评分仍来自位置参数指定的 run；不得在看到分数后更换评分 run。不同模型在同一 harness 下作描述性比较，不混入同模型配对 bootstrap。

跨 run 配对同时核对实际并发上限、实验 seed、Docker 配额、可用资源预算及已声明的生命周期/资源策略。当前记录缺失这些条件时排除配对差值，不填入推断值。不同 harness variant 是被比较的因素；宿主瞬时负载只作观测记录，不假设各次运行的负载相同。

## 缓存、并发与维护

### 离线轨迹诊断

`uv run --locked --project benchmark python -m synergy_bench.trajectory /absolute/path/to/run --output /absolute/path/to/analysis` 只读分析保留的 Chat Completions wire 与 Synergy v1 rollout，输出 JSON 和逐请求、工具、会话、消息、调用用途、schema、内容重复暴露的 CSV。输出目录必须位于证据树之外；该入口不启动模型、容器、重判或 resume，也不替换正式评分报告。

重试保留每次派发；请求体摘要重复时，仅在两侧数量相等后按时间排序关联，并明确标记推断匹配。未知 usage 保留已知字段下界，缺失账本元数据直接报错，未观测到的 native transport attempts 阻止精确总量。`trials`、`debug` 和 `recoveries` 分开统计；多个运行分别解析后可汇总成本，不能把补充运行的高分替换首次评分。

token 来自服务商 usage，缓存属于 input、reasoning 属于 output；已有输入／输出但缺少相应子集字段时，缓存率／推理占比保持未知。历史内容与工具 schema 只报告 UTF-8 字节，不按字节比例伪造精确 token。模型／工具耗时按区间并集统计，首字节不等于首 token；多任务的全局并集也不等于逐题解题时间之和。工具分类、相同参数调用和消息前缀相等都是诊断信号，不能直接认定冗余、缓存可命中或可无损裁剪。原生 `contextUsage` 的归因字段保留其估算性质。额度和货币折算需要独立、带日期的套餐规则及账户证据，此模块不将 token 等同于订阅额度。

默认导出不含提示词、工具参数或工具输出正文；仍含任务名、请求标识和时间等研究元数据，应按原证据的访问范围保存。用临时合成证据验证解析器：`uv run --locked --project benchmark pytest benchmark/test/test_trajectory.py`。分析约定见[离线轨迹诊断决策](../docs/decisions/implemented/testing/2026-09-20-offline-trajectory-diagnostics.md)。

### 运行资源与缓存维护

`concurrency: auto | 正整数` 是唯一并发入口，支持 48；所有正式项共享队列，同题两侧可以同时执行。自动模式根据待执行项和实时资源补位。解题初始工作集按 1 GiB、0.25 CPU（小于该额度的原生硬限制取较小值），另加现有 128 MiB、0.2 CPU 开销；容器保留原生硬限制。每秒通过本地 Docker Engine API 采样工作集与 CPU；内存租约取初始额度与阶段观测峰值的 1.25 倍中较大者，CPU 按实测需求更新。首个有效采样前逐项放行，缺失或过期采样暂停新增，未知用量不能当作空闲。

每次派发检查宿主、Docker、cgroup 可用内存、磁盘压力和 Docker 地址池剩余子网，默认固定预留 2 GiB 和 2 CPU；CPU 连续饱和三秒时暂停新增，恢复后补位。冻结资源上界限制总租约，实时可用量控制实际准入；资源变空闲后可以超过启动时的并发水平。冻结顺序定义优先级，支持有界轻任务补位；并发 1 严格顺序执行。调度原因、真实容器启动顺序、阶段排队保存在 `scheduling.json`。资源与缓存锁排队不消耗准备或判题时限。

准备、解题、判题、封存分别管理资源。独立 verifier 在解题容器移除后优先申请租约；同容器判题原位切换，不申请重复额度。容器确认移除才释放额度；封存及报告不占整题资源。桥接网络按实际 Docker 地址池、已占用网络和宿主路由计量：普通环境需要一个子网，带独立出口代理的环境需要两个；不足时等待释放，读取失败时暂停新增，不修改 daemon 配置或清理其他网络。构建并发为 2，按缓存身份加锁，等锁时不持有解题额度；实际构建预留 2 CPU、4 GiB。采样完整日志追加到 `resource-samples.jsonl`，摘要保留最新样本和观测峰值。机器持续无可用资源且没有活动项时有界失败，保留未派发项；不停止活跃项来腾出容量。

暖任务镜像按原题内容、原生声明、安装步骤和平台复用。冻结镜像缺失或 ID 改变会报错；正式任务按需构建或复用镜像。正常清理只删除本次容器、网络和卷，避免 Pier 的 `--rmi all` 删除共享镜像。缓存发布校验内容、按键合并构建并原子发布。活动构建/运行与回收互斥，冻结 run 持有产物引用；只回收明确属于 benchmark 的无引用对象，不自动认领共享镜像。

任务与推理代理镜像的身份包含解析后的缓存根目录摘要。同一缓存的不同路径别名共享镜像，独立缓存使用不同标签及归属记录。迁移缓存目录后应冻结新实验；旧实验继续使用原位置及记录的 evaluator。此隔离不改变任务或代理镜像的构建步骤。

维护边界：`config.py` 与 `harnesses.py` 拥有矩阵和原生映射；`gateway.py` / `bridge.py` / `usage.py` 拥有协议及计量；`trial.py` / `environment.py` 拥有固定 Pier 生命周期扩展；`cache.py` / `resources.py` / `scheduling.py` / `monitor.py` 拥有准备和资源；`evidence.py` / `results.py` / `report.py` 拥有结果和统计。上游来源与修改边界保留在 [Pier NOTICE](third_party/pier/NOTICE)。

```bash
uv run --locked --project benchmark pytest benchmark/test
uv run --locked --project benchmark ruff check benchmark
uv run --locked --project benchmark mypy --config-file benchmark/pyproject.toml benchmark/src/synergy_bench
bun run --cwd benchmark test
bun run --cwd benchmark typecheck
SYNERGY_BENCH_DOCKER=1 uv run --locked --project benchmark pytest -s benchmark/test/test_matrix_docker.py
SYNERGY_BENCH_DOCKER=1 uv run --locked --project benchmark pytest -s benchmark/test/test_docker.py
```

普通测试不启动 Docker 或付费模型；Docker 接入使用确定性 provider。故障注入在测试进程中缩短时钟或修改一次性 TrialConfig，不向生产配置暴露短期限入口。30 MiB / 30,720 checkpoint 的长流成功、取消和失败测试分别运行，允许 20 分钟测试期限，不改变正式任务的三小时上限。实际 provider 验收留在隔离本地环境。新 CI runner 必须安装自己的执行和构建依赖。

Synergy 长会话控制的覆盖范围、确定性 provider 请求体容量与 CI 编排期限见[矩阵决策](../docs/decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md)。CI job 的总期限不改变单个用例或正式评测的三小时期限。

原生 Pi 压缩测试通过多次真实工具输出构造足够历史，并提供明确的确定性 usage 触发其原生阈值；要求会话记录包含 compaction、工具任务通过，且主调用与压缩调用均逐条核对。精确 token 差值要求全部请求关联覆盖和总量核对都完整，不能只靠累计用量相等。

退出码：0 编排结束且证据有效（包括正常答错）；1 基础设施、导出或记录失败；2 配置或输入无效；130 中断。进度写 stderr，最终 JSON 写 stdout。

评测器不覆盖被测 harness 的读取策略或提示词；这些行为由冻结源码决定。工具输出字节用于诊断信息暴露，不能直接换算为任务 token 或额度收益。

原生 oracle 记录可通过 `oracle-report RUN --output REPORT.json` 只读导入。报告读取明确的 `reward` 主字段，并保留 DeepSWE 的辅助指标；不会再次执行判题或改写旧记录。

隔离的性能验收使用确定性 provider、固定 Pi 安装包和含 Git 的轻任务，对 1/2/4/6 并发各执行 12 次。每次请求固定延迟 2 秒，工具任务执行固定 CPU 工作并分配 192 MiB；报告分别记录初始化、执行时间、吞吐和资源峰值。第一轮任务镜像冷准备，其后必须没有重复构建或拉取。运行期间应让其他实验结束，避免把共享预算的排队计入吞吐对比：

```bash
SYNERGY_BENCH_PERFORMANCE=1 SYNERGY_BENCH_NATIVE_ARTIFACTS='{"pi":"/absolute/path/to/prepared-pi"}' \
  uv run --locked --project benchmark pytest -s benchmark/test/test_performance_docker.py
```

完整矩阵共享只读安装包挂载和镜像前置依赖，镜像按需准备并以缓存锁合并构建；每个 harness/model 在正式执行中记录其真实运行结果。冻结输入受 run 引用保护，执行期间允许回收其他无引用缓存。缺失的冻结镜像只能恢复到记录的 image ID；重新构建应使用新的缓存目录和实验，原实验继续只读保留。

CI 使用轻量确定性任务（1 核、2 GiB），并为临时 runner 显式设置 10 GiB 缓存、2 GiB 磁盘余量。研究实验仍默认 32 GiB 缓存与 20 GiB 余量；CPU/内存预留不变。CI 配置依据 [GitHub 标准 runner 资源说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，实际可用资源由调度器检查。

runtime 缓存按实际执行入口区分：Synergy 由 Bun 执行 `trial.ts`，其配方覆盖 TypeScript 源码及共享的 `deadline.mjs`；外部 CLI 由 Node 执行 `external.mjs`，其独立安装产物对 `engines.NATIVE_RUNTIME` 中全部入口和 capture helper 求摘要。外部 CLI 不执行 Synergy bundle 内附带的 `.mjs` 副本。增加 Synergy 使用的非 TypeScript 依赖时，必须同步扩展其配方与失效回归；不得把新执行依赖排除在缓存身份之外。每个已冻结 bundle 仍逐字节校验自身 receipt。

CI 保留 `archive.json`、`export.json` 和归档验证结果。外部 CLI 的 `rollout.tar.gz` 包含原生 Home（包括认证存储），因此只在本地私有实验中保留，不上传 CI artifact；这与 Synergy 公开 rollout 合同的 `rollout.zip` 不同。省略原生 Home payload 是证据发布边界，不能省略本地归档校验或用量核对。

Docker `exec` 未显式指定命令期限时继承调用方的原生阶段期限；准备阶段默认 1800 秒上限不能截断原生 10800 秒的 agent 执行。显式命令期限仍有效，取消仍回收所属进程树。跨阶段期限回归同时验证未指定、显式长期限和准备期限；不能只用短任务证明长任务可靠。阶段失败保留异常类型、模块、函数、行号和因果链，不持久化异常文本、源代码行或局部变量；可结合冻结源码定位原因，避免错误值携带凭据。

父进程异常退出后的恢复先交还容器私有日志的文件所有权，再读取原有终态；交接保持文件内容与 0600/0700 权限，通过原容器的不可变镜像完成，运行中和已停止的容器均可恢复。

OOM 通过本地 Unix Docker Engine API 在执行期间持续订阅并落盘，关闭时按容器 ID、纳秒时间戳和事件类型合并并去重最终事件窗口，避免遗漏已发生但尚未消费的事件。订阅中断或只能取得历史窗口时，精确 OOM 数保持 unknown，另列已观察到的下界；远端 Docker 端点目前只有历史窗口覆盖。CPU/容器工作集峰值来自每秒采样，报告保留采样间隔并声明可能漏过短峰值。

运行时 Home 是私有恢复输入，可能包含密钥库；`evidence.json` 的文件清单不遍历 `agent/home`，也不跟随目录符号链接。可共享的 Synergy 执行证据使用已验证的 `rollout.zip`，恢复过程仍可读取保留的私有 Home。

CI 的生命周期和矩阵任务共用 `benchmark/src/synergy_bench/ci_evidence.py` 收集诊断，只复制明确列出的证据文件，跳过 native home、wire、输入目录与符号链接；单个不可读文件不会丢弃其他诊断，收集错误单独保留。显式 `preparation` 分组保留缓存准备目录直属的配方摘要日志，使 trial 创建之前的依赖或镜像失败仍可诊断；不递归进入未发布的构建目录，也不跟随缓存父目录的符号链接。

轨迹分析的输出目录必须与输入证据树互不包含，不能选输入目录、其子目录或祖先目录。缺失响应或未识别的非 SSE 响应标记为 `stream_framing: unknown`，正文与工具流指标保持未知；`stream_invalid_lines` 单独计数解析失败，原始响应字节仍来自 wire 记录。

缺失终态证据或 native attempt 对应的 wire 记录时，用途分组与总体摘要的 `total_tokens` 都保持未知，已观察到的 token 下界仍保留；用途未知的缺口不能据此断言其他用途已完整。
