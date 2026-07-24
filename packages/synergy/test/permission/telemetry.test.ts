import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("permission evaluation does not emit per-check telemetry at info level", async () => {
  const result = await evaluateWithTelemetry("INFO")

  expect(result.action).toBe("allow")
  expect(result.data).toBeUndefined()
})

test("permission evaluation emits bounded telemetry without rule contents at debug level", async () => {
  const result = await evaluateWithTelemetry("DEBUG")

  expect(result.action).toBe("allow")
  expect(result.data).toMatchObject({
    service: "permission",
    message: "evaluate",
    permission: result.permission,
    patternLength: result.sensitivePattern.length,
    rulesetCount: 257,
  })
  expect(result.data).not.toHaveProperty("pattern")
  expect(result.data).not.toHaveProperty("ruleset")
  expect(JSON.stringify(result.data)).not.toContain(result.sensitivePattern)
  expect(JSON.stringify(result.data).length).toBeLessThan(256)
})

async function evaluateWithTelemetry(level: "INFO" | "DEBUG") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-permission-telemetry-"))
  const script = `
    import { Log } from "./src/util/log.ts"
    import { ObservabilityStore } from "./src/observability/store.ts"
    import { PermissionNext } from "./src/permission/next.ts"

    await Log.init({ print: false, dev: true, level: "${level}" })

    const permission = \`telemetry-test-\${crypto.randomUUID()}\`
    const sensitivePattern = \`secret-pattern-\${crypto.randomUUID()}\`
    const ruleset: PermissionNext.Ruleset = [
      ...Array.from({ length: 256 }, (_, index) => ({
        permission,
        pattern: \`\${sensitivePattern}-\${index}\`,
        action: "ask" as const,
      })),
      { permission, pattern: sensitivePattern, action: "allow" },
    ]

    const action = PermissionNext.evaluate(permission, sensitivePattern, ruleset).action
    const event = ObservabilityStore.queryEvents({ type: "log.record" }).find((item) => {
      const data = JSON.parse(item.data_json)
      return data.permission === permission
    })
    const data = event ? JSON.parse(event.data_json) : undefined
    ObservabilityStore.close()
    process.stdout.write(JSON.stringify({ action, data, permission, sensitivePattern }))
  `
  const env = { ...process.env }
  delete env.SYNERGY_HOME
  env.SYNERGY_TEST_HOME = home
  env.SYNERGY_DISABLE_MODELS_FETCH = "true"

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

    return JSON.parse(stdout) as {
      action: string
      data?: Record<string, unknown>
      permission: string
      sensitivePattern: string
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}
