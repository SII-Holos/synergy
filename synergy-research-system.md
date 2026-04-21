# Synergy Research System — 内置科研能力深度集成方案

> Version: Draft v5.1 — 2026-04-21
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

## 二、架构核心：Research State = 项目目录中的真实文件

### 2.1 设计原则

**类比 Git**：`.git/` 在项目目录里，VS Code 的 Git Panel 是 `.git/` 的可视化视图。

同理：`.research/` 在项目目录里，Synergy 的 Research Panel 是 `.research/` 的可视化视图。

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
    │   │   └── s001-smoke-test.md                 ← 一个实验 = 一个 markdown
    │   ├── baselines/
    │   │   └── b001-transformer.md
    │   ├── main/
    │   │   ├── m001-method-v1.md                  ← status: failed, failure_reason: "..."
    │   │   └── m003-method-v3.md                  ← status: completed, metrics: {...}
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
2. **`paper/` 在项目根目录**：用户直接编辑 LaTeX，不在隐藏目录里。
3. **只有 2 个结构化文件**：`state.yaml`（工具程序化读写）和 `decisions.jsonl`（append-only 日志）。其余全是 markdown。
4. **一个实验 = 一个 markdown**：frontmatter 含结构化信息（config、metrics、status），正文含笔记。工具解析 frontmatter 建立索引，不维护单独的 `_index.yaml`。
5. **ASSETS.md 是 markdown**：用户和 agent 都可以直接编辑。不需要工具。

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

| Dataset  | Seed 42 | Seed 123 | Seed 456 | Mean ± Std |
| -------- | ------- | -------- | -------- | ---------- |
| WikiText | 18.1    | 18.5     | 18.3     | 18.3 ± 0.2 |
| C4       | 20.8    | 21.3     | 21.2     | 21.1 ± 0.3 |

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

| 挑战           | 应对                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| **30+ ideas**  | 按 round 分目录 + frontmatter 记录关系（derived_from）+ 工具动态建索引       |
| **100+ 实验**  | 按 phase 分目录 + 一个实验一个 markdown（frontmatter 含完整 config/metrics） |
| **失败留存**   | status: failed + failure_reason 在 frontmatter，正文写分析                   |
| **代码追踪**   | frontmatter 记录 code_commit                                                 |
| **环境快照**   | frontmatter 的 environment 块（image digest, GPU, shm）                      |
| **非线性**     | stages 多个 active                                                           |
| **跨 session** | CONTEXT.md 自动更新                                                          |
| **80+ 文献**   | by-topic/ + key-papers/ + references.bib                                     |
| **资产复用**   | ASSETS.md 一次配置，所有 session 读取                                        |
| **控制面整洁** | .research/ 隐藏，不污染项目目录                                              |

### 2.5 Scope 与 Research 的关系

任何 project scope 都可以变成 research scope：agent 创建 `.research/` 目录 + `state.yaml` 即可。

多 session 共享同一 `.research/` 目录。新 session 读 `CONTEXT.md` 获取研究简报。

---

## 三、Research Tools（纯状态管理，不执行实验）

Agent 直接用 write/edit 维护 YAML 文件太脆弱（语法错误、字段遗漏、闭合问题）。关键的结构化操作应该封装成工具，就像 `inspire_config` 封装了 config 编辑一样。

### 3.1 工具清单

| 工具                  | 职责                                                    | 替代了什么                            |
| --------------------- | ------------------------------------------------------- | ------------------------------------- |
| `research_init`       | 初始化 `.research/` 目录结构 + `state.yaml`             | agent 手动 mkdir + write              |
| `research_state`      | 读写 state.yaml（get/set/update）                       | agent 手动 edit state.yaml            |
| `research_idea`       | 注册/更新/查询 idea（创建 markdown + 维护 frontmatter） | agent 手动写 idea markdown + 维护索引 |
| `research_experiment` | 注册/更新/查询实验（创建 markdown + 维护 frontmatter）  | agent 手动创建实验文件 + 维护索引     |
| `research_log`        | 追加决策日志条目到 decisions.jsonl                      | agent 手动 append JSONL               |
| `research_context`    | 读取/更新 CONTEXT.md                                    | agent 手动读写 CONTEXT.md             |

### 3.2 工具设计

#### `research_init`

```
research_init(
  project: "Factorized Gap in Discrete Diffusion LMs",
  venue?: "ICML 2027",
  participation_mode?: "collaborative"
)
```

内部创建完整目录结构 + state.yaml + CONTEXT.md + ASSETS.md。

**如果 `.research/` 已存在**：返回当前状态，不覆盖。Agent 每次进入 research session 时先调这个，既是初始化也是"载入上下文"。

#### `research_idea`

```
# 注册新 idea
research_idea(action="add", round=2, title="Combined factorization + pruning",
  description="...", derived_from=["002", "005"])

# 更新 idea 状态
research_idea(action="update", id="009", status="selected",
  reason="Best novelty + feasibility", decided_by="user")

# 列出 ideas
research_idea(action="list", status="exploring")  → 返回所有 exploring 的 idea
research_idea(action="list")                       → 返回全部 idea 摘要
```

内部自动：

- 创建/更新 `ideas/round-N/xxx.md` 文件（frontmatter + 正文模板）
- 解析所有 idea markdown 的 frontmatter 动态建索引
- 追加 `decisions.jsonl` 条目（如果 status 变更）
- 更新 `state.yaml` 的 progress 计数

#### `research_experiment`

```
# 注册新实验
research_experiment(action="add", group="main", name="method-v3",
  command="python train.py --config v3.yaml",
  backend="inspire",                                # inspire | local | api | manual
  hyperparameters={ learning_rate: 1e-4, batch_size: 128 },
  seeds=[42, 123, 456],
  datasets=["wikitext", "c4"])

# 更新实验状态（skill 拿到 job_id / result 后调用）
research_experiment(action="update", id="m003", status="running",
  job_id="job-xxx-yyy-zzz")

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

- 创建 `experiments/{group}/{id}.md` 文件（frontmatter + 正文模板）
- 记录 code commit hash（从 git 读取）
- 解析所有实验 markdown 的 frontmatter 动态建索引
- 更新 `state.yaml` 进度

**工具不调用 inspire_submit**。`action="add"` 只创建 markdown 文件并注册状态。实验执行由 skill 编排：

```
Skill: research-experiment
  1. 调用 research_experiment(action="add") 注册实验 → 拿到实验 id
  2. 调用 inspire_submit / bash（执行实验）
  3. 拿到 job_id / result
  4. 调用 research_experiment(action="update", id="m003", job_id="...", status="running")
```

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

**工具只管状态，不执行实验。** `research_experiment(action="add")` 只注册一条实验记录，不调用 `inspire_submit`。实验执行由 skill 编排。

**工具不生成创意内容。** Idea 的描述、实验的分析笔记、文献综述——这些由 agent 用 write/edit 直接操作 markdown。工具只维护 frontmatter 和 state.yaml 的结构化字段。

**工具不维护独立索引文件。** 没有 `_index.yaml`、`_comparison.yaml`。工具通过解析 markdown frontmatter 动态建立索引。

---

## 四、Research Assets

### 4.1 问题

数月研究中有大量跨 session 复用的资源：模型 API、数据路径、checkpoint、wandb 配置等。每个 session 都重新获取太浪费。

### 4.2 设计

一个 markdown 文件：`.research/ASSETS.md`。Agent 直接 read，用户直接编辑。不需要工具。

Skill 的 description 告诉 agent："实验前先读 `.research/ASSETS.md` 获取可用资源。"

---

## 五、多后端实验支持

### 5.1 不是所有实验都需要 GPU

| 实验类型 | 后端                | 示例                                        |
| -------- | ------------------- | ------------------------------------------- |
| GPU 训练 | inspire_submit      | 大规模 LM 预训练、fine-tuning               |
| 本地训练 | bash (local)        | 小 baseline、debug、prototype               |
| API 推理 | bash (curl/python)  | 调用部署的 Qwen/GPT 做 inference evaluation |
| 数据分析 | bash (local python) | 统计分析、可视化、格式转换                  |
| 理论验证 | bash (local)        | 数学推导的数值验证                          |
| HPC 计算 | inspire_submit_hpc  | CPU 密集的数据预处理                        |

### 5.2 `research_experiment` 的 backend 参数

```
backend: "inspire"   → 只注册实验记录，skill 负责调用 inspire_submit
backend: "local"     → 只注册实验记录，skill 负责通过 bash 在本地执行
backend: "api"       → 只注册实验记录，skill 负责从 ASSETS.md 读取 API 配置并构造调用
backend: "manual"    → 只注册实验记录，实际执行由用户手动完成
```

**inspire 不是默认值**。默认值从 `state.yaml` 的 `config.inspire` 存在与否推断：有 inspire 配置 → 默认 inspire；没有 → 默认 local。

---

## 六、Skill 重组（从 68 → ~25）

### 6.1 Research Core — 8 个

| Skill                     | 合并自                                                                               | 核心改动                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **`research-explore`**    | idea-discovery + research-lit + novelty-check                                        | 产出写入 `.research/ideas/` 和 `.research/literature/`。每个 idea 独立 markdown。每步暂停等用户选择。                          |
| **`research-position`**   | **NEW** — 精确定位贡献、生成 contribution statement                                  | 输出 positioning diagram + related work 框架                                                                                   |
| **`research-refine`**     | research-refine + experiment-plan                                                    | 产出写入 `.research/plans/`。多版本保留。用户必须 approve plan 才能进入实验。增加 compute/data budget 估算。                   |
| **`research-experiment`** | experiment-bridge + parallel-experiment-engine + run-experiment + baseline-alignment | 通过 inspire_submit 提交。每个实验写入 `.research/experiments/{group}/{id}.md`。失败的也保留。自动创建 agenda 监控。           |
| **`research-monitor`**    | monitor-experiment + training-check + analyze-results + result-to-claim              | agenda tool watch 监控。结果写入实验 markdown 的 frontmatter。自动更新 `state.yaml`。增加统计检验 + negative result analysis。 |
| **`research-review`**     | auto-review-loop (3 variants) + research-review                                      | 统一跨模型审核。审核结果写入 `.research/reviews/`。每轮保留。                                                                  |
| **`research-verify`**     | **NEW** — claim-evidence matrix + reproducibility checklist                          | Nature 级别的最终验证                                                                                                          |
| **`research-wiki`**       | research-wiki                                                                        | 改为读写 `.research/literature/` 和 engram 系统。跨项目经验存 engram。                                                         |

### 6.2 Paper Writing — 5 个

| Skill                | 核心改动                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **`paper-plan`**     | 增加 venue-specific narrative template（Nature/ICML/NeurIPS 各不同）                                                   |
| **`paper-write`**    | 逐章写入 `paper/sections/`。编译用 tectonic。自动生成补充材料（从 `.research/experiments/` 汇总）。Abstract 反复打磨。 |
| **`paper-figure`**   | 统一图表风格系统。自动检测图表类型选择最佳工具。产出存入 `paper/figures/`。                                            |
| **`paper-rebuttal`** | 保留，审稿意见和回复存入 `.research/reviews/`。                                                                        |
| **`paper-present`**  | 合并 poster + slides。                                                                                                 |

### 6.3 其他 — 12 个

| 分组        | Skill                                                                                | 来源                                                                         |
| ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Math (2)    | `proof-write`, `formula-derive`                                                      | 合并 proof-writer+checker；保留 formula-derivation                           |
| Search (3)  | `search-papers`, `search-web`, `search-domain`                                       | 合并 arxiv+semantic-scholar+alphaxiv+deepxiv；保留 exa；保留 comm-lit-review |
| Patent (2)  | `patent-draft`, `patent-review`                                                      | 合并各6+4个                                                                  |
| Infra (2)   | `sii-inspire`(已完成), `gpu-cloud`                                                   | 合并 vast+modal                                                              |
| Utility (5) | `grant-proposal`, `experiment-audit`, `writing-guide`, `system-profile`, `pixel-art` | 精简                                                                         |

### 6.4 删除的

| 删除                           | 理由                        |
| ------------------------------ | --------------------------- |
| qzcli                          | 已废弃 → sii-inspire        |
| auto-review-loop-llm / minimax | 合入 research-review        |
| experiment-queue               | SSH 专用，inspire 不需要    |
| feishu-notify                  | 用 Synergy agenda + channel |
| aris-update                    | 内置不需要自更新            |
| meta-optimize                  | 变为内部工具                |
| shared-references              | 内容合入各 skill            |

### 6.5 研究流程中的 Tool ↔ Skill 分工

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

## 七、Human-in-the-Loop 设计

### 7.1 三种参与度模式

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

### 7.2 Idea 迭代流程

Nature 级别研究的核心：idea 的反复推翻和迭代。

```
研究者: "我想探索 discrete diffusion LM 方向"

Agent: 调用 research-explore → 文献调研 → 生成 8 个 idea
       → 写入 .research/ideas/round-1/001.md ~ 008.md

研究者: 看了几个 idea，觉得 #002 和 #005 有意思，标记为 "exploring"
         给 #003 写了批注 "这个和 XXX 2025 的工作太像了"
         标记 #001, #003, #004 为 "rejected"

Agent: 看到用户的选择 → 深入探索 #002 和 #005
       → 生成更细的可行性分析
       → 更新 ideas/round-1/002.md 和 ideas/round-1/005.md

研究者: 决定 #002 方向 + #005 的某个技术点 → 组合成新 idea #009

Agent: 创建 ideas/round-2/009-combined.md
       → 做新颖性验证
       → 初步可行性分析
       → 暂停等用户确认

研究者: "好，就做 #009，但把 X 部分改成 Y"

Agent: 更新 ideas/round-2/009-combined.md，标记 status: selected
       → 进入 research-refine 阶段
```

**关键**：idea 文件永远不删除。推翻的标记为 rejected + 原因。这就是 Nature 级别的补充材料来源。

---

## 八、Synergy 内部集成

### 8.1 各子系统角色

| 子系统            | 科研用途                    | 具体方式                                                    |
| ----------------- | --------------------------- | ----------------------------------------------------------- |
| **Scope**         | 一个 scope = 一个研究项目   | `.research/` 目录存在 → Research Panel 显示                 |
| **Session**       | 多个 session 服务同一个研究 | 共享 `.research/` 目录                                      |
| **Agenda**        | 实验监控 + 定期汇报         | tool watch on inspire_jobs + 每日研究进度摘要               |
| **Engram**        | 跨项目科研经验              | "这个数据集 baseline 是 X"、"H100 上 batch size 最大能到 Y" |
| **Note**          | 临时想法、会议记录          | 不存 research state（那在 `.research/` 目录里）             |
| **DAG**           | 单次任务的步骤追踪          | 不替代 research state（DAG 是 session 级、临时的）          |
| **Cortex**        | 跨模型审核                  | reviewer/auditor/scholar agent delegation                   |
| **Inspire Tools** | 实验执行                    | submit/monitor/stop，数据回填到实验 markdown                |

### 8.2 Inspire Tools 深度绑定

research-experiment skill 使用 inspire 工具时的完整流转：

```
research-experiment 读取 .research/plans/v2-current.md
  → 解析实验列表
  → 调用 research_experiment(action="add", ...) 创建实验 markdown
  → inspire_submit(name="m003", command="...", ...)
  → 收到 job_id
  → 调用 research_experiment(action="update", id="m003", job_id="...", status="running")
  → 创建 agenda watch 监控
  → agenda 检测到 inspire_jobs 变化
  → 实验完成 → 唤醒 session
  → 提交 CPU job 读取结果文件
  → 调用 research_experiment(action="update", id="m003", status="completed", results={...})
  → 更新 state.yaml 的 progress
```

### 8.3 自动生成补充材料

paper-write skill 在生成论文时，自动从 `.research/experiments/` 汇总：

```latex
% supplementary.tex — 自动生成
\section{Complete Experiment Log}

\subsection{Experiment m001: Method v1 (Failed)}
\input{.research/experiments/main/m001-method-v1.md}  ← 从 markdown 提取

\subsection{Experiment m003: Method v3}
\input{.research/experiments/main/m003-method-v3.md}

...（所有实验，包括失败的）
```

---

## 九、实现路径（不含前端）

### Phase 1：Foundation（2 周）

1. **6 个 Research Tools** 实现（research_init, research_state, research_idea, research_experiment, research_log, research_context）
2. **目录结构规范**确定（state.yaml schema、markdown frontmatter schema）
3. **条件加载机制**（`.research/` 目录存在时自动加载 tools + skills）

### Phase 2：Core Skills（3-4 周）

4. **8 个 research-core skills**（从 ARIS 精炼，集成 research tools + inspire tools）
5. **research-pipeline** 编排 skill（human checkpoint 在每个阶段）

### Phase 3：Paper Skills（2 周）

6. **5 个 paper skills**
7. **图表风格系统**
8. **补充材料自动生成**

### Phase 4：Remaining + Polish（2 周）

9. **Patent / Math / Search / Utility skills**
10. **Engram 集成**（跨项目科研经验）

---

## 十、Research Panel（前端，Phase 3）

### 10.1 定位

Research Panel 是 scope 的 `.research/` 目录的**实时可视化视图 + 交互控制台**。

**它不是独立的数据存储**——它读写的都是项目目录中的真实文件。

### 10.2 功能模块

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

- 每个 idea 是一张卡片（从 `ideas/**/*.md` 读取 frontmatter）
- 卡片显示 title、status、关键句
- 用户可以：标记 selected/rejected、写批注、创建新 idea
- 修改直接写回对应的 markdown 文件

**Tab: Plans** — 方案版本

- 显示 `plans/` 下的所有方案版本
- 当前 active 方案高亮
- 点击可查看完整方案内容

**Tab: Experiments** — 实验看板

- 实时状态：从 `experiments/**/*.md` frontmatter + `inspire_jobs` 合并
- 每个实验一行：名称、状态(✅❌🔄⏳)、关键 metric、运行时长
- 点击展开详情（frontmatter + 正文 notes）
- 失败实验也清晰展示，附失败原因

**Tab: Paper** — 论文

- Section 列表 + 完成状态
- 点击 section → 显示 LaTeX 源码（可编辑）
- PDF 预览按钮 → 调用 tectonic 编译后显示
- 图表预览

**Tab: Log** — 决策日志

- 时间线视图，显示 `decisions.jsonl` 所有记录
- 每条记录标记 who（user / agent / collaborative）
- 可搜索和过滤

### 10.3 "老板视图" 功能

- **活跃 Session 列表**：当前 scope 下有哪些 session 在工作
- **Agent 活动流**：实时显示 agent 的工具调用摘要
- **实验队列**：正在运行和排队的 inspire 任务

### 10.4 文件 ↔ 前端 的映射

| 前端操作              | 文件操作                                              |
| --------------------- | ----------------------------------------------------- |
| 标记 idea 为 selected | 修改 `ideas/xxx.md` 的 frontmatter `status: selected` |
| 写批注                | 追加到 `ideas/xxx.md` 或 `experiments/xxx.md` 正文    |
| 编辑 LaTeX section    | 直接编辑 `paper/sections/xxx.tex`                     |
| 查看 PDF              | 编译 `paper/main.tex` → 读取 `paper/build/main.pdf`   |
| 查看实验结果          | 读取 `experiments/xxx.md` 的 frontmatter              |
| 查看决策日志          | 读取 `decisions.jsonl`                                |

所有操作最终都是文件读写。前端不维护独立状态。

---

## 十一、开放问题

1. **Research Panel 作为独立面板还是 Side Panel 的一个 Tab？** — Side Panel 已经有 note、agenda、session。再加一个 research tab？还是 research 作为独立面板（像 Terminal Panel 那样可以独立展开）？

2. **LaTeX 编译：tectonic 还是 texlive？** — tectonic 单二进制轻量但包不全；texlive 完整但重。建议 tectonic + 按需下载缺失包。

3. **Ideas 看板的编辑体验** — 用户直接在前端编辑 markdown 内容？还是只能标记状态和写批注，完整编辑交给 agent 或编辑器？

4. **`.research/` 目录是否要 git 管理？** — 自动 commit 每次重要变更？便于版本对比和回滚。

5. **多人协作** — 一个 scope 目前是单用户的。未来如果多人共享一个研究项目，文件冲突怎么处理？

6. **实验结果格式** — frontmatter 的 metrics 块是否需要统一 schema？统一有助于 Panel 渲染和跨实验对比，但灵活性低。
