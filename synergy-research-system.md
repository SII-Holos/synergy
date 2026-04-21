# Synergy Research System — 内置科研能力深度集成方案

> Version: Draft v5 — 2026-04-21
> Status: 待讨论

---

## 一、愿景

Synergy 进化为「面向科研的 AI 合作伙伴」。

**核心理念：Human-in-the-Loop Research Partner**

不是 idea → paper 的流水线。而是一个能跑代码、查文献、跑实验、写 LaTeX 的「超级博士生」，和你深度协作，你做决策，它做执行。

**Nature 级别的标准意味着**：
- 每个 idea 可能要反复推翻重来十几次
- 实验方案要反复斟酌
- 所有过程（成功的、失败的、推翻的）都要完整留存——补充材料可能 100+ 页
- 实验的自动化程度可以高，但 idea 和方案层必须 human-in-the-loop

---

## 二、架构核心：Research State = 项目目录中的真实文件

### 2.1 设计原则

**类比 Git**：`.git/` 在项目目录里，VS Code 的 Git Panel 是 `.git/` 的可视化视图。

同理：`research/` 在项目目录里，Synergy 的 Research Panel 是 `research/` 的可视化视图。

- **Agent** 用标准 write/edit/read 操作这些文件，不需要新工具
- **前端** 通过 API 读取这些文件，渲染成看板
- **多 session** 共享同一个目录（同 scope），自然协作
- **所有过程都留存**：成功的、失败的、推翻的，全在目录里

### 2.2 目录结构

```
my-research/                                       ← scope directory
├── code/                                          ← 实验代码（git 管理）
├── data/                                          ← 数据
├── paper/                                         ← LaTeX 论文（用户直接编辑）
│   ├── main.tex
│   ├── sections/
│   ├── figures/
│   ├── references.bib → ../.research/literature/references.bib
│   ├── supplementary.tex
│   └── build/main.pdf
│
└── .research/                                     ← 隐藏控制面（类似 .git/）
    ├── state.yaml                                 ← 全局状态（唯一的结构化 YAML，工具程序化读写）
    ├── CONTEXT.md                                 ← 新 session 的研究简报（agent 每次更新）
    ├── ASSETS.md                                  ← 可复用资产（模型 API、数据集路径、checkpoint）
    ├── decisions.jsonl                            ← 决策日志（append-only，唯一的 JSONL）
    │
    ├── ideas/                                     ← Idea 库
    │   ├── round-1/
    │   │   ├── 001-factorized-gap.md              ← markdown + frontmatter (status, derived_from)
    │   │   ├── 002-token-merging.md
    │   │   └── 003-pruning-hybrid.md
    │   ├── round-2/
    │   │   └── 009-combined.md                    ← derived_from: [002, 005]
    │   └── round-3/
    │       └── ...
    │
    ├── plans/                                     ← 方案版本
    │   ├── v1-initial.md                          ← frontmatter: status: superseded
    │   └── v2-current.md                          ← frontmatter: status: active
    │
    ├── experiments/                               ← 实验记录
    │   ├── sanity/
    │   │   └── s001-smoke-test.md                 ← 一个实验 = 一个 markdown（frontmatter 含 config/metrics/status）
    │   ├── baselines/
    │   │   └── b001-transformer.md
    │   ├── main/
    │   │   ├── m001-method-v1.md                  ← status: failed, failure_reason: "gradient detach"
    │   │   └── m003-method-v3.md                  ← status: completed, metrics: {ppl: 18.3}
    │   └── ablations/
    │       ├── a001-no-attention.md
    │       └── a002-no-residual.md
    │
    ├── literature/
    │   ├── survey.md                              ← 领域综述
    │   ├── by-topic/                              ← 按主题的阅读笔记
    │   │   ├── discrete-diffusion.md
    │   │   └── language-modeling.md
    │   ├── key-papers/                            ← 重要论文精读笔记
    │   │   └── austin2021-d3pm.md
    │   └── references.bib                         ← 统一 BibTeX
    │
    └── reviews/
        ├── internal-round-1.md
        └── internal-round-2.md
```

**关键设计决策**：

1. **`.research/` 隐藏目录**：和 `.git/` 同理，状态管理不暴露在项目根目录。
2. **paper/ 在项目根目录**：用户直接编辑 LaTeX，不在隐藏目录里。
3. **只有 2 个结构化文件**：`state.yaml`（工具程序化读写）和 `decisions.jsonl`（append-only 日志）。其余全是 markdown。
4. **一个实验 = 一个 markdown**：不再是目录套 config.yaml + result.json + notes.md。frontmatter 含结构化信息，正文含笔记。工具解析 frontmatter 建立索引。
5. **ASSETS.md 是 markdown**：用户和 agent 都可以直接编辑。

#### 实验 markdown 示例

```markdown
---
id: m003
group: main
name: method-v3-final
status: completed
backend: inspire
job_id: job-xxx-yyy-zzz
created: 2026-06-15
method_version: v3
code_commit: a1b2c3d

environment:
  platform: inspire
  workspace: 分布式训练空间
  compute_group: cuda12.8版本H100
  gpu: H100 SXM 80GB × 8
  image: docker-qb.sii.edu.cn/inspire-studio/my-train:v3
  shm_gi: 1200

hyperparameters:
  learning_rate: 1e-4
  batch_size: 128
  max_steps: 50000
  seeds: [42, 123, 456]
  datasets: [wikitext-103, c4]

metrics:
  wikitext_ppl: { mean: 18.3, std: 0.2 }
  c4_ppl: { mean: 21.1, std: 0.3 }
---

## Notes

Multi-seed 实验验证了 v3 方法的稳定性。在 wikitext 上 PPL 18.3±0.2，比 baseline 20.5 提升 10.7%。

### Seed-level Results

| Dataset | Seed 42 | Seed 123 | Seed 456 | Mean ± Std |
|---------|---------|----------|----------|------------|
| WikiText | 18.1 | 18.5 | 18.3 | 18.3 ± 0.2 |
| C4 | 20.8 | 21.3 | 21.2 | 21.1 ± 0.3 |

### Observations

- v3 相比 v2 的关键改进是修复了残差连接的梯度断开问题
- C4 上的提升不如 WikiText 显著，可能和数据分布有关
```

#### Idea markdown 示例

```markdown
---
id: "009"
title: Factorized gap + token attention pruning
status: selected
round: 2
derived_from: ["002", "005"]
selected_by: user
selected_date: 2026-05-05
---

## Core Insight

Combine the factorization approach from idea #002 with the token-level pruning from #005...

## Novelty Analysis

- 与 Wang et al. 2025 的区别：他们只做了 global factorization，我们引入 token-level 选择性...
- 与 Chen et al. 2026 的区别：他们的 pruning 是 static 的，我们是 dynamic attention-based...

## Feasibility

- 预计 GPU 小时：~200h（H100）
- 数据需求：WikiText-103 + C4
- 主要风险：dynamic pruning 可能引入训练不稳定性
```

#### ASSETS.md 示例

```markdown
# Research Assets

## Models (API)

- **Qwen-72B (学院内部)**: endpoint `https://internal.sii.edu.cn/v1`, model `qwen2.5-72b`, 无 token 限制
- **DeepSeek-V3**: 通过 Synergy SII API 代理 (`apicz.boyuerichdata.com`)
- **GPT-4o**: 通过 Synergy 配置的 OpenAI provider

## Datasets

- **WikiText-103**: `/inspire/hdd/project/multi-agent/data/wikitext-103`
- **C4 (subset)**: `/inspire/hdd/project/multi-agent/data/c4-subset`
- **OpenWebText**: 需要下载，约 40GB

## Checkpoints

- **LLaMA-3-8B**: `/inspire/hdd/project/multi-agent/models/llama3-8b` (通过 CPU 空间从 hf-mirror 下载)

## WandB

- Entity: `my-team`, Project: `discrete-diffusion`

## 启智平台

- 项目: 大模型时代下的多智能体系统
- 默认空间: 分布式训练空间
- 默认镜像: `docker-qb.sii.edu.cn/inspire-studio/my-train:v3`
- 存储根目录: `/inspire/hdd/project/multi-agent/`
```

### 2.3 state.yaml（唯一的结构化 YAML）

```yaml
project: "Factorized Gap in Discrete Diffusion LMs"
created: 2026-04-20
updated: 2026-06-15

stages:
  explore: completed
  refine: completed
  experiment: active
  review: active
  writing: active
  submission: inactive

focus:
  active_idea: "009"
  active_plan: v2-current
  running_experiments: [m003]
  blocked_on: null
  next_action: "Wait for m003 multi-seed results, then start ablations"

progress:
  ideas: { total: 14, selected: 1, rejected: 8, exploring: 1 }
  plans: { total: 2, active: 1, superseded: 1 }
  experiments: { total: 12, completed: 7, failed: 3, running: 2 }
  paper: { sections_done: 3, sections_total: 7 }
  literature: { papers: 78, key_papers: 12 }
```

工具只操作这个文件。不直接编辑 idea/experiment markdown（那些由 skill + agent 维护）。

### 2.4 为什么这能支撑数月的 Nature 级研究

| 挑战 | 应对 |
|------|------|
| **30+ ideas** | 按 round 分目录 + frontmatter 记录关系（derived_from）+ 工具动态建索引 |
| **100+ 实验** | 按 phase 分目录 + 一个实验一个 markdown（frontmatter 含完整 config/metrics）|
| **失败留存** | status: failed + failure_reason 在 frontmatter，正文写分析 |
| **代码追踪** | frontmatter 记录 code_commit |
| **环境快照** | frontmatter 的 environment 块（image digest, GPU, shm） |
| **非线性** | stages 多个 active |
| **跨 session** | CONTEXT.md 自动更新 |
| **80+ 文献** | by-topic/ + key-papers/ + references.bib |
| **资产复用** | ASSETS.md 一次配置，所有 session 读取 |
| **控制面整洁** | .research/ 隐藏，不污染项目目录 |

### 2.5 Scope 与 Research 的关系

任何 project scope 都可以变成 research scope：agent 创建 `.research/` 目录 + `state.yaml` 即可。

多 session 共享同一 `.research/` 目录。新 session 读 `CONTEXT.md` 获取研究简报。

---

## 三、Research Tools（纯状态管理，不执行实验）

Agent 直接用 write/edit 维护 YAML 文件太脆弱（语法错误、字段遗漏、闭合问题）。关键的结构化操作应该封装成工具，就像 `inspire_config` 封装了 config 编辑一样。

### 3.1 工具清单

| 工具 | 职责 | 替代了什么 |
|------|------|-----------|
| `research_init` | 初始化 `research/` 目录结构 + `state.yaml` | agent 手动 mkdir + write |
| `research_state` | 读写 state.yaml（get/set/update） | agent 手动 edit state.yaml |
| `research_idea` | 注册/更新/查询 idea（自动维护 _index.yaml 和关系图） | agent 手动写 idea markdown + 编辑 _index.yaml |
| `research_experiment` | 注册/更新/查询实验（自动维护 config.yaml、_index.yaml、_comparison.yaml） | agent 手动创建实验目录 + 写多个文件 |
| `research_log` | 追加决策日志条目到 decisions/log.jsonl | agent 手动 append JSONL |
| `research_context` | 读取/更新 CONTEXT.md（新 session 自动读取） | agent 手动读写 CONTEXT.md |

### 3.2 工具设计

#### `research_init`

```
research_init(
  project: "Factorized Gap in Discrete Diffusion LMs",
  venue?: "ICML 2027",
  participation_mode?: "collaborative"
)
```

内部创建完整目录结构（ideas/, plans/, experiments/, literature/, decisions/, paper/, reviews/）+ state.yaml + CONTEXT.md。

**如果 `research/` 已存在**：返回当前状态，不覆盖。Agent 每次进入 research session 时先调这个，既是初始化也是"载入上下文"。

#### `research_idea`

```
# 注册新 idea
research_idea(action="add", round=2, title="Combined factorization + pruning",
  description="...", derived_from=["002", "005"])

# 更新 idea 状态
research_idea(action="update", id="009", status="selected", reason="Best novelty + feasibility", decided_by="user")

# 列出 ideas
research_idea(action="list", status="exploring")  → 返回所有 exploring 的 idea
research_idea(action="list")                       → 返回全部 idea 摘要
```

内部自动：
- 创建/更新 `ideas/round-N/xxx.md` 文件
- 更新 `ideas/_index.yaml` 的索引和关系图
- 追加 `decisions/log.jsonl` 条目（如果 status 变更）
- 更新 `state.yaml` 的 progress 计数

#### `research_experiment`

```
# 注册新实验
research_experiment(action="add", group="main", name="method-v3",
  command="python train.py --config v3.yaml",
  backend="inspire",                                # inspire | local | api
  hyperparameters={ learning_rate: 1e-4, batch_size: 128 },
  seeds=[42, 123, 456],
  datasets=["wikitext", "c4"])

# 更新实验状态（如从 inspire_jobs 获取结果后）
research_experiment(action="update", id="m003", status="completed",
  results={ wikitext_ppl: 18.3, c4_ppl: 21.1 })

# 标记实验失败
research_experiment(action="update", id="m001", status="failed",
  failure_reason="gradient detachment in residual branch")

# 列出实验
research_experiment(action="list", group="main")
research_experiment(action="compare", ids=["b001", "m002", "m003"])  → 对比表
```

内部自动：
- 创建 `experiments/{group}/{id}/` 目录 + config.yaml（含完整环境快照）
- 记录 code commit hash（从 git 读取）
- 更新 `experiments/_index.yaml`
- 更新 `experiments/_comparison.yaml`（compare action 时）
- 更新 `state.yaml` 进度

**如果 backend="inspire"**：自动调用 `inspire_submit`，拿到 job_id 写入 config.yaml
**如果 backend="local"**：通过 bash 在本地执行
**如果 backend="api"**：从 research assets 读取 API 配置，构造调用

#### `research_log`

```
research_log(description="Rejected idea #012 — too similar to Chen et al. 2026",
  decided_by="user", stage="explore", refs=["idea-012"])
```

简单的 append-only 日志。每次关键决策调用一次。

#### `research_context`

```
# 读取（新 session 开始时）
research_context(action="read")  → 返回 CONTEXT.md 内容

# 更新（重要进展后）
research_context(action="update", status="Main experiments",
  recent_decision="Selected method v3",
  next_action="Wait for m003 results",
  key_results=["baseline PPL 20.5", "method-v3 preliminary PPL 18.1"])
```

### 3.3 工具加载条件

当前 scope 目录下存在 `.research/` 目录时自动加载。

### 3.4 关键原则

**工具只管状态，不执行实验。** `research_experiment(action="add")` 只注册一条实验记录，不调用 `inspire_submit`。实验执行由 skill 编排：

```
Skill: research-experiment
  1. 调用 inspire_submit / bash（执行实验）
  2. 拿到 job_id / result
  3. 调用 research_experiment(action="update", id="m003", job_id="...", status="running")（记录状态）
```

**工具不生成创意内容。** Idea 的描述、实验的分析笔记、文献综述——这些由 agent 用 write/edit 直接操作 markdown。工具只维护 frontmatter 和 state.yaml 的结构化字段。

---

## 四、Research Assets

### 4.1 问题

数月研究中有大量跨 session 复用的资源：模型 API、数据路径、checkpoint、wandb 配置等。每个 session 都重新获取太浪费。

### 4.2 设计

一个 markdown 文件：`.research/ASSETS.md`。Agent 直接 read，用户直接编辑。不需要工具。

```markdown
# Research Assets

## Models (API)
- **Qwen-72B (学院内部)**: endpoint `https://internal.sii.edu.cn/v1`, model `qwen2.5-72b`, 无 token 限制
- **DeepSeek-V3**: 通过 Synergy SII API 代理

## Datasets
- **WikiText-103**: `/inspire/hdd/project/multi-agent/data/wikitext-103`
- **C4 (subset)**: `/inspire/hdd/project/multi-agent/data/c4-subset`

## Checkpoints
- **LLaMA-3-8B**: `/inspire/hdd/project/multi-agent/models/llama3-8b`

## WandB
- Entity: `my-team`, Project: `discrete-diffusion`

## 启智平台
- 存储根目录: `/inspire/hdd/project/multi-agent/`
- 默认镜像: `docker-qb.sii.edu.cn/inspire-studio/my-train:v3`
```

Skill 的 description 告诉 agent："实验前先读 `.research/ASSETS.md` 获取可用资源。"

---

## 五、多后端实验支持

### 5.1 不是所有实验都需要 GPU

| 实验类型 | 后端 | 示例 |
|---------|------|------|
| GPU 训练 | inspire_submit | 大规模 LM 预训练、fine-tuning |
| 本地训练 | bash (local) | 小 baseline、debug、prototype |
| API 推理 | bash (curl/python) | 调用部署的 Qwen/GPT 做 inference evaluation |
| 数据分析 | bash (local python) | 统计分析、可视化、格式转换 |
| 理论验证 | bash (local) | 数学推导的数值验证 |
| HPC 计算 | inspire_submit_hpc | CPU 密集的数据预处理 |

### 5.2 `research_experiment` 的 backend 参数

```
backend: "inspire"   → 自动调用 inspire_submit，记录 job_id
backend: "local"     → 通过 bash 在本地执行，记录 PID
backend: "api"       → 从 assets.yaml 读取 API 配置，构造调用脚本
backend: "manual"    → 只注册实验记录，实际执行由用户手动完成
```

**inspire 不是默认值**。默认值应该是从 `state.yaml` 的 `config.inspire` 存在与否推断：有 inspire 配置 → 默认 inspire；没有 → 默认 local。

---

## 六、Skill 重组优化（Nature 级深度分析）

### 6.1 Nature 级研究各阶段的 skill 需求分析

#### 阶段 A：探索（月 1-2）

| 需要做的事 | 当前 skill 覆盖？ | 差距 |
|-----------|------------------|------|
| 广度文献调研（50-100 篇） | ✅ search-papers | 需要 batch 搜索 + 自动分类 |
| 深度精读关键论文 | ❌ | 缺少「精读一篇论文并提取方法/贡献/局限」的 skill |
| Gap 分析 | ✅ research-explore | — |
| Idea 生成 + 新颖性验证 | ✅ research-explore | — |
| **Related work positioning** | ❌ | Nature 级别需要精确定位贡献相对已有工作的位置。目前无此 skill |
| **领域 landscape map** | ❌ | 需要一个可视化的领域全景图：谁在做什么、方法分类、趋势 |

**补充 skill**：`research-position` — 精确定位贡献在领域中的位置，输出 contribution statement + positioning diagram

#### 阶段 B：方案细化（月 3-4）

| 需要做的事 | 当前 skill 覆盖？ | 差距 |
|-----------|------------------|------|
| 方法细化 | ✅ research-refine | — |
| 实验计划 | ✅ research-refine | — |
| **理论推导** | 🟡 proof-write, formula-derive | 需要和方案细化更紧密集成 |
| **可行性分析** | ❌ | 方案确定前需要 compute budget 估算、数据需求分析 |
| **Baseline 选择论证** | ❌ | 为什么选这些 baseline？需要有理有据的论证 |

**改进**：research-refine 增加「可行性分析」步骤——估算 GPU 小时、数据量、timeline

#### 阶段 C：实验（月 5-6）

| 需要做的事 | 当前 skill 覆盖？ | 差距 |
|-----------|------------------|------|
| 代码实现 | ✅ research-experiment | — |
| 基线对齐 | ✅ research-experiment | — |
| 多 seed/dataset 实验 | ✅ research-experiment | 需要 research_experiment 工具支持 |
| 消融实验设计 | ✅ experiment-audit (ablation-planner) | — |
| **统计显著性检验** | ❌ | Nature 要求 p-value、confidence interval、effect size |
| **Training dynamics 分析** | ❌ | loss curve 分析、learning rate schedule 可视化 |
| **Negative result 分析** | ❌ | 失败实验不是浪费，需要分析为什么失败、学到了什么 |

**补充**：analyze-results skill 增加统计检验 + training dynamics + negative result analysis

#### 阶段 D：审核与迭代（贯穿全程）

| 需要做的事 | 当前 skill 覆盖？ | 差距 |
|-----------|------------------|------|
| 跨模型审核 | ✅ research-review | — |
| 实验审计 | ✅ experiment-audit | — |
| **Claim-evidence matrix** | ❌ | 每个 claim 对应哪些实验证据？缺失证据自动标记 |
| **Reproducibility checklist** | ❌ | Nature 有明确的 reproducibility 要求清单 |

**补充**：`research-verify` — claim-evidence matrix + reproducibility checklist

#### 阶段 E：写作（月 7-8）

| 需要做的事 | 当前 skill 覆盖？ | 差距 |
|-----------|------------------|------|
| 大纲 | ✅ paper-plan | — |
| 逐章写作 | ✅ paper-write | — |
| 图表 | ✅ paper-figure | 需要统一风格系统 |
| 补充材料 | 🟡 | 需要从 experiments/ 自动生成 |
| **Introduction 的 story** | ❌ | Nature 的 intro 需要极强的 narrative。「问题→已有方法的局限→我们的 insight→贡献」 |
| **Abstract 反复打磨** | ❌ | 150-250 字的 abstract 决定论文第一印象 |

**改进**：paper-plan 增加 narrative structure 模板（Nature/ICML/NeurIPS 各不同）

### 6.2 更新后的 Skill 清单

#### Research Core — 8 个（增加 2 个）

| Skill | 职责 | 新增/改动 |
|-------|------|----------|
| `research-explore` | 文献调研 → gap 分析 → idea 生成 → 新颖性验证 | 使用 `research_idea` 工具管理 ideas |
| `research-position` | **NEW** — 精确定位贡献、生成 contribution statement | 输出 positioning diagram + related work 框架 |
| `research-refine` | 方案细化 + 实验计划 + **可行性分析** | 增加 compute/data budget 估算 |
| `research-experiment` | 代码实现 → 基线对齐 → 部署 → 收集 | 使用 `research_experiment` 工具，**多后端**（inspire/local/api） |
| `research-monitor` | 监控 + 结果分析 + claim mapping | 增加**统计检验**和 **negative result analysis** |
| `research-review` | 跨模型审核 | — |
| `research-verify` | **NEW** — claim-evidence matrix + reproducibility checklist | Nature 级别的最终验证 |
| `research-wiki` | 持久化知识库 | — |

#### Paper Writing — 5 个（不变但内部优化）

| Skill | 改动 |
|-------|------|
| `paper-plan` | 增加 venue-specific narrative template |
| `paper-write` | 自动从 experiments/ 生成 supplementary。Abstract 反复打磨。 |
| `paper-figure` | 统一风格系统。自动检测图表类型选择最佳工具。 |
| `paper-rebuttal` | — |
| `paper-present` | — |

#### 其他 — 12 个（不变）

Math (2) + Search (3) + Patent (2) + Infra (1) + Utility (4)

### 6.3 研究流程中的 Tool ↔ Skill 分工

```
Tools（结构化操作，可靠）          Skills（编排逻辑，灵活）
─────────────────────            ─────────────────────
research_init                    research-explore 调用 research_idea(add)
research_idea                    research-refine 调用 research_log
research_experiment              research-experiment 调用 research_experiment(add) + inspire_submit
research_log                     research-monitor 调用 research_experiment(update) + inspire_jobs
research_context                 research-verify 调用 research_experiment(compare)
research_state                   paper-write 读取 experiments/ 生成 supplementary
```

**原则**：
- **结构化数据变更** → Tool（保证格式正确、索引一致）
- **创意内容生成** → Agent 直接 write（idea 的描述、论文正文、实验分析）
- **流程编排** → Skill（什么时候调什么 tool/做什么分析）

---

## 七、实现优先级（不含前端）

### Phase 1：Foundation（2 周）

1. **6 个 Research Tools** 实现（research_init, research_state, research_idea, research_experiment, research_log, research_context）
2. **目录结构规范**确定（state.yaml schema, config.yaml schema, _index.yaml schema）
3. **assets.yaml 规范**

### Phase 2：Core Skills（3-4 周）

4. **8 个 research-core skills**（从 ARIS 精炼，集成 research tools + inspire tools）
5. **research-pipeline** 编排 skill（human checkpoint 在每个阶段）

### Phase 3：Paper Skills（2 周）

6. **5 个 paper skills**
7. **图表风格系统**
8. **补充材料自动生成**

### Phase 4：Remaining + Polish（2 周）

9. **Patent / Math / Search / Utility skills**
10. **条件加载机制**
11. **Engram 集成**（跨项目科研经验）

### 3.1 定位

Research Panel 是 scope 的 `research/` 目录的**实时可视化视图 + 交互控制台**。

**它不是独立的数据存储**——它读写的都是项目目录中的真实文件。

### 3.2 功能模块

```
┌─────────────────────────────────────────────────┐
│  🔬 Research Panel                    [scope名] │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─ Progress ──────────────────────────────┐    │
│  │  Stage: 🟡 Experiment                   │    │
│  │  ████████░░░░░░ 58%                     │    │
│  │  Ideas: 5/8 explored, 1 selected        │    │
│  │  Experiments: 7/12 done, 2 running      │    │
│  │  Paper: 3/7 sections                    │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  [Ideas] [Plans] [Experiments] [Paper] [Log]    │
│  ─────────────────────────────────────────────  │
│                                                 │
│  (tab content below)                            │
│                                                 │
└─────────────────────────────────────────────────┘
```

**Tab: Ideas** — Idea 看板
- 每个 idea 是一张卡片（从 `ideas/*.md` 读取）
- 卡片显示 title、status、关键句
- 用户可以：拖拽排序、标记 selected/rejected、写批注、创建新 idea
- 修改直接写回对应的 markdown 文件

**Tab: Plans** — 方案版本
- 显示 `plans/` 下的所有方案版本
- 当前 active 方案高亮
- 点击可查看完整方案内容
- 可以对比不同版本的 diff

**Tab: Experiments** — 实验看板
- 实时状态：从 `experiments/*/job.json` + `inspire_jobs` 合并
- 每个实验一行：名称、状态(✅❌🔄⏳)、关键 metric、运行时长
- 点击展开详情（config、result、notes）
- 失败实验也清晰展示，附失败原因

**Tab: Paper** — 论文
- Section 列表 + 完成状态
- 点击 section → 显示 LaTeX 源码（可编辑）
- PDF 预览按钮 → 调用 tectonic 编译后显示
- 图表预览

**Tab: Log** — 决策日志
- 时间线视图，显示所有决策记录
- 每条记录标记 who（user / agent / collaborative）
- 可搜索和过滤

### 3.3 "老板视图" 功能

Research Panel 还承担监控功能：

- **活跃 Session 列表**：当前 scope 下有哪些 session 在工作，每个在做什么（最近的工具调用摘要）
- **Agent 活动流**：实时显示 agent 的工具调用（类似 DAG 的 node 进度，但更轻量）
- **实验队列**：正在运行和排队的 inspire 任务

### 3.4 文件 ↔ 前端 的映射

| 前端操作 | 文件操作 |
|---------|---------|
| 拖拽 idea 卡片排序 | 更新 `state.yaml` 的 idea 排序字段 |
| 标记 idea 为 selected | 修改 `ideas/xxx.md` 的 YAML header `status: selected` |
| 写批注 | 追加到 `ideas/xxx.md` 或 `experiments/xxx/notes.md` |
| 编辑 LaTeX section | 直接编辑 `paper/sections/xxx.tex` |
| 查看 PDF | 编译 `paper/main.tex` → 读取 `paper/build/main.pdf` |
| 查看实验结果 | 读取 `experiments/xxx/result.json` |
| 查看决策日志 | 读取 `decisions/log.jsonl` |

所有操作最终都是文件读写。前端不维护独立状态。

---

## 四、Skill 重组（从 68 → ~25）

### 4.1 Research Core — 6 个

| Skill | 合并自 | 核心改动 |
|-------|--------|---------|
| **`research-explore`** | idea-discovery + research-lit + novelty-check | 产出写入 `research/ideas/` 和 `research/literature/`。每个 idea 独立 markdown。每步暂停等用户选择。 |
| **`research-refine`** | research-refine + experiment-plan | 产出写入 `research/plans/`。多版本保留。用户必须 approve plan 才能进入实验。 |
| **`research-experiment`** | experiment-bridge + parallel-experiment-engine + run-experiment + baseline-alignment | 通过 inspire_submit 提交。每个实验写入 `research/experiments/xxx/`。失败的也保留。自动创建 agenda 监控。 |
| **`research-monitor`** | monitor-experiment + training-check + analyze-results + result-to-claim | agenda tool watch 监控。结果写入 `research/experiments/xxx/result.json`。自动更新 `state.yaml`。 |
| **`research-review`** | auto-review-loop (3 variants) + research-review | 统一跨模型审核。审核结果写入 `research/reviews/`。每轮保留。 |
| **`research-wiki`** | research-wiki | 改为读写 `research/literature/` 和 engram 系统。跨项目经验存 engram。 |

### 4.2 Paper Writing — 5 个

| Skill | 合并自 | 核心改动 |
|-------|--------|---------|
| **`paper-plan`** | paper-plan | 大纲写入 `research/paper/outline.md`。用户确认后分拆到 `sections/`。 |
| **`paper-write`** | paper-write + paper-compile + auto-paper-improvement-loop | 逐章写入 `research/paper/sections/`。编译用 tectonic。自动生成补充材料（从 experiments/ 汇总）。 |
| **`paper-figure`** | paper-figure + paper-illustration + figure-spec + mermaid-diagram | 统一图表生成，产出存入 `research/paper/figures/`。 |
| **`paper-rebuttal`** | rebuttal | 保留，审稿意见和回复存入 `research/reviews/`。 |
| **`paper-present`** | paper-poster + paper-slides | 合并。 |

### 4.3 其他 — 14 个

| 分组 | Skill | 来源 |
|------|-------|------|
| Math (2) | `proof-write`, `formula-derive` | 合并 proof-writer+checker；保留 formula-derivation |
| Search (3) | `search-papers`, `search-web`, `search-domain` | 合并 arxiv+semantic-scholar+alphaxiv+deepxiv；保留 exa；保留 comm-lit-review |
| Patent (2) | `patent-draft`, `patent-review` | 合并各6+4个 |
| Infra (2) | `sii-inspire`(已完成), `gpu-cloud` | 合并 vast+modal |
| Utility (5) | `grant-proposal`, `experiment-audit`, `writing-guide`, `system-profile`, `pixel-art` | 精简 |

### 4.4 删除的

| 删除 | 理由 |
|------|------|
| qzcli | 已废弃 → sii-inspire |
| auto-review-loop-llm / minimax | 合入 research-review |
| experiment-queue | SSH 专用，inspire 不需要 |
| feishu-notify | 用 Synergy agenda + channel |
| aris-update | 内置不需要自更新 |
| meta-optimize | 变为内部工具 |
| shared-references | 内容合入各 skill |

---

## 五、Human-in-the-Loop 设计

### 5.1 三种参与度模式

在 `state.yaml` 的 `config.participation_mode` 中设置：

**Collaborative**（默认）：
- 每个阶段转换都暂停等用户
- Idea 选择暂停、方案确认暂停、实验批准暂停、结论审核暂停
- 适合重要研究、新方向

**Guided**：
- 只在关键里程碑暂停：idea 选择、plan 批准、final 结论
- 实验部署、文献搜索、代码实现自动进行
- 适合有经验的研究者

**Autonomous**：
- 只在异常时暂停（实验全部失败、结果不合理、deadline 临近）
- 适合消融实验、格式排版等低风险任务

### 5.2 Idea 迭代流程

Nature 级别研究的核心：idea 的反复推翻和迭代。

```
研究者: "我想探索 discrete diffusion LM 方向"

Agent: 调用 research-explore → 文献调研 → 生成 8 个 idea
       → 写入 research/ideas/001.md ~ 008.md
       → 在 Research Panel Ideas tab 显示 8 张卡片

研究者: 在 Panel 里看了几个 idea，觉得 #002 和 #005 有意思，标记为 "exploring"
         给 #003 写了批注 "这个和 XXX 2025 的工作太像了"
         标记 #001, #003, #004 为 "rejected"

Agent: 看到用户的选择 → 深入探索 #002 和 #005
       → 生成更细的可行性分析
       → 更新 ideas/002.md 和 ideas/005.md

研究者: 决定 #002 方向 + #005 的某个技术点 → 组合成新 idea #009

Agent: 创建 ideas/009-combined.md
       → 做新颖性验证
       → 初步可行性分析
       → 暂停等用户确认

研究者: "好，就做 #009，但把 X 部分改成 Y"

Agent: 更新 ideas/009-combined.md，标记 status: selected
       → 进入 research-refine 阶段
```

**关键**：idea 文件永远不删除。推翻的标记为 rejected + 原因。这就是 Nature 级别的补充材料来源。

### 5.3 前端交互

**Ideas 看板**：
- 卡片布局，可拖拽排序
- 颜色标记：🟢 selected / 🟡 exploring / 🔴 rejected / ⚪ proposed
- 点击卡片 → 展开详情，可编辑批注
- 底部 "+" 按钮 → 创建新 idea（或让 agent 生成更多）

**Experiments 看板**：
- 表格视图：实验名 | 状态 | 关键 metric | 运行时长 | 平台任务 ID
- 点击实验 → 展开 config + result + notes
- 可以直接在 notes 里写观察记录
- 右键 → "重新提交"（用相同 config 再跑一次）

---

## 六、Synergy 内部集成

### 6.1 各子系统角色

| 子系统 | 科研用途 | 具体方式 |
|--------|---------|---------|
| **Scope** | 一个 scope = 一个研究项目 | `research/` 目录存在 → Research Panel 显示 |
| **Session** | 多个 session 服务同一个研究 | 共享 `research/` 目录，Panel 显示活跃 session |
| **Agenda** | 实验监控 + 定期汇报 | tool watch on inspire_jobs + 每日研究进度摘要 |
| **Engram** | 跨项目科研经验 | "这个数据集 baseline 是 X"、"H100 上 batch size 最大能到 Y" |
| **Note** | 临时想法、会议记录 | 不存 research state（那在 `research/` 目录里） |
| **DAG** | 单次任务的步骤追踪 | 不替代 research state（DAG 是 session 级、临时的） |
| **Cortex** | 跨模型审核 | reviewer/auditor/scholar agent delegation |
| **Inspire Tools** | 实验执行 | submit/monitor/stop，数据回填到 experiments/ |

### 6.2 Inspire Tools 深度绑定

research-experiment skill 使用 inspire 工具时的完整流转：

```
research-experiment 读取 research/plans/v3-final.md
  → 解析实验列表
  → 创建 research/experiments/exp-004/ 目录 + config.yaml
  → inspire_submit(name="exp-004", command="...", ...)
  → 收到 job_id，写入 experiments/exp-004/job.json
  → 创建 agenda watch 监控
  → agenda 检测到 inspire_jobs 变化
  → 实验完成 → 唤醒 session
  → 提交 CPU job 读取结果文件
  → 结果写入 experiments/exp-004/result.json
  → 更新 state.yaml 的 progress
  → Research Panel 实时刷新
```

### 6.3 自动生成补充材料

paper-write skill 在生成论文时，自动从 `research/experiments/` 汇总：

```latex
% supplementary.tex — 自动生成
\section{Complete Experiment Log}

\subsection{Experiment 001: Baseline}
Config: ... (from config.yaml)
Result: ... (from result.json)
Notes: ... (from notes.md)

\subsection{Experiment 002: Method v1 (Failed)}
Config: ...
Result: FAILED — loss divergence at step 500
Root cause: gradient detachment in residual branch
Notes: "发现 v1 的残差连接写错了，修复后变成 v2"

...（所有实验，包括失败的）
```

---

## 七、实现路径

### Phase 1：Research Directory + Core Skills（3-4 周）

1. **定义 research/ 目录规范**（state.yaml schema、ideas/plans/experiments 文件格式）
2. **6 个 research-core skill**（从 ARIS 精炼，inspire 集成，human checkpoint）
3. **research-pipeline skill**（编排 6 个 core skill）
4. **条件加载机制**（`research.enable` config toggle）

### Phase 2：Paper Skills + LaTeX（2 周）

5. **5 个 paper skill**
6. **LaTeX 编译集成**（tectonic + PDF 输出到 research/paper/build/）
7. **图表风格系统**

### Phase 3：Research Panel 前端（3-4 周）

8. **Panel 框架**（检测 research/ 目录，显示 state.yaml 概览）
9. **Ideas Tab**（卡片看板，拖拽，标注）
10. **Experiments Tab**（实验表格，inspire 状态合并）
11. **Paper Tab**（LaTeX section 列表 + PDF 预览）
12. **Log Tab**（决策时间线）

### Phase 4：Polish + 剩余 Skills（2 周）

13. **Patent / Math / Search / Utility skills**
14. **Engram 集成**（跨项目经验）
15. **"老板视图"**（活跃 session、agent 活动流）

---

## 八、开放问题

1. **Research Panel 作为独立面板还是 Side Panel 的一个 Tab？** — Side Panel 已经有 note、agenda、session。再加一个 research tab？还是 research 作为独立面板（像 Terminal Panel 那样可以独立展开）？

2. **LaTeX 编译：tectonic 还是 texlive？** — tectonic 单二进制轻量但包不全；texlive 完整但重。建议 tectonic + 按需下载缺失包。

3. **Ideas 看板的编辑体验** — 用户直接在前端编辑 markdown 内容？还是只能标记状态和写批注，完整编辑交给 agent 或编辑器？

4. **research/ 目录是否要 git 管理？** — 自动 commit 每次重要变更？便于版本对比和回滚。

5. **多人协作** — 一个 scope 目前是单用户的。未来如果多人共享一个研究项目，文件冲突怎么处理？

6. **实验结果格式** — 统一的 result.json schema？还是让每个实验自定义？统一 schema 有助于 Panel 渲染和跨实验对比，但灵活性低。
