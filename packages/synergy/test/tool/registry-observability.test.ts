import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("successful tool initialization does not emit per-tool info records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-tool-registry-telemetry-"))
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-tool-registry-project-"))
  const script = `
    import { Log } from "./src/util/log.ts"
    import { ObservabilityStore } from "./src/observability/store.ts"
    import { Scope } from "./src/scope/index.ts"
    import { ScopeContext } from "./src/scope/context.ts"
    import { ToolRegistry } from "./src/tool/registry.ts"

    await Log.init({ print: false, dev: true, level: "INFO" })
    const { scope } = await Scope.fromDirectory(${JSON.stringify(project)})
    const toolCount = await ScopeContext.provide({
      scope,
      fn: async () => (await ToolRegistry.tools("test-provider")).length,
    })
    const events = ObservabilityStore.queryEvents({ type: "log.record" }).filter((item) => {
      const data = JSON.parse(item.data_json)
      return item.level === "info" && data.service === "tool.registry"
    })
    ObservabilityStore.close()
    process.stdout.write(JSON.stringify({ toolCount, events: events.map((item) => JSON.parse(item.data_json)) }))
  `
  const env = { ...process.env }
  delete env.SYNERGY_HOME
  env.SYNERGY_TEST_HOME = home
  env.SYNERGY_DISABLE_MODELS_FETCH = "true"
  env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH = "true"
  env.SYNERGY_DISABLE_DEFAULT_PLUGINS = "true"
  env.SYNERGY_DISABLE_LSP_DOWNLOAD = "true"
  env.SYNERGY_DISABLE_FILEWATCHER = "true"

  try {
    const proc = Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(stderr)

    const result = JSON.parse(stdout) as {
      toolCount: number
      events: Array<Record<string, unknown>>
    }
    expect(result.toolCount).toBeGreaterThan(0)
    expect(result.events).toEqual([])
  } finally {
    await Promise.all([fs.rm(home, { recursive: true, force: true }), fs.rm(project, { recursive: true, force: true })])
  }
})
