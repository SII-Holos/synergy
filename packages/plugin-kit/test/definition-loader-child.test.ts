import { describe, expect, test } from "bun:test"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"
import { loadPluginDefinition } from "../src/lib/definition"

describe("definition loader child", () => {
  test("serializes a definePlugin() definition across the process boundary", async () => {
    const project = createFixtureProject("loader-child-")
    try {
      writeMinimalPlugin(
        project,
        `import z from "zod"
import { definePlugin, event, hook, operation, tool } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "loader-child",
  version: "1.0.0",
  description: "Loader child fixture",
  contributions: [
    operation({
      id: "query", type: "query",
      input: z.object({ value: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    }),
    event({ id: "changed", payload: z.object({ at: z.number() }) }),
    tool({ id: "echo", description: "Echo", input: { type: "object" }, handler: async () => "ok" }),
    hook({ id: "hook", point: "runtime.started", handler: async () => undefined }),
  ],
  activate: async () => undefined,
  deactivate: async () => undefined,
})
`,
        "loader-child",
      )
      const { definition: snapshot } = await loadPluginDefinition(project.root)
      expect(snapshot.id).toBe("loader-child")
      expect(snapshot.handlerIds.sort()).toEqual(["hook:hook", "operation:query", "tool:echo"])
      expect(snapshot.activate).toBeTypeOf("function")
      expect(snapshot.deactivate).toBeTypeOf("function")

      const [operation, event, tool, hook] = snapshot.contributions
      expect(operation.kind).toBe("operation")
      expect(operation.input.type).toBe("object")
      expect(operation.output.type).toBe("object")
      expect(event.kind).toBe("event")
      expect(event.payload.type).toBe("object")
      expect(tool.kind).toBe("tool")
      expect(tool.input).toEqual({ type: "object" })
      expect(hook.kind).toBe("hook")
      expect(hook.point).toBe("runtime.started")
      expect(JSON.stringify(snapshot)).not.toContain("_zod")
    } finally {
      project.cleanup()
    }
  })

  test("rejects an entry that does not export a definition", async () => {
    const project = createFixtureProject("loader-child-missing-")
    try {
      project.writeFile("index.ts", "export default { not: 'a definition' }\n")
      await expect(loadPluginDefinition(project.root)).rejects.toThrow(/No definePlugin\(\) definition exported/)
    } finally {
      project.cleanup()
    }
  })

  test("rejects an entry that fails to load", async () => {
    const project = createFixtureProject("loader-child-broken-")
    try {
      project.writeFile("index.ts", "export default @")
      await expect(loadPluginDefinition(project.root)).rejects.toThrow()
    } finally {
      project.cleanup()
    }
  })
})
