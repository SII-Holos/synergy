# Synergy Diff 渲染升级完整方案（@pierre/diffs）

> 状态: 已实施（Phase 1 + Phase 2），PR 待评审
> 日期: 2026-08-05
> 范围: `packages/ui` / `packages/app` / `packages/synergy` / `packages/sdk`

## 1. 背景与目标

diffs.com 即开源库 **`@pierre/diffs`**（The Pierre Computer Co.，Apache-2.0，基于 Shiki）。 Synergy 已集成 `@pierre/diffs@1.0.2`（catalog 锁定，2025-12-23），但：

1. **版本落后 7 个月 / 30+ 个版本**：latest 为 `1.3.3`（2026-08-05），新增虚拟化、merge conflict UI、annotations、编辑模式等能力。
2. **覆盖不全**：富渲染只用于消息中的 diff part；Session Review 面板和工具卡片（save_file / revise_file / edit / multiedit）仍用手写纯文本预览（无语法高亮、无 split 视图）。

目标：

- **P0（Phase 1）**：升级 `@pierre/diffs` 至 1.3.3，零功能变化回归。 ✅ 已完成
- **P1（Phase 2）**：Session Review + 工具卡片迁移到 pierre 富渲染（语法高亮 + unified/split）。 ✅ 已完成
- **P2（Phase 3，可选）**：利用 1.3.x 新能力增强代码评审（annotations / merge conflict / 虚拟化 / 编辑模式）。

## 2. 现状盘点（已核实）

### 2.1 依赖与封装

| 位置                                          | 内容                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 根 `package.json`                             | `"@pierre/diffs": "1.3.3"`（catalog，已升级）+ `"@shikijs/themes": "4.2.0"`（修复 ayu-light 解析） |
| `packages/ui/src/pierre/index.ts`             | `createDefaultOptions`（Synergy 主题、`unsafeCSS` 覆盖）+ `styleVariables`                         |
| `packages/ui/src/pierre/worker.ts`            | `WorkerPoolManager`（poolSize 2，unified/split 各一池），`worker.js?worker&url`                    |
| `packages/ui/src/components/diff.tsx`         | 客户端 `FileDiff` 封装（checksum cacheKey、移动端去行号）                                          |
| `packages/ui/src/components/diff-ssr.tsx`     | SSR 水合封装（使用私有 `fileContainer` hack）                                                      |
| `packages/ui/src/context/diff.tsx`            | `DiffComponentProvider`（app 注入懒加载组件）                                                      |
| `packages/ui/src/context/worker-pool.tsx`     | `WorkerPoolProvider`                                                                               |
| `packages/app/src/app.tsx`                    | `DiffComponentProvider` 注册（lazy + `ensureSynergyHighlightTheme`）                               |
| `packages/ui/src/context/marked.tsx`          | `ensureSynergyHighlightTheme()` → `pierre.registerCustomTheme("Synergy", …)`                       |
| `packages/ui/src/components/message-part.tsx` | 消息 diff part 通过 `useDiffComponent` 渲染                                                        |

### 2.2 三条渲染路径（升级前）

- **路径 A（pierre 富渲染）**：消息内 diff part → `DiffComponentProvider` → `diff.tsx` / `diff-ssr.tsx`。
- **路径 B（手写轻量）**：`SessionReview` → `tool/diff-preview.tsx`（`classifyToolDiffLine` 纯文本着色）+ `DiffChanges`（+N/-N 条）。数据为 SDK `FileDiff`。
- **路径 C（手写轻量）**：工具卡片 `AnchoredSaveTool` / `AnchoredReviseTool` / edit / multiedit → `ToolDiffPreview`（同一个手写组件，数据为 `metadata.filediff` + `metadata.diff` 完整 unified diff 文本）。

### 2.3 数据契约（后端 → SDK → 前端）

- `FileDiff { file, additions, deletions, binary?, preview?, patch?, beforeBytes?, afterBytes?, truncated? }`
  （`packages/synergy/src/session/snapshot-schema.ts` → `packages/sdk/js/src/gen/types.gen.ts`；`patch` 为本方案新增可选字段）
- 服务端 `GET /:sessionID/diff` → `Session.diff` → `Storage.read(sessionSummary)`（`packages/synergy/src/server/session.ts:1001`）
- `preview` 生成：`packages/synergy/src/file/index.ts`（`git diff` / `git diff --staged` / `git show HEAD:file` + `structuredPatch(context: Infinity)`）+ `hashline/diff-preview.ts`（compact 预览）
- **关键缺口（已修复）**：summary 只持久化 compact `preview` 文本，**丢失完整 patch**；历史会话无法重建富 diff → 现在 `Snapshot.diffSummary` 的 `fromPatch` 同时持久化 `patch` 字段。

## 3. 版本差异硬证据（1.0.2 → 1.3.3，tarball 对比）

### 3.1 破坏性/需适配的变更

| 变更                                                                                                                                          | 影响                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MouseEventManager` → `InteractionManager`（`pluckInteractionOptions`）                                                                       | 导出重命名，未直接使用，无影响                                                                                                                                                                     |
| `FileDiffHydrationProps` 要求 `fileContainer` + `prerenderedHTML`                                                                             | `diff-ssr.tsx` 已核对，字段名未变                                                                                                                                                                  |
| `WorkerInitializationRenderOptions` 新增 `preferredHighlighter`、`useTokenTransformer`、`maxLineDiffLength`；`tokenizeMaxLineLength` 语义保留 | 现有 `{theme, lineDiffType}` 兼容                                                                                                                                                                  |
| 新增依赖 `@pierre/theme@2`、`@pierre/theming@1`；`shiki` 改为 `^3 \|\| ^4`；`diff@9`                                                          | **`@pierre/theming` 动态 import `@shikijs/themes/*` 完整主题集，与 shiki@3.20 自带的 `@shikijs/themes@3.20.0` 冲突（缺 `ayu-light`）→ 在 `packages/ui` 显式依赖 `@shikijs/themes@4.2.0` 隔离共存** |
| worker 新增 wasm 资源（`wasm-*.js`）；默认 `preferredHighlighter = "shiki-js"`（JS regex 引擎）                                               | 保持默认即可，无需引入 wasm                                                                                                                                                                        |
| `FileDiffOptions.hunkSeparators` 类型收紧；新增 `renderGutterUtility`、`renderCustomHeader` 等                                                | 可选能力，未使用                                                                                                                                                                                   |
| 导出新增 `./edit`、`./worker/worker-portable.js` 等                                                                                           | 可选                                                                                                                                                                                               |
| **`maxLineLengthForHighlighting` 在两个版本中均非官方字段**（1.3.3 对应 `tokenizeMaxLineLength`/`maxLineDiffLength`）                         | 已清理：改用 `tokenizeMaxLineLength`                                                                                                                                                               |

### 3.2 保持兼容的 API（升级风险低）

- `WorkerPoolManager` 构造签名形态不变（`options` + `WorkerInitializationRenderOptions`，后者仍为 `Partial`）
- `FileDiff` 实例 `render` / `hydrate` / `cleanUp` 基本形态保留
- `FileContents.cacheKey` 保留
- `ThemeTypes = 'system' | 'light' | 'dark'` 不变
- `@pierre/diffs/worker` 的 `worker.js?worker&url` 导出保留
- `registerCustomTheme` 保留（新增 `registerCustomCSSVariableTheme`）；重复注册安全（`DuplicateThemeError` 被吞并返回）

### 3.3 需实测项（自动化无法覆盖）

- `unsafeCSS` 中使用的 DOM 选择器（`data-expand-button`、`data-separator-*`、`data-code`）在 1.3.3 是否仍命中 —— 升级后构建通过，运行时待冒烟
- `diff-ssr.tsx` 私有 `fileContainer` 赋值是否仍有效 —— 类型未变，运行时待冒烟

## 4. 目标架构（实际采用）

统一所有 diff 渲染到 pierre：

```
消息 diff part（已有，路径 A）
Session Review（Phase 2 迁移，路径 B → A）✅
工具卡片 save_file/revise_file/edit/multiedit（Phase 2 迁移，路径 C → A）✅
```

数据流（Phase 2）：

```
后端: diffSummary 生成完整 unified patch → FileDiff.patch（可选字段，随 summary 持久化）
前端: canRenderPatch(patch) 校验单文件可解析 → DiffPatch（parsePatchFiles → pierre FileDiff）
旧数据无 patch / 多文件 / 截断 preview → 降级 DiffPreview / ToolDiffPreview（向后兼容）
```

设计权衡（实际采用）：

- **patch 单份优于 before+after 双份**：体积小、pierre 原生支持（`parsePatchFiles`）。
- **patch 随 summary 持久化优于按需端点**：`Session.diff` 已随 summary 读取，patch 作为可选字段随行返回；`bounds.diffAggregate` 对 preview 与 patch 分别设 1MB 聚合上限防膨胀。
- **可选字段 + 降级路径优于存储迁移**：旧 summary 无 patch 自然降级，无需迁移。

新增组件：

- `packages/ui/src/components/diff-patch-utils.ts` — `canRenderPatch()` 纯函数（单文件 unified diff 可解析性 + 截断标记检测；独立模块便于单测，避免 vite worker URL 依赖）
- `packages/ui/src/components/diff-patch.tsx` — `DiffPatch` 组件：`parsePatchFiles` → `FileDiff.render({ fileDiff })`，unified/split 布局、移动端去行号、主题预加载

## 5. 分阶段实施（已完成）

### Phase 1 — 升级 @pierre/diffs 1.0.2 → 1.3.3 ✅

**改动**

1. `package.json` catalog：`"@pierre/diffs": "1.3.3"` + `"@shikijs/themes": "4.2.0"`，`bun install`
2. `packages/ui/src/pierre/index.ts`：`maxLineLengthForHighlighting` → `tokenizeMaxLineLength`
3. `packages/ui/package.json`：显式依赖 `@shikijs/themes`（catalog 4.2.0），解决 `@pierre/theming` 的 ayu-light 解析失败

**验证**

- ✅ `bun run --cwd packages/ui typecheck`
- ✅ `bun run --cwd packages/ui test`（全绿）
- ✅ `bun run --cwd packages/app build`（worker/wasm 打包正常，18s）
- ✅ `bun run --cwd packages/app typecheck`

### Phase 2 — Session Review + 工具卡片迁移到 pierre ✅

**后端（`packages/synergy`）**

1. `snapshot-schema.ts`：`FileDiff` 增加可选 `patch?: string`；`fromPatch` / `normalize` 透传 patch
2. `bounds.ts`：`diffAggregate` 对 `preview` 与 `patch` 分别设 1MB 聚合上限（`DIFF_AGGREGATE_PATCH_MAX_BYTES`），超限丢弃并标 `truncated`
3. `./script/generate.ts` 重新生成 SDK（`types.gen.ts` 增加 `patch` 字段）

**前端（`packages/ui`）**

1. 新增 `DiffPatch` 组件 + `canRenderPatch` 纯函数（含截断标记检测）
2. `session-review.tsx`：有可解析 patch → `DiffPatch`（跟随 diffStyle RadioGroup）；否则降级 `DiffPreview`
3. `anchored-tool-card.tsx`：`AnchoredReviseTool` / `AnchoredSaveTool` 优先 `metadata.diff`（完整 unified diff），可解析 → `DiffPatch`；否则降级 `ToolDiffPreview`
4. `tool/renders/file-ops.tsx`：edit / multiedit 同样接入 `DiffPatch` + 降级

**验证**

- ✅ `bun run --cwd packages/synergy test test/session/summary.test.ts test/snapshot/snapshot.test.ts`（62 pass）
- ✅ `packages/ui/test/components/diff-patch.test.ts`（7 pass：单文件 / git 风格 / 新建文件 / 空值 / 非 diff / 截断 / 多文件）
- ✅ `bun run --cwd packages/ui typecheck` + `bun run --cwd packages/app typecheck`
- ✅ `bun run --cwd packages/app build`

### Phase 3 — 可选增强（独立排期，每项 1–3 天）

| 项  | 能力                               | 场景                                          |
| --- | ---------------------------------- | --------------------------------------------- |
| 3a  | Annotations + accept/reject        | Session Review 行内注释/采纳按钮（文档 demo） |
| 3b  | `UnresolvedFile` merge conflict UI | hashline 恢复 / 冲突处理联动                  |
| 3c  | `Virtualizer` / `CodeView`         | 大文件 diff 渲染性能                          |
| 3d  | `EditProvider` 编辑模式            | 评审中直接编辑 diff                           |

各项与 Phase 1/2 解耦，按产品优先级单独评审。

## 6. 测试与质量门禁

- 每阶段：`bun run --cwd packages/synergy test:changed`、`bun run --cwd packages/app test`、`bun run --cwd packages/ui test` ✅
- 根门禁：`bun run quality:quick`（format / lint / typecheck）—— 提交前运行
- 浏览器冒烟：生产构建 private HTTP browser smoke（`packages/app/AGENTS.md`）—— PR 前运行
- 测试文件一律放 `test/` 目录（`test-layout:check` 强制）✅
- 后端持久化变更走 `change-persistence`；API 变更走 `change-server-api`（OpenAPI + SDK 生成）✅

## 7. 风险登记

| 风险                                                                           | 等级               | 缓解                                                       |
| ------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------- |
| SSR 私有 API hack（`fileContainer`）失效                                       | 中                 | 类型未变；运行时冒烟确认                                   |
| `unsafeCSS` DOM 选择器失效                                                     | 中                 | 升级后构建通过；运行时冒烟确认                             |
| `@pierre/theming` 引用 `@shikijs/themes` 子路径（ayu-light）与 shiki 3.20 冲突 | 中（已解决）       | `packages/ui` 显式依赖 `@shikijs/themes@4.2.0` 隔离共存    |
| sessionSummary 体积（patch 随行）                                              | 中                 | `diffAggregate` 对 patch 单独 1MB 聚合上限                 |
| jsdom 测试环境 worker 不可用                                                   | 中（已解决）       | `canRenderPatch` 抽到独立 utils 模块，纯函数单测           |
| 截断 preview 被 pierre 解析为残缺 diff                                         | 中（已发现并修复） | `canRenderPatch` 检测 `[N characters omitted]` 标记 → 降级 |
| `packages/ui` 为 plugin kit 契约                                               | 中                 | 只新增导出（`./pierre/*` 通配已覆盖新组件），无破坏性改动  |

## 8. 回滚

- Phase 1：仅动 catalog 版本 + 封装适配 → 还原 catalog 至 1.0.2 即回滚
- Phase 2：前后端独立可回滚；`patch` 为可选字段，前端降级路径保留现状渲染

## 9. 明确不做

- 不修改 hashline 的 diff 3-way merge 恢复逻辑（独立域，本次不动）
- 不引入 `shiki-wasm`（收益与体积不成比例，保持 JS 引擎）
- 不迁移旧 sessionSummary 结构（可选字段 + 降级路径避免迁移）
- 不升级 shiki 到 4.x（`@shikijs/themes@4.2.0` 仅作为 pierre theming 的隔离依赖）
