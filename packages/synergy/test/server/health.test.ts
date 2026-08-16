import { expect, test } from "bun:test"
import path from "node:path"

interface HealthProbeResult {
  status: number
  body: { healthy: boolean; version: string; modelReady: boolean }
  elapsedMs: number
}

async function runHealthProbe(script: string): Promise<HealthProbeResult> {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Health probe failed: ${stderr}`)
  return JSON.parse(stdout) as HealthProbeResult
}

test("health answers within budget when provider state hangs on network", async () => {
  const result = await runHealthProbe(`
    const { Log } = await import("./src/util/log")
    Log.init({ print: false })
    const [{ Server }, { Provider }] = await Promise.all([
      import("./src/server/server"),
      import("./src/provider/provider"),
    ])
    // Simulate a provider state build that is stuck on an unreachable registry:
    // the health endpoint must still answer well within the daemon probe window.
    Provider.list = async () => {
      await Bun.sleep(10_000)
      return {}
    }
    const started = performance.now()
    const response = await Server.App().request("/global/health")
    const elapsedMs = performance.now() - started
    const body = await response.json()
    await Bun.write(Bun.stdout, JSON.stringify({ status: response.status, body, elapsedMs }))
    process.exit(0)
  `)

  expect(result.status).toBe(200)
  expect(result.body.healthy).toBe(true)
  expect(result.body.modelReady).toBe(true)
  expect(result.elapsedMs).toBeLessThan(3_000)
})

test("health reports modelReady from provider state when it resolves quickly", async () => {
  const result = await runHealthProbe(`
    const { Log } = await import("./src/util/log")
    Log.init({ print: false })
    const [{ Server }, { Provider }] = await Promise.all([
      import("./src/server/server"),
      import("./src/provider/provider"),
    ])
    Provider.list = async () => ({})
    const response = await Server.App().request("/global/health")
    const body = await response.json()
    await Bun.write(Bun.stdout, JSON.stringify({ status: response.status, body, elapsedMs: 0 }))
    process.exit(0)
  `)

  expect(result.status).toBe(200)
  expect(result.body.healthy).toBe(true)
  expect(result.body.modelReady).toBe(false)
})
