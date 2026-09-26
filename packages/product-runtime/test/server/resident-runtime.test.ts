import { expect, test } from "bun:test"
import { ProductRuntimeHandle } from "../../src/server/runtime-handle"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test("resident full runtime starts its product services and drains them before releasing the Home", async () => {
  await using fixture = await runtimeHome()
  await using runtime = await ProductRuntimeHandle.open({
    host: fixture.host,
    mode: "server",
    network: { hostname: "127.0.0.1", port: 0 },
  })
  const events = runtime.run(() => GlobalBus())
  expect((await runtime.run(() => ServerProcessLock.read()))?.mode).toBe("server")
  expect(runtime.run(() => ScopeStartup.resident())).toBe(true)
  const health = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
  expect(await health.json()).toMatchObject({ healthy: true })
  await Promise.all([runtime.close(), runtime.close()])
  expect(await RuntimeContext.create(fixture.host).run(() => ServerProcessLock.read())).toBeUndefined()
  expect(events.listenerCount("event")).toBe(0)
}, 30_000)
