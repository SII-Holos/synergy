import { expect, test } from "bun:test"
import path from "node:path"

interface ShutdownProbe {
  response: { status: number; body: unknown }
  crossOrigin: { status: number; allowOrigin: string | null }
  preflight: { status: number; allowOrigin: string | null; allowMethods: string | null }
  admissions: string[]
}

async function runShutdownProbe(): Promise<ShutdownProbe> {
  const script = String.raw`
    const { Log } = await import("@ericsanchezok/synergy-harness/util/log")
    Log.init({ print: false })
    const [{ Server }, { RuntimeHandle }, { AgentTurn }, { PolicyWorker }, { ToolScheduler }] = await Promise.all([
      import("@ericsanchezok/synergy-server/server/server"),
      import("./src/server/runtime-handle"),
      import("@ericsanchezok/synergy-harness/session/agent-turn"),
      import("@ericsanchezok/synergy-harness/enforcement/policy-worker"),
      import("@ericsanchezok/synergy-harness/test/support/internals"),
    ])
    const origin = "http://localhost:5173"
    const runtime = await RuntimeHandle.open({ mode: "oneshot", network: { hostname: "127.0.0.1", port: 0 } })
    runtime.closeAdmission()
    const response = await Server.App().request("/global/health")
    const crossOrigin = await Server.App().request("/global/health", { headers: { origin } })
    const preflight = await Server.App().request("/global/health", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    })
    const capture = async (run) => {
      try {
        await run()
        return ""
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const result = {
      response: { status: response.status, body: await response.json() },
      crossOrigin: {
        status: crossOrigin.status,
        allowOrigin: crossOrigin.headers.get("access-control-allow-origin"),
      },
      preflight: {
        status: preflight.status,
        allowOrigin: preflight.headers.get("access-control-allow-origin"),
        allowMethods: preflight.headers.get("access-control-allow-methods"),
      },
      admissions: await Promise.all([
        capture(() => AgentTurn.stream({})),
        capture(() => PolicyWorker.classify({})),
        capture(() => ToolScheduler.dispatch({})),
      ]),
    }
    await runtime.close()
    await Bun.write(Bun.stdout, JSON.stringify(result))
    process.exit(0)
  `
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
  if (exitCode !== 0) throw new Error(`Shutdown probe failed: ${stderr}`)
  return JSON.parse(stdout) as ShutdownProbe
}

test("closes runtime admission without leaking process state", async () => {
  const result = await runShutdownProbe()

  expect(result.response).toEqual({
    status: 503,
    body: {
      name: "RuntimeShuttingDown",
      data: { message: "Synergy runtime is shutting down" },
    },
  })
  expect(result.crossOrigin).toEqual({
    status: 503,
    allowOrigin: "http://localhost:5173",
  })
  expect(result.preflight.status).toBe(204)
  expect(result.preflight.allowOrigin).toBe("http://localhost:5173")
  expect(result.preflight.allowMethods).toContain("GET")
  expect(result.admissions).toEqual([
    "Agent worker pool is stopping",
    "Policy worker pool is stopping",
    "Tool scheduler is stopping",
  ])
})
