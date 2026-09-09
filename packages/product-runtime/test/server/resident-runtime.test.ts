import { expect, test } from "bun:test"
import { ProductRuntimeHandle } from "../../src/server/runtime-handle"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"

test("resident full runtime starts its product services and drains them before releasing the Home", async () => {
  const listeners = GlobalBus.listenerCount("event")
  const runtime = await ProductRuntimeHandle.open({ mode: "server", network: { hostname: "127.0.0.1", port: 0 } })
  try {
    expect((await ServerProcessLock.read())?.mode).toBe("server")
    expect(ScopeStartup.resident()).toBe(true)
    const health = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
    expect(await health.json()).toMatchObject({ healthy: true })
    await Promise.all([runtime.close(), runtime.close()])
    expect(await ServerProcessLock.read()).toBeUndefined()
    expect(GlobalBus.listenerCount("event")).toBeLessThanOrEqual(listeners)
  } finally {
    await runtime.close()
  }
}, 30_000)
