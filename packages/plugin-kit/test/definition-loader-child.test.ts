import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { captureStdout, createFixtureProject, writeMinimalPlugin } from "./fixtures"

const loaderChildPath = path.resolve(import.meta.dir, "../src/lib/definition-loader-child.ts")
const marker = "__SYNERGY_PLUGIN_DEFINITION__"

function cacheBustedSpecifier(label: string) {
  return `../src/lib/definition-loader-child.ts?probe=${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function runLoaderChild(argvTail: string[], label: string) {
  const originalArgv = process.argv
  process.argv = [...process.argv, ...argvTail]
  try {
    return await captureStdout(() => import(cacheBustedSpecifier(label)))
  } finally {
    process.argv = originalArgv
  }
}

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
      const entry = path.join(project.root, "src", "index.ts")
      const { output } = await runLoaderChild([entry], "success")

      expect(output).toContain(marker)
      const snapshot = JSON.parse(output.slice(output.lastIndexOf(marker) + marker.length))
      expect(snapshot.id).toBe("loader-child")
      expect(snapshot.handlerIds.sort()).toEqual(["hook:hook", "operation:query", "tool:echo"])
      expect(snapshot.__hasActivate).toBe(true)
      expect(snapshot.__hasDeactivate).toBe(true)

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
      project.writeFile("entry.ts", "export default { not: 'a definition' }\n")
      await expect(runLoaderChild([path.join(project.root, "entry.ts")], "no-definition")).rejects.toThrow(
        /No definePlugin\(\) definition exported/,
      )
    } finally {
      project.cleanup()
    }
  })

  test("rejects a missing entry argument", async () => {
    await expect(runLoaderChild([loaderChildPath], "missing-entry")).rejects.toThrow(
      /definition entry argument is missing/,
    )
  })

  test("rejects an entry that fails to load", async () => {
    const project = createFixtureProject("loader-child-broken-")
    try {
      project.writeFile("entry.ts", "export default @")
      await expect(runLoaderChild([path.join(project.root, "entry.ts")], "broken")).rejects.toThrow()
    } finally {
      project.cleanup()
    }
  })
})
