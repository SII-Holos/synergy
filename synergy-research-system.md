# Synergy Research System — 内置科研能力深度集成方案

> Version: Draft v6 — 2026-04-21
> Status: 待实现

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

## 二、架构核心

### 2.1 设计原则

**类比 Git**：`.git/` 在项目目录里，VS Code 的 Git Panel 是 `.git/` 的可视化视图。

同理：`.research/` 在项目目录里，Synergy 的 Research Panel 是 `.research/` 的可视化视图。

- **Agent** 用标准 write/edit/read 操作内容文件（`.md`），不碰元数据文件（`.yaml`）
- **前端** 通过 API 读取这些文件，渲染成看板
- **多 session** 共享同一个目录（同 scope），自然协作
- **所有过程都留存**：成功的、失败的、推翻的，全在目录里

### 2.2 四个一等实体

研究过程中有四种需要结构化管理的实体：

| 实体           | ID 前缀 | 说明                               |
| -------------- | ------- | ---------------------------------- |
| **Idea**       | `idea_` | 研究想法，可以合并、派生、推翻     |
| **Plan**       | `plan_` | 实验方案，多版本迭代，需用户审批   |
| **Experiment** | `exp_`  | 实验记录，从注册到完成的全生命周期 |
| **Review**     | `rev_`  | 审核记录，内部或外部的评审反馈     |

**所有一等实体的模式统一**：`.yaml`（元数据，工具独占）+ `.md`（内容，agent/user 自由编辑）。无例外。

### 2.3 内容与元数据分离

**核心问题**：如果把结构化元数据（status、metrics、config）放在 markdown 的 frontmatter 里，agent 用 write/edit 时可能破坏 frontmatter。靠 convention 保护不可靠。

**解法**：每个一等实体拆成两个文件——元数据由工具独占写入，内容由 agent/user 自由编辑。

- 工具 `list` / `compare` 只读 `.yaml`，不需要解析 markdown，实现简单
- Agent skill description 告知："只编辑 `.md` 文件，元数据由 research 工具管理"
- 前端合并两者展示：yaml 提供结构化字段，md 提供内容
- 文件类型本身就是保护——不需要靠 convention

### 2.4 ID 体系

每个实体类型使用**自增 ID**，从 001 开始：

```
idea_001, idea_002, ..., idea_014
exp_001, exp_002, ..., exp_012
plan_001, plan_002
rev_001, rev_002
```

**设计要点**：

- **Agent 对 ID 生成无感**：调 `research_idea(action="add")` 时工具自动分配 ID，返回值里带 `id: "idea_015"`
- **自增天然有时间线**：编号越大创建越晚，`exp_003` 一定比 `exp_001` 后创建
- **对话中自然引用**："看看实验 7 的结果"、"idea 3 和 5 能不能合并"
- **各类型独立计数**：idea 和 exp 各自从 001 开始
- **计数器存在 state.yaml**：`counters.idea: 14`，工具原子读写

**命名空间 ID**：在 timeline 和跨实体引用中使用完整 ID（`idea_003`、`exp_007`），前缀天然消歧。

### 2.5 目录结构

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
    ├── state.yaml                                 ← 当前快照（config + focus + counters）
    ├── timeline.jsonl                             ← 完整研究轨迹（append-only）
    ├── CONTEXT.md                                 ← 新 session 的研究简报
    ├── ASSETS.md                                  ← 可复用资产（模型 API、数据集路径、checkpoint）
    │
    ├── ideas/                                     ← Idea 库（扁平目录）
    │   ├── idea_001.yaml                          ← 元数据：title, status, round, derived_from
    │   ├── idea_001.md                            ← 内容：insight, novelty, feasibility
    │   ├── idea_002.yaml
    │   ├── idea_002.md
    │   ├── idea_009.yaml                          ← derived_from: [idea_002, idea_005]
    │   └── idea_009.md
    │
    ├── plans/                                     ← 方案版本
    │   ├── plan_001.yaml                          ← 元数据：title, status, idea ref, supersedes
    │   ├── plan_001.md                            ← 内容：完整方案
    │   ├── plan_002.yaml
    │   └── plan_002.md
    │
    ├── experiments/                               ← 实验记录（扁平目录）
    │   ├── exp_001.yaml                           ← 元数据：config, metrics, artifacts, status
    │   ├── exp_001.md                             ← 内容：notes, observations, analysis
    │   ├── exp_007.yaml
    │   └── exp_007.md
    │
    ├── reviews/                                   ← 审核记录
    │   ├── rev_001.yaml
    │   ├── rev_001.md
    │   └── ...
    │
    └── literature/
        ├── survey.md                              ← 领域综述
        ├── by-topic/                              ← 按主题的阅读笔记
        │   ├── discrete-diffusion.md
        │   └── language-modeling.md
        ├── key-papers/                            ← 重要论文精读笔记
        │   └── austin2021-d3pm.md
        └── references.bib                         ← 统一 BibTeX
```

**关键设计决策**：

1. **`.research/` 隐藏目录**：和 `.git/` 同理，状态管理不暴露在项目根目录。
2. **`paper/` 在项目根目录**：用户直接编辑 LaTeX，不在隐藏目录里。
3. **扁平目录**：不按 round/group 建子目录。分组信息（round、group）是元数据，存在 yaml 里，通过 `list` 工具过滤。目录结构简单，文件定位靠 ID 不靠路径。
4. **统一双文件模式**：所有一等实体都是 `.yaml` + `.md`，agent 认知模型只有一条：yaml 是工具管的，md 是我编辑的。
5. **ASSETS.md 是纯 markdown**：用户和 agent 直接编辑，不需要工具。

### 2.6 实体 yaml 示例

#### Idea yaml（idea_009.yaml）

```yaml
id: idea_009
title: "Factorized gap + token attention pruning"
status: selected # proposed | exploring | selected | rejected
round: 2
derived_from: [idea_002, idea_005]
selected_by: user
selected_date: 2026-05-05
created: 2026-05-05
```

#### Plan yaml（plan_002.yaml）

```yaml
id: plan_002
title: "Experiment plan v2 — lightweight factorization"
status: active # draft | active | superseded
idea: idea_014
supersedes: plan_001
approved_by: user
approved_date: 2026-05-28
created: 2026-05-28
```

#### Experiment yaml（exp_007.yaml）

```yaml
id: exp_007
title: "Method v3 multi-seed"
group: main # sanity | baselines | main | ablations
status: completed # registered | running | completed | failed | stopped
backend: inspire # inspire | local | api | manual
idea: idea_014
plan: plan_002
created: 2026-06-08
code_commit: a1b2c3d

# 执行信息
job_id: job-xxx-yyy-zzz
started: 2026-06-08T09:30:00Z
finished: 2026-06-15T20:00:00Z

# 环境
environment:
  platform: inspire
  gpu: "H100 SXM 80GB × 8"
  image: docker-qb.sii.edu.cn/inspire-studio/my-train:v3

# 超参数
hyperparameters:
  learning_rate: 1e-4
  batch_size: 128
  max_steps: 50000
  seeds: [42, 123, 456]
  datasets: [wikitext-103, c4]

# 摘要指标（由工具从结果中提取写入）
metrics:
  wikitext_ppl: { mean: 18.3, std: 0.2 }
  c4_ppl: { mean: 21.1, std: 0.3 }

# 产物路径引用（不复制进 .research/）
artifacts:
  log: /inspire/hdd/project/multi-agent/logs/exp_007.log
  tensorboard: /inspire/hdd/project/multi-agent/runs/exp_007/
  checkpoint: /inspire/hdd/project/multi-agent/checkpoints/exp_007/best.pt
  eval_output: /inspire/hdd/project/multi-agent/results/exp_007/eval.json
```

#### Review yaml（rev_001.yaml）

```yaml
id: rev_001
title: "Internal review round 1"
type: internal # internal | external
status: completed
refs: [exp_007, exp_003]
reviewer: cross-model
created: 2026-06-18
```

### 2.7 实体 md 示例

#### Idea md（idea_009.md）

```markdown
## Core Insight

Combine the factorization approach from idea_002 with the token-level pruning from idea_005...

## Novelty Analysis

- 与 Wang et al. 2025 的区别：他们只做了 global factorization，我们引入 token-level 选择性...
- 与 Chen et al. 2026 的区别：他们的 pruning 是 static 的，我们是 dynamic attention-based...

## Feasibility

- 预计 GPU 小时：~200h（H100）
- 数据需求：WikiText-103 + C4
- 主要风险：dynamic pruning 可能引入训练不稳定性
```

#### Experiment md（exp_007.md）

```markdown
## Notes

Multi-seed 实验验证了 v3 方法的稳定性。在 wikitext 上 PPL 18.3±0.2，比 baseline 20.5 提升 10.7%。

### Seed-level Results

| Dataset  | Seed 42 | Seed 123 | Seed 456 | Mean ± Std |
| -------- | ------- | -------- | -------- | ---------- |
| WikiText | 18.1    | 18.5     | 18.3     | 18.3 ± 0.2 |
| C4       | 20.8    | 21.3     | 21.2     | 21.1 ± 0.3 |

### Observations

- v3 相比 v2 的关键改进是修复了残差连接的梯度断开问题
- C4 上的提升不如 WikiText 显著，可能和数据分布有关
```

### 2.8 ASSETS.md 示例

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

- **LLaMA-3-8B**: `/inspire/hdd/project/multi-agent/models/llama3-8b`

## WandB

- Entity: `my-team`, Project: `discrete-diffusion`

## 启智平台

- 项目: 大模型时代下的多智能体系统
- 默认空间: 分布式训练空间
- 默认镜像: `docker-qb.sii.edu.cn/inspire-studio/my-train:v3`
- 存储根目录: `/inspire/hdd/project/multi-agent/`
```

---

## 三、state.yaml — 当前快照

state.yaml 只存"此刻的状态"——一个新 session 需要立刻知道的最小信息。

```yaml
project: "Factorized Gap in Discrete Diffusion LMs"
created: 2026-04-20
updated: 2026-06-18

config:
  participation_mode: collaborative # collaborative | guided | autonomous
  venue: "ICML 2027"

counters:
  idea: 14
  exp: 12
  plan: 2
  rev: 2

focus:
  since: 2026-06-18
  stage: experiment
  summary: "Supplementing ablation experiments per internal review feedback"
  refs:
    idea: idea_014
    plan: plan_002
    experiments: [exp_010, exp_011]
  blocked_on: null
  next: "Design ablation matrix, submit no-factorization and no-pruning ablations"
```

**设计要点**：

- **focus 是单数**——此刻研究的注意力在哪。焦点转移时，工具更新 focus 并自动在 timeline 里 append `focus.changed` 事件。
- **没有 progress 缓存**——需要精确数据时，通过 `research_experiment(action="list")` 实时扫描 yaml 文件获取。
- **没有 stages 列表**——完整的阶段历史在 timeline.jsonl 里。
- **counters**——各实体类型的 ID 计数器，工具原子读写。

---

## 四、timeline.jsonl — 完整研究轨迹

研究过程的 append-only 事件流。每个事件都有时间戳、类型、实体引用和语义描述。agent 读 timeline 就能重建完整研究脉络。

### 4.1 事件类型

| 类型               | 触发方式                            | 说明                                      |
| ------------------ | ----------------------------------- | ----------------------------------------- |
| `research.init`    | `research_init`                     | 研究项目初始化                            |
| `idea.created`     | `research_idea(add)` 自动           | 新 idea 创建                              |
| `idea.status`      | `research_idea(update)` 自动        | idea 状态变更（selected, rejected, etc.） |
| `plan.created`     | `research_plan(add)` 自动           | 新方案创建                                |
| `plan.status`      | `research_plan(update)` 自动        | 方案状态变更（approved, superseded）      |
| `exp.created`      | `research_experiment(add)` 自动     | 实验注册                                  |
| `exp.started`      | `research_experiment(update)` 自动  | 实验开始执行                              |
| `exp.completed`    | `research_experiment(update)` 自动  | 实验完成                                  |
| `exp.failed`       | `research_experiment(update)` 自动  | 实验失败                                  |
| `review.created`   | `research_review(add)` 自动         | 审核记录创建                              |
| `review.completed` | `research_review(update)` 自动      | 审核完成                                  |
| `focus.changed`    | `research_state(update focus)` 自动 | 研究焦点转移                              |
| `insight`          | `research_timeline(append)` 手动    | 关键发现/洞察                             |
| `milestone`        | `research_timeline(append)` 手动    | 重要里程碑                                |
| `decision`         | `research_timeline(append)` 手动    | 不属于特定实体的研究方向决策              |

**大部分事件由工具自动 append**——agent 调 `research_idea(action="add")` 时工具内部自动写一条 `idea.created`。agent 只需要手动 append `insight`、`milestone`、`decision` 这些自由事件。

### 4.2 timeline 示例

```jsonl
{"ts":"2026-04-20T10:00:00Z","type":"research.init","summary":"Initialized research project: Discrete Diffusion LMs"}
{"ts":"2026-04-25T14:30:00Z","type":"idea.created","id":"idea_001","title":"Factorized gap","summary":"Gap analysis: factorization of transition matrix is underexplored"}
{"ts":"2026-04-25T14:31:00Z","type":"idea.created","id":"idea_002","title":"Token merging","summary":"Inspired by ViT token merging, apply to diffusion steps"}
{"ts":"2026-04-25T14:32:00Z","type":"idea.created","id":"idea_003","title":"Pruning hybrid","summary":"Combine structured and unstructured pruning for diffusion"}
{"ts":"2026-05-01T09:00:00Z","type":"idea.status","id":"idea_002","from":"proposed","to":"selected","by":"user","summary":"Best novelty score, unexplored direction"}
{"ts":"2026-05-01T09:01:00Z","type":"idea.status","id":"idea_001","from":"proposed","to":"rejected","by":"user","summary":"Too similar to Wang et al. 2025"}
{"ts":"2026-05-01T09:05:00Z","type":"focus.changed","stage":"refine","summary":"Entering refinement for idea_002","refs":["idea_002"]}
{"ts":"2026-05-05T11:00:00Z","type":"idea.created","id":"idea_009","title":"Combined approach","summary":"Merged factorization from idea_002 + pruning from idea_005","refs":["idea_002","idea_005"]}
{"ts":"2026-05-10T16:00:00Z","type":"plan.created","id":"plan_001","title":"Experiment plan v1","summary":"3 baselines + 5 main experiments + ablations","refs":["idea_009"]}
{"ts":"2026-05-15T10:00:00Z","type":"idea.status","id":"idea_009","from":"selected","to":"rejected","by":"user","summary":"Compute budget ~800h H100, infeasible"}
{"ts":"2026-05-15T10:05:00Z","type":"focus.changed","stage":"explore","summary":"Back to exploration — need lighter approach","refs":["idea_009"]}
{"ts":"2026-05-20T14:00:00Z","type":"idea.created","id":"idea_014","title":"Lightweight factorization","summary":"Simplified: drop dynamic pruning, keep static factorization, ~200h budget","refs":["idea_009"]}
{"ts":"2026-05-28T15:00:00Z","type":"plan.created","id":"plan_002","title":"Experiment plan v2","summary":"Revised for idea_014: 3 baselines + 5 main + ablations","refs":["idea_014"]}
{"ts":"2026-05-28T15:30:00Z","type":"plan.status","id":"plan_002","from":"draft","to":"active","by":"user","summary":"Plan approved, ready for experiments"}
{"ts":"2026-06-01T09:00:00Z","type":"exp.created","id":"exp_001","group":"baselines","title":"Transformer baseline","summary":"Standard transformer on WikiText","refs":["idea_014","plan_002"]}
{"ts":"2026-06-01T09:30:00Z","type":"exp.started","id":"exp_001","backend":"inspire","job_id":"job-aaa","summary":"Submitted to inspire, H100x8"}
{"ts":"2026-06-03T18:00:00Z","type":"exp.completed","id":"exp_001","metrics":{"wikitext_ppl":20.5},"summary":"Baseline PPL 20.5, matches literature"}
{"ts":"2026-06-05T10:00:00Z","type":"exp.created","id":"exp_005","group":"main","title":"Method v1","summary":"First implementation of lightweight factorization","refs":["idea_014"]}
{"ts":"2026-06-07T22:00:00Z","type":"exp.failed","id":"exp_005","summary":"Loss divergence at step 500, gradient detachment in residual branch"}
{"ts":"2026-06-07T22:30:00Z","type":"insight","refs":["exp_005"],"summary":"Root cause: factorized module applied AFTER residual add causes gradient detachment. Must apply BEFORE."}
{"ts":"2026-06-08T09:00:00Z","type":"exp.created","id":"exp_007","group":"main","title":"Method v3 multi-seed","summary":"Fixed residual order, multi-seed on WikiText + C4","refs":["idea_014"]}
{"ts":"2026-06-15T20:00:00Z","type":"exp.completed","id":"exp_007","metrics":{"wikitext_ppl":18.3,"c4_ppl":21.1},"summary":"PPL 18.3±0.2 on WikiText, 10.7% over baseline"}
{"ts":"2026-06-15T21:00:00Z","type":"milestone","refs":["exp_007","idea_014"],"summary":"Main method validated across 2 datasets × 3 seeds with consistent improvement"}
{"ts":"2026-06-18T14:00:00Z","type":"review.completed","id":"rev_001","refs":["exp_007"],"summary":"Internal round 1: missing ablations — need no-factorization and no-pruning variants"}
{"ts":"2026-06-18T14:30:00Z","type":"focus.changed","stage":"experiment","summary":"Supplementing ablation experiments per review feedback","refs":["rev_001"]}
```

### 4.3 三层信息互补

| 文件               | 回答的问题           | 读取者               | 特性                   |
| ------------------ | -------------------- | -------------------- | ---------------------- |
| **state.yaml**     | "此刻在干什么"       | agent 快速加载       | 薄、可变               |
| **timeline.jsonl** | "怎么走到这一步的"   | agent 回顾、前端展示 | 厚、append-only        |
| **CONTEXT.md**     | "这个研究的来龙去脉" | 新 session 快速理解  | 叙事性、agent 定期更新 |

---

## 五、Research Tools

### 5.1 设计原则

**工具只管状态，不执行实验。** 实验执行由 skill 编排（调用 inspire_submit / bash 等），工具只记录状态变更。

**工具独占 yaml 写入，agent 只编辑 md。** 文件类型本身保证隔离。

**工具自动 append timeline。** 每个写操作自动在 timeline.jsonl 里追加对应事件，agent 不需要手动记录。

**工具不维护独立索引文件。** `list` / `compare` 操作直接扫描目录下的 `.yaml` 文件。

### 5.2 工具清单

| 工具                  | 职责                                             |
| --------------------- | ------------------------------------------------ |
| `research_init`       | 初始化 `.research/` 目录结构                     |
| `research_state`      | 读写 state.yaml（config + focus）                |
| `research_idea`       | 管理 idea yaml+md，自动 append timeline          |
| `research_plan`       | 管理 plan yaml+md，自动 append timeline          |
| `research_experiment` | 管理 experiment yaml+md，自动 append timeline    |
| `research_review`     | 管理 review yaml+md，自动 append timeline        |
| `research_timeline`   | 读取 timeline（过滤/查询）+ 手动 append 自由事件 |
| `research_context`    | 读写 CONTEXT.md                                  |

### 5.3 工具设计

#### `research_init`

```
research_init(
  project: "Factorized Gap in Discrete Diffusion LMs",
  venue?: "ICML 2027",
  participation_mode?: "collaborative"
)
→ { status: "created", state: {...} }
```

创建完整目录结构 + state.yaml + timeline.jsonl + CONTEXT.md + ASSETS.md。自动 append `research.init` 事件。

**如果 `.research/` 已存在**：返回当前状态（state.yaml + focus），不覆盖。Agent 每次进入 research session 时先调这个，既是初始化也是"载入上下文"。

#### `research_idea`

```
# 注册新 idea（ID 自动分配）
research_idea(action="add", title="Combined factorization + pruning",
  round=2, derived_from=["idea_002", "idea_005"])
→ { id: "idea_009", path: ".research/ideas/idea_009" }

# 更新 idea 元数据
research_idea(action="update", id="idea_009", status="selected",
  decided_by="user", reason="Best novelty + feasibility")
→ { id: "idea_009", status: "selected" }

# 列出 ideas（支持过滤）
research_idea(action="list")
research_idea(action="list", status="exploring")
research_idea(action="list", round=2)
→ [{ id: "idea_009", title: "...", status: "selected", round: 2 }, ...]
```

内部自动：

- `add`：创建 yaml + md 模板，increment counter，append `idea.created` 到 timeline
- `update`：更新 yaml 字段，append `idea.status` 到 timeline（如果 status 变更）
- `list`：扫描 `ideas/*.yaml`，支持按 status/round 过滤

#### `research_plan`

```
# 注册新方案
research_plan(action="add", title="Experiment plan v2",
  idea="idea_014", supersedes="plan_001")
→ { id: "plan_002", path: ".research/plans/plan_002" }

# 更新方案状态
research_plan(action="update", id="plan_002", status="active",
  approved_by="user")
→ { id: "plan_002", status: "active" }

# 列出方案
research_plan(action="list")
→ [{ id: "plan_002", title: "...", status: "active", idea: "idea_014" }, ...]
```

内部自动：

- `add`：创建 yaml + md 模板，increment counter，append `plan.created` 到 timeline
- `update`：更新 yaml，append `plan.status` 到 timeline。如果 status 变为 `active`，自动将前一个 active plan 标记为 `superseded`

#### `research_experiment`

```
# 注册新实验（ID 自动分配）
research_experiment(action="add", title="Method v3 multi-seed",
  group="main",
  idea="idea_014", plan="plan_002",
  backend="inspire",
  hyperparameters={ learning_rate: 1e-4, batch_size: 128 },
  seeds=[42, 123, 456],
  datasets=["wikitext", "c4"])
→ { id: "exp_007", path: ".research/experiments/exp_007" }

# 更新实验元数据（skill 拿到 job_id / result 后调用）
research_experiment(action="update", id="exp_007",
  status="running", job_id="job-xxx-yyy-zzz")

research_experiment(action="update", id="exp_007",
  status="completed",
  metrics={ wikitext_ppl: { mean: 18.3, std: 0.2 } },
  artifacts={ log: "/inspire/.../exp_007.log" })

# 标记失败
research_experiment(action="update", id="exp_005",
  status="failed", failure_reason="gradient detachment in residual branch")

# 列出实验（支持过滤）
research_experiment(action="list")
research_experiment(action="list", group="main")
research_experiment(action="list", status="running")

# 对比多个实验
research_experiment(action="compare", ids=["exp_001", "exp_005", "exp_007"])
→ 生成对比表（id, title, status, key metrics）
```

内部自动：

- `add`：创建 yaml + md 模板，记录 code commit hash，increment counter，append `exp.created` 到 timeline
- `update`：更新 yaml，根据 status 变更 append 对应事件（`exp.started` / `exp.completed` / `exp.failed`）
- `list`：扫描 `experiments/*.yaml`
- `compare`：读取多个 yaml 的 metrics 块，输出对比表

**工具不调用 inspire_submit**。`action="add"` 只创建文件并注册状态。实验执行由 skill 编排：

```
Skill: research-experiment
  1. research_experiment(action="add", ...) → 拿到 exp_007
  2. inspire_submit(name="exp_007", command="...", ...) → 拿到 job_id
  3. research_experiment(action="update", id="exp_007", status="running", job_id="...")
  4. 创建 agenda watch 监控
  ... 实验完成后 ...
  5. research_experiment(action="update", id="exp_007", status="completed", metrics={...}, artifacts={...})
```

**实验产物管理由 skill 约定**：skill 的 description 里规定代码、日志、checkpoint 的目录结构和命名规范（如 `/inspire/.../logs/{exp_id}.log`），确保产物路径可预测、可回填到 yaml 的 artifacts 字段。工具只存引用路径，不管文件本身。

#### `research_review`

```
# 注册审核
research_review(action="add", title="Internal review round 1",
  type="internal", refs=["exp_007", "exp_003"])
→ { id: "rev_001", path: ".research/reviews/rev_001" }

# 更新审核状态
research_review(action="update", id="rev_001", status="completed")

# 列出审核
research_review(action="list")
```

#### `research_timeline`

```
# 读取（支持过滤）
research_timeline(action="read")                          → 全部事件
research_timeline(action="read", since="2026-06-01")      → 最近的事件
research_timeline(action="read", type="exp.*")            → 所有实验相关事件
research_timeline(action="read", refs=["idea_014"])       → 和 idea_014 相关的所有事件
research_timeline(action="read", last=20)                 → 最近 20 条事件

# 手动 append 自由事件
research_timeline(action="append", type="insight",
  refs=["exp_005"],
  summary="Root cause: factorized module applied AFTER residual add causes gradient detachment")

research_timeline(action="append", type="milestone",
  refs=["exp_007", "idea_014"],
  summary="Main method validated across 2 datasets × 3 seeds with consistent improvement")

research_timeline(action="append", type="decision",
  summary="Decided to target ICML 2027 instead of NeurIPS 2026 — need more ablation evidence")
```

#### `research_context`

```
# 读取（新 session 开始时）
research_context(action="read")  → 返回 CONTEXT.md 内容

# 更新（重要进展后）
research_context(action="update",
  stage="experiment",
  recent="Selected idea_014 (lightweight factorization), plan_002 approved",
  next="Wait for exp_007 results, then design ablation matrix",
  key_results=["baseline PPL 20.5", "method-v3 preliminary PPL 18.1"])
```

### 5.4 工具加载条件

当前 scope 目录下存在 `.research/` 目录时自动加载。

### 5.5 Tool ↔ Skill 分工

```
Tools（结构化操作，可靠）          Skills（编排逻辑，灵活）
─────────────────────            ─────────────────────
research_init                    research-explore 调用 research_idea(add)
research_idea                    research-refine 调用 research_plan(add)
research_plan                    research-experiment 调用 research_experiment(add) + inspire_submit
research_experiment              research-monitor 调用 research_experiment(update) + inspire_jobs
research_review                  research-review 调用 research_review(add/update)
research_timeline                paper-write 读取 experiments/*.yaml 生成 supplementary
research_state
research_context
```

**原则**：

- **结构化数据变更** → Tool 写 yaml（保证格式正确、ID 分配、timeline 记录）
- **创意内容生成** → Agent 写 md（idea 的描述、论文正文、实验分析）
- **流程编排** → Skill（什么时候调什么 tool、怎么调用 inspire、产物规范）

---

## 六、多后端实验支持

### 6.1 不是所有实验都需要 GPU

| 实验类型 | 后端                | 示例                                        |
| -------- | ------------------- | ------------------------------------------- |
| GPU 训练 | inspire_submit      | 大规模 LM 预训练、fine-tuning               |
| 本地训练 | bash (local)        | 小 baseline、debug、prototype               |
| API 推理 | bash (curl/python)  | 调用部署的 Qwen/GPT 做 inference evaluation |
| 数据分析 | bash (local python) | 统计分析、可视化、格式转换                  |
| 理论验证 | bash (local)        | 数学推导的数值验证                          |
| HPC 计算 | inspire_submit_hpc  | CPU 密集的数据预处理                        |

### 6.2 backend 参数

```
backend: "inspire"   → 只注册实验记录，skill 负责调用 inspire_submit
backend: "local"     → 只注册实验记录，skill 负责通过 bash 在本地执行
backend: "api"       → 只注册实验记录，skill 负责从 ASSETS.md 读取 API 配置并构造调用
backend: "manual"    → 只注册实验记录，实际执行由用户手动完成
```

### 6.3 实验产物规范

实验产物（日志、checkpoint、tensorboard、评测输出）由 **skill 约定目录结构**，而非工具管理。skill 负责：

- 写代码时规划日志路径和命名规范
- 提交实验时确保命令行输出正确路径
- 实验完成后将产物路径回填到 yaml 的 `artifacts` 字段

工具只存引用路径（`.yaml` 的 `artifacts` 块），不复制也不管理实际文件。`.research/` 是研究的控制面，不是数据仓库。

---

## 七、Skill 重组（从 68 → ~25）

### 7.1 Research Core — 8 个

| Skill                     | 合并自                                                                               | 核心改动                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **`research-explore`**    | idea-discovery + research-lit + novelty-check                                        | 产出写入 ideas/ 和 literature/。调用 research_idea(add)。每步暂停等用户选择。                       |
| **`research-position`**   | **NEW** — 精确定位贡献、生成 contribution statement                                  | 输出 positioning diagram + related work 框架                                                        |
| **`research-refine`**     | research-refine + experiment-plan                                                    | 产出写入 plans/。调用 research_plan(add)。用户必须 approve。增加 compute/data budget 估算。         |
| **`research-experiment`** | experiment-bridge + parallel-experiment-engine + run-experiment + baseline-alignment | 调用 research_experiment(add) + inspire_submit。产物路径规范。自动创建 agenda 监控。                |
| **`research-monitor`**    | monitor-experiment + training-check + analyze-results + result-to-claim              | agenda tool watch 监控。调用 research_experiment(update)。增加统计检验 + negative result analysis。 |
| **`research-review`**     | auto-review-loop (3 variants) + research-review                                      | 调用 research_review(add/update)。统一跨模型审核。每轮保留。                                        |
| **`research-verify`**     | **NEW** — claim-evidence matrix + reproducibility checklist                          | Nature 级别的最终验证                                                                               |
| **`research-wiki`**       | research-wiki                                                                        | 读写 literature/ 和 engram 系统。跨项目经验存 engram。                                              |

### 7.2 Paper Writing — 5 个

| Skill                | 核心改动                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| **`paper-plan`**     | 增加 venue-specific narrative template（Nature/ICML/NeurIPS 各不同）                    |
| **`paper-write`**    | 逐章写入 `paper/sections/`。编译用 tectonic。自动生成补充材料（从 experiments/ 汇总）。 |
| **`paper-figure`**   | 统一图表风格系统。自动检测图表类型选择最佳工具。产出存入 `paper/figures/`。             |
| **`paper-rebuttal`** | 保留，审稿意见和回复存入 reviews/。                                                     |
| **`paper-present`**  | 合并 poster + slides。                                                                  |

### 7.3 其他 — 12 个

| 分组        | Skill                                                                                | 来源                                                                         |
| ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Math (2)    | `proof-write`, `formula-derive`                                                      | 合并 proof-writer+checker；保留 formula-derivation                           |
| Search (3)  | `search-papers`, `search-web`, `search-domain`                                       | 合并 arxiv+semantic-scholar+alphaxiv+deepxiv；保留 exa；保留 comm-lit-review |
| Patent (2)  | `patent-draft`, `patent-review`                                                      | 合并各6+4个                                                                  |
| Infra (2)   | `sii-inspire`(已完成), `gpu-cloud`                                                   | 合并 vast+modal                                                              |
| Utility (5) | `grant-proposal`, `experiment-audit`, `writing-guide`, `system-profile`, `pixel-art` | 精简                                                                         |

### 7.4 删除的

| 删除                           | 理由                        |
| ------------------------------ | --------------------------- |
| qzcli                          | 已废弃 → sii-inspire        |
| auto-review-loop-llm / minimax | 合入 research-review        |
| experiment-queue               | SSH 专用，inspire 不需要    |
| feishu-notify                  | 用 Synergy agenda + channel |
| aris-update                    | 内置不需要自更新            |
| meta-optimize                  | 变为内部工具                |
| shared-references              | 内容合入各 skill            |

---

## 八、Human-in-the-Loop 设计

### 8.1 三种参与度模式

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

### 8.2 Idea 迭代流程

```
研究者: "我想探索 discrete diffusion LM 方向"

Agent: 调用 research-explore skill
       → 文献调研 → 生成 8 个 idea
       → research_idea(add) × 8 → idea_001 ~ idea_008
       → timeline 自动记录 8 条 idea.created

研究者: 看了几个 idea，觉得 idea_002 和 idea_005 有意思
         在 idea_003.md 里写批注 "这个和 XXX 2025 的工作太像了"
         告诉 agent 标记 idea_001, idea_003, idea_004 为 rejected

Agent: research_idea(update, id="idea_001", status="rejected", ...)
       research_idea(update, id="idea_002", status="exploring", ...)
       → timeline 自动记录每条状态变更
       → 深入探索 idea_002 和 idea_005
       → 编辑 idea_002.md 和 idea_005.md，补充可行性分析

研究者: 决定 idea_002 方向 + idea_005 的某个技术点 → 组合成新 idea

Agent: research_idea(add, title="Combined approach", derived_from=["idea_002","idea_005"])
       → 拿到 idea_009
       → 编辑 idea_009.md，写新颖性验证和可行性分析
       → 暂停等用户确认

研究者: "好，就做 idea_009，但把 X 部分改成 Y"

Agent: research_idea(update, id="idea_009", status="selected")
       → research_plan(add, title="Experiment plan v1", idea="idea_009")
       → 进入 research-refine 阶段
```

**关键**：idea 文件永远不删除。推翻的标记为 rejected + 原因。所有变更都在 timeline 里。

---

## 九、Synergy 内部集成

### 9.1 各子系统角色

| 子系统            | 科研用途                    | 具体方式                                                    |
| ----------------- | --------------------------- | ----------------------------------------------------------- |
| **Scope**         | 一个 scope = 一个研究项目   | `.research/` 目录存在 → Research Panel 显示                 |
| **Session**       | 多个 session 服务同一个研究 | 共享 `.research/` 目录                                      |
| **Agenda**        | 实验监控 + 定期汇报         | tool watch on inspire_jobs + 每日研究进度摘要               |
| **Engram**        | 跨项目科研经验              | "这个数据集 baseline 是 X"、"H100 上 batch size 最大能到 Y" |
| **Note**          | 临时想法、会议记录          | 不存 research state（那在 `.research/` 里）                 |
| **DAG**           | 单次任务的步骤追踪          | 不替代 research state（DAG 是 session 级、临时的）          |
| **Cortex**        | 跨模型审核                  | reviewer/auditor/scholar agent delegation                   |
| **Inspire Tools** | 实验执行                    | submit/monitor/stop，数据回填到实验 yaml                    |

### 9.2 与 Note 系统的关系

**完全不冲突**：

- **Note** = Synergy 平台级的临时记录，跟着 session 或 scope 走
- **Research files** = 研究项目的结构化档案，住在 `.research/` 目录里
- **Timeline** = 研究事件流，类似 git log
- **CONTEXT.md** = 研究简报，给新 session 看的

一个临时想法可以先记在 note 里，确认后再通过 `research_idea(add)` 正式注册。两者是上下游关系，不是竞争关系。

### 9.3 Inspire Tools 深度绑定

research-experiment skill 使用 inspire 工具时的完整流转：

```
research-experiment skill 读取 plan_002.md → 解析实验列表
  → research_experiment(action="add", title="Method v3", ...) → 拿到 exp_007
  → inspire_submit(name="exp_007", command="...", ...) → 拿到 job_id
  → research_experiment(action="update", id="exp_007", job_id="...", status="running")
  → 创建 agenda watch 监控
  → agenda 检测到 inspire_jobs 变化
  → 实验完成 → 唤醒 session
  → 提交 CPU job 读取结果文件
  → research_experiment(action="update", id="exp_007", status="completed",
      metrics={...}, artifacts={log: "...", checkpoint: "..."})
```

### 9.4 自动生成补充材料

paper-write skill 在生成论文时，自动从 `experiments/*.yaml` 汇总：

```latex
% supplementary.tex — 自动生成
\section{Complete Experiment Log}

\subsection{exp\_005: Method v1 (Failed)}
% 从 exp_005.yaml 提取 config，从 exp_005.md 提取 notes

\subsection{exp\_007: Method v3}
% 从 exp_007.yaml 提取 config + metrics，从 exp_007.md 提取 notes

...（所有实验，包括失败的）
```

---

## 十、实现路径（不含前端）

### Phase 1：Foundation（2 周）

1. **8 个 Research Tools** 实现（research_init, research_state, research_idea, research_plan, research_experiment, research_review, research_timeline, research_context）
2. **实体 yaml schema 定义**（Zod schema for idea/plan/experiment/review yaml）
3. **条件加载机制**（`.research/` 目录存在时自动加载 tools + skills）
4. **ID 生成**（自增计数器 in state.yaml）

### Phase 2：Core Skills（3-4 周）

5. **8 个 research-core skills**（从 ARIS 精炼，集成 research tools + inspire tools）
6. **research-pipeline** 编排 skill（human checkpoint 在每个阶段）
7. **实验产物规范**（skill 里约定日志、checkpoint、评测输出的目录结构）

### Phase 3：Paper Skills（2 周）

8. **5 个 paper skills**
9. **图表风格系统**
10. **补充材料自动生成**（从 experiments/\*.yaml 汇总）

### Phase 4：Remaining + Polish（2 周）

11. **Patent / Math / Search / Utility skills**
12. **Engram 集成**（跨项目科研经验）

---

## 十一、Research Panel（前端，独立阶段）

### 11.1 定位

Research Panel 是 `.research/` 目录的**实时可视化视图 + 交互控制台**。

**它不是独立的数据存储**——它读写的都是项目目录中的真实文件。

### 11.2 功能模块

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
│  [Ideas] [Plans] [Experiments] [Paper] [Timeline]│
│  ─────────────────────────────────────────────  │
│                                                 │
│  (tab content below)                            │
│                                                 │
└─────────────────────────────────────────────────┘
```

**Tab: Ideas** — Idea 看板

- 每个 idea 是一张卡片（从 `ideas/*.yaml` 读取元数据，从 `.md` 读取摘要）
- 卡片显示 title、status、关键句
- 用户可以：标记 selected/rejected、写批注、创建新 idea
- 状态变更写入 `.yaml`，批注写入 `.md`

**Tab: Plans** — 方案版本

- 显示 `plans/*.yaml` 的所有方案版本
- 当前 active 方案高亮
- 点击查看 `.md` 的完整方案内容

**Tab: Experiments** — 实验看板

- 从 `experiments/*.yaml` 读取元数据 + `inspire_jobs` 合并实时状态
- 每个实验一行：ID、title、status(✅❌🔄⏳)、关键 metric、运行时长
- 点击展开详情（yaml 元数据 + md 笔记）
- 失败实验也清晰展示，附失败原因

**Tab: Paper** — 论文

- Section 列表 + 完成状态
- 点击 section → 显示 LaTeX 源码（可编辑）
- PDF 预览按钮 → 调用 tectonic 编译后显示

**Tab: Timeline** — 研究时间线

- 时间线视图，显示 `timeline.jsonl` 所有事件
- 按时间倒序，颜色区分事件类型
- 支持按实体过滤（"显示和 idea_014 相关的所有事件"）
- 可搜索

### 11.3 文件 ↔ 前端 的映射

| 前端操作              | 文件操作                                            |
| --------------------- | --------------------------------------------------- |
| 标记 idea 为 selected | 修改 `idea_009.yaml` 的 `status: selected`          |
| 写批注                | 追加到 `idea_009.md` 或 `exp_007.md` 正文           |
| 编辑 LaTeX section    | 直接编辑 `paper/sections/xxx.tex`                   |
| 查看 PDF              | 编译 `paper/main.tex` → 读取 `paper/build/main.pdf` |
| 查看实验结果          | 读取 `exp_007.yaml`                                 |
| 查看研究时间线        | 读取 `timeline.jsonl`                               |

所有操作最终都是文件读写。前端不维护独立状态。

---

## 十二、开放问题

1. **Research Panel 作为独立面板还是 Side Panel 的一个 Tab？**

2. **LaTeX 编译：tectonic 还是 texlive？** — tectonic 单二进制轻量但包不全；texlive 完整但重。建议 tectonic + 按需下载。

3. **Ideas 看板的编辑体验** — 用户直接在前端编辑 `.md` 内容？还是只能标记状态和写批注，完整编辑交给 agent 或编辑器？

4. **`.research/` 目录是否要 git 管理？** — 自动 commit 每次重要变更？便于版本对比和回滚。

5. **多人协作** — 一个 scope 目前是单用户的。未来如果多人共享一个研究项目，文件冲突怎么处理？

6. **实验结果格式** — experiment yaml 的 metrics 块是否需要统一 schema？统一有助于 Panel 渲染和跨实验对比，但灵活性低。
