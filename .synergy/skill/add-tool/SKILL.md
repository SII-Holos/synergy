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

export const myTool = Tool.define({
  name: "my_tool",
  description: "What this tool does",
  parameters: z.object({
    param1: z.string().describe("Parameter description"),
    param2: z.number().optional().describe("Optional param"),
  }),
  async execute(params, context) {
    // Implementation
    return { result: "..." }
  },
})
```

## Checklist

1. **Read adjacent tools** — understand the conventions in the directory
2. **Define with `Tool.define()`** — use Zod schemas for parameters
3. **Add `.describe()` to every parameter** — these become user-facing documentation
4. **Add `.meta({ ref: "TypeName" })` if API-exposed** — for SDK generation
5. **Handle errors properly** — use `NamedError.create()` where that pattern exists
6. **Consider permissions** — check if the tool needs permission gating (see `packages/synergy/src/permission/`)
7. **Register the tool** — add it to the tool registry in `packages/synergy/src/tool/index.ts`
8. **Regenerate SDK** — run `./script/generate.ts` if the tool is API-visible
9. **Add tests** — put them in `packages/synergy/test/tool/`
10. **Run `bun run typecheck`** — verify no type errors

## Key files to reference

- `packages/synergy/src/tool/tool.ts` — `Tool.define()` implementation
- `packages/synergy/src/tool/index.ts` — tool registry
- `packages/synergy/src/tool/read.ts` — simple tool example
- `packages/synergy/src/tool/edit.ts` — tool with complex validation
- `packages/synergy/src/tool/bash/local.ts` — tool with process management
