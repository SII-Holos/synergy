import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ScopeContext } from "../../src/scope/context"
import { FileSearchTool } from "../../src/tool/file-search"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-file-search",
  messageID: "",
  callID: "",
  agent: "implementation-engineer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.file_search", () => {
  test("returns fuzzy path matches with metadata", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src", "components"), { recursive: true })
        await Bun.write(path.join(dir, "src", "components", "file-panel.tsx"), "export const FilePanel = 1")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "file panel" }, ctx)
        expect(result.output).toContain("file src/components/file-panel.tsx")
        expect(result.metadata.pathCount).toBeGreaterThan(0)
        expect(result.metadata.count).toBeGreaterThan(0)
      },
    })
  })

  test("returns content matches with [content] prefix and line info", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(
          path.join(dir, "src", "tool.ts"),
          "export function ToolDefine(name: string) {\n  return { name }\n}\n",
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "ToolDefine" }, ctx)
        expect(result.output).toContain("[content]")
        expect(result.output).toContain("src/tool.ts")
        expect(result.output).toContain("ToolDefine")
        expect(result.metadata.contentCount).toBeGreaterThan(0)
      },
    })
  })

  test("merges path and content results in output", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(
          path.join(dir, "src", "widget-name.tsx"),
          "export function WidgetName() { return 'WidgetName widget' }\n",
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "widget" }, ctx)
        expect(result.output).toContain("file src/widget-name.tsx")
        expect(result.output).toContain("[content] src/widget-name.tsx")
        expect(result.metadata.pathCount).toBeGreaterThan(0)
        expect(result.metadata.contentCount).toBeGreaterThan(0)
      },
    })
  })

  test("empty query returns path-only results", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "a.ts"), "// a")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "" }, ctx)
        expect(result.output).toContain("file src/a.ts")
        expect(result.output).not.toContain("[content]")
        expect(result.output).not.toContain("[symbol]")
        expect(result.metadata.contentCount).toBe(0)
        expect(result.metadata.symbolCount).toBe(0)
      },
    })
  })

  test("whitespace-only query returns path-only mode (no content/symbol search)", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "  " }, ctx)
        expect(result.output).not.toContain("[content]")
        expect(result.output).not.toContain("[symbol]")
        expect(result.metadata.contentCount).toBe(0)
        expect(result.metadata.symbolCount).toBe(0)
      },
    })
  })

  test("returns zero-result guidance when nothing matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "readme.md"), "# nothing here")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "xyznonexistent12345" }, ctx)
        expect(result.output).toContain("No results found")
        expect(result.output).toContain("Tips:")
        expect(result.metadata.count).toBe(0)
      },
    })
  })

  test("metadata includes per-mode counts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "special-file.ts"), "export const SpecialName = 1")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "SpecialName" }, ctx)
        expect(result.metadata.pathCount).toBeGreaterThanOrEqual(0)
        expect(result.metadata.contentCount).toBeGreaterThanOrEqual(0)
        expect(result.metadata.symbolCount).toBeGreaterThanOrEqual(0)
        expect(result.metadata.count).toBe(
          result.metadata.pathCount + result.metadata.contentCount + result.metadata.symbolCount,
        )
      },
    })
  })

  test("respects limit parameter for merged results", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        // Create files with repeating pattern to generate multiple content matches
        await Bun.write(path.join(dir, "src", "a.ts"), "commonMarker commonMarker\n" + "commonMarker\n".repeat(10))
        await Bun.write(path.join(dir, "src", "b.ts"), "commonMarker\n".repeat(10))
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "commonMarker", limit: 5 }, ctx)
        expect(result.metadata.count).toBeLessThanOrEqual(5)
      },
    })
  })
})
