import { expect, test } from "bun:test"
import { openAgentRuntime, type RuntimeComponent } from "../src"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { version } from "../package.json" with { type: "json" }

test("server started hooks run after every resident is ready and stay absent in one-shot runtimes", async () => {
  await using fixture = await runtimeHome()
  const events: string[] = []
  const component = (id: string): RuntimeComponent => ({
    id,
    version,
    apiVersion: 1,
    register() {},
    services: () => ({
      async started() {
        events.push(`${id}:started`)
      },
      resident: {
        async start() {
          events.push(`${id}:start`)
        },
        async ready() {
          events.push(`${id}:ready`)
        },
        async stop() {},
      },
    }),
  })
  const components = [component("b"), component("a")]
  await using first = await openAgentRuntime({ home: fixture.host.root, host: fixture.host, components })
  expect(events).toEqual([])
  await first.close()
  await using second = await openAgentRuntime({
    home: fixture.host.root,
    host: fixture.host,
    components,
    mode: "server",
  })
  expect(events).toEqual(["a:start", "b:start", "a:ready", "b:ready", "a:started", "b:started"])
}, 30_000)

test("failed resident readiness drains every started component and releases the home for a fresh runtime", async () => {
  await using fixture = await runtimeHome()
  const events: string[] = []
  const component = (id: string): RuntimeComponent => ({
    id,
    version,
    apiVersion: 1,
    requires: { "local-runtime": version },
    register() {},
    services: () => ({
      resident: {
        async start() {
          events.push(`${id}:start`)
        },
        async ready() {
          events.push(`${id}:ready`)
          if (id === "b") throw new Error("resident readiness failed")
        },
        async stop() {
          events.push(`${id}:stop`)
          if (id === "b") throw new Error("resident cleanup failed")
        },
      },
    }),
  })
  await expect(
    openAgentRuntime({
      home: fixture.host.root,
      host: fixture.host,
      mode: "server",
      components: [component("b"), component("a")],
    }),
  ).rejects.toThrow("Synergy runtime startup failed")
  expect(events).toEqual(["a:start", "b:start", "a:ready", "b:ready", "b:stop", "a:stop"])
  await using reopened = await openAgentRuntime({ home: fixture.host.root, host: fixture.host })
  expect(reopened.status).toBe("ready")
}, 30_000)
