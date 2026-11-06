import { expect, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RuntimeRoute } from "../../src/server/runtime-route"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const app = new Hono().route("/runtime", RuntimeRoute())

test("exposes the current resource snapshot independently of telemetry", () =>
  runtime.run(async () => {
    const response = await app.request("/runtime/resources")
    expect(response.status).toBe(200)
    const status = await response.json()
    expect(status.snapshot.domains[0].kind).toBe("physical")
    expect(status.revision).toBeGreaterThan(0)
    expect(status).toMatchObject({ active: 0, queued: 0 })
  }))

function capacityStatus() {
  return app.request("/runtime/agent-workers")
}

test("reports the machine-derived capacity and its source while agentWorkers is unset", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const response = await capacityStatus()
        expect(response.status).toBe(200)
        const status = (await response.json()) as { configured: number | null; ceiling: number; source: string }
        expect(status).toMatchObject({ configured: null, source: "derived" })
        expect(status.ceiling).toBeGreaterThanOrEqual(1)
      },
    })
  }))

test("reports an explicit ceiling verbatim as the ceiling capacity", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: { execution: { agentWorkers: 6 } } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await (await capacityStatus()).json()).toEqual({
          configured: 6,
          ceiling: 6,
          source: "explicit",
          workers: 0,
          active: 0,
          queued: 0,
        })
      },
    })
  }))

test("treats a cleared ceiling as unset all the way through the stored configuration", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: { execution: { agentWorkers: null, agentWorkerMinIdle: 0 } } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect((await Config.current()).execution?.agentWorkers).toBeNull()
        const status = (await (await capacityStatus()).json()) as { configured: number | null; source: string }
        expect(status).toMatchObject({ configured: null, source: "derived" })
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
