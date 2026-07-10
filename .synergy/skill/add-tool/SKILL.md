---
name: add-tool
description: "Guide for adding a new tool to Synergy. Use when implementing a new tool definition, extending an existing tool, or modifying tool schemas. Triggers: 'add tool', 'new tool', 'create tool', 'implement tool', 'Tool.define'."
---

# Adding a New Tool to Synergy

## Location

All tools live in `packages/synergy/src/tool/`. Each tool is typically one file (e.g., `read.ts`, `edit.ts`, `bash/local.ts`).

## Pattern

Tools are defined using `Tool.define()`. Always read an existing tool in the same directory before creating a new one — match the local pattern exactly.

```ts
import { Tool } from "./tool"

export const MyTool = Tool.define("my_tool", {
  description: "What this tool does",
  parameters: z.object({
    param1: z.string().describe("Parameter description"),
    param2: z.number().optional().describe("Optional param"),
  }),
  async execute(params, ctx) {
    // Implementation
    return {
      title: "My Tool Result",
      metadata: {},
      output: "result text or JSON",
    }
  },
})
```

Key differences from the `Tool.Info` init shape:

- `id` is a **separate first argument** (not `name` inside an object).
- The second argument is the init object with `description`, `parameters`, and `execute`.
- `execute` receives `(args, ctx)` where `ctx` has `sessionID`, `messageID`, `agent`, `abort`, `callID`, `metadata()`, and `ask()`.
- The return value is `{ title, metadata, output, attachments? }`.

For tools that need dynamic descriptions, pass a factory function instead of a plain object:

```ts
Tool.define("my_tool", async (initCtx) => ({
  description: buildDescription(),
  parameters: z.object({...}),
  execute(params, ctx) { ... },
}))
```

## Registration

### Backend: `packages/synergy/src/tool/registry.ts`

1. **Import your tool constant** at the top of `registry.ts`.
2. **Add it to the `builtin` array** inside the `all()` function (around line 343):

```ts
const builtin: Tool.Info[] = [
  BashTool,
  ReadTool,
  EditTool,
  MyTool, // ← add here, in alphabetical position
  // ...
]
```

Tools are typically ordered alphabetically within the array. For conditional tools (e.g., CLI-only or feature-flagged), wrap in a ternary:

```ts
...(Flag.SYNERGY_CLIENT === "cli" ? [QuestionTool] : []),
```

### Frontend Registration (5 files)

A new tool must be registered in **five** frontend files for full UI support:

| #   | File                                            | What to do                                                                                                             |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/ui/src/components/icon.tsx`           | Import a Lucide icon and add to the `icons` map. Pick an icon not used by any existing tool.                           |
| 2   | `packages/ui/src/components/message-part.tsx`   | Add a `case` in `getToolInfo()` returning `{ icon, title, subtitle, args }`. This drives tool card display.            |
| 3   | `packages/ui/src/components/tool-renders.tsx`   | Append the tool name to its group array (e.g., `inspireToolNames`, `researchToolNames`) so `ToolRegistry` picks it up. |
| 4   | `packages/synergy/src/tool/taxonomy.ts`         | Add an entry with the correct domain kind and traits (`stateful`, `externalIO`).                                       |
| 5   | `packages/ui/src/components/tool/classifier.ts` | Add to `TOOL_CATEGORIES` with the appropriate semantic category (fallback if steps 2–3 are missed).                    |

Skipping any of these causes the tool to fall back to a generic icon and label, or to miss permission tracking.

## SDK Regeneration

If the tool is API-visible (has `.meta({ ref: "TypeName" })` on its parameters), regenerate the SDK:

```bash
./script/generate.ts
```

## Error Handling

Tool files use **plain `throw new Error(...)`**, not `NamedError.create()`. The `NamedError` pattern is used in other domains (provider, session, config, etc.) but not in tool implementations.

```ts
if (!valid) throw new Error("Validation failed: reason")
```

## Testing

Put tests in `packages/synergy/test/tool/<name>.test.ts`.

Use `tmpdir()` from `@/test/fixture/fixture` for isolated test directories. Study existing tool tests:

- `test/tool/read.test.ts` — tool test with tmpdir + context override
- `test/tool/taxonomy.test.ts` — simple classification test
- `test/tool/bash.test.ts` — process management test

## Quality Verification

Before committing a new tool:

```bash
bun run typecheck          # verify no type errors
bun run quality:quick      # format:check + lint + typecheck + monorepo:check + package:check
cd packages/synergy && bun test test/tool/<name>.test.ts  # narrow test
```

## Key Files

| File                                            | Purpose                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/synergy/src/tool/tool.ts`             | `Tool.define()` API — signature is `define(id: string, init, options?)` |
| `packages/synergy/src/tool/registry.ts`         | Tool registry — `builtin` array + `ToolRegistry.register()`             |
| `packages/synergy/src/tool/read.ts`             | Simple tool example                                                     |
| `packages/synergy/src/tool/edit.ts`             | Complex tool example                                                    |
| `packages/synergy/src/tool/taxonomy.ts`         | Tool taxonomy (domain + traits)                                         |
| `packages/ui/src/components/icon.tsx`           | Frontend icon map                                                       |
| `packages/ui/src/components/message-part.tsx`   | Tool card info                                                          |
| `packages/ui/src/components/tool-renders.tsx`   | Tool group registration                                                 |
| `packages/ui/src/components/tool/classifier.ts` | Fallback classifier                                                     |
| `packages/synergy/test/tool/`                   | All tool tests                                                          |
