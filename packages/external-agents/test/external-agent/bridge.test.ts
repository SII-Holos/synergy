import { expect, test } from "bun:test"
import { ExternalAgent } from "../../src/bridge"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

class TestAdapter implements ExternalAgent.Adapter {
  readonly name = "test-adapter"
  readonly started = false
  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: false,
    interrupt: false,
  }

  // Accept config in discover signature per updated Adapter interface, but
  // ignore it — adapters that don't consume config are still valid.
  async discover(_config?: Record<string, unknown>) {
    return { available: true }
  }

  async start() {}

  async *turn(): AsyncGenerator<ExternalAgent.BridgeEvent> {
    yield { type: "turn_complete" }
  }

  async interrupt() {}

  async shutdown() {}
}

test("getAdapter returns distinct instances per sessionID", () =>
  runtime.run(() => {
    const name = `test-${Date.now()}`
    ExternalAgent.register(name, () => new TestAdapter())

    const first = ExternalAgent.getAdapter(name, "ses_a")
    const second = ExternalAgent.getAdapter(name, "ses_b")
    const again = ExternalAgent.getAdapter(name, "ses_a")

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    expect(first).toBe(again)
  }))

test("getAdapter without sessionID preserves default singleton behavior", () =>
  runtime.run(() => {
    const name = `test-default-${Date.now()}`
    ExternalAgent.register(name, () => new TestAdapter())

    const first = ExternalAgent.getAdapter(name)
    const second = ExternalAgent.getAdapter(name)

    expect(first).toBeDefined()
    expect(first).toBe(second)
  }))

test("discover forwards per-adapter config from discovery helper", () =>
  runtime.run(async () => {
    let receivedConfig: Record<string, unknown> | undefined
    class DiscoverAdapter implements ExternalAgent.Adapter {
      readonly name = "test-discover"
      readonly started = false
      readonly capabilities: ExternalAgent.Capabilities = {
        modelSwitch: false,
        interrupt: false,
      }

      async discover(config?: Record<string, unknown>) {
        receivedConfig = config
        return { available: true, path: "/usr/bin/test" }
      }

      async start() {}
      async *turn(): AsyncGenerator<ExternalAgent.BridgeEvent> {
        yield { type: "turn_complete" }
      }
      async interrupt() {}
      async shutdown() {}
    }

    const name = `test-discover-${Date.now()}`
    ExternalAgent.register(name, () => new DiscoverAdapter())

    const cfg = {
      [name]: { path: "/custom/path", model: "gpt-5.5", nativeAuth: true },
    }
    const { ExternalAgentDiscovery } = await import("../../src/discovery")
    const results = await ExternalAgentDiscovery.discover(cfg)

    expect(receivedConfig).toEqual({ path: "/custom/path", model: "gpt-5.5", nativeAuth: true })
    expect(results.has(name)).toBe(true)
    expect(results.get(name)?.path).toBe("/usr/bin/test")
  }))

test("adapter that does not consume config still satisfies discovery contract", () =>
  runtime.run(async () => {
    let callCount = 0
    class NoConfigAdapter implements ExternalAgent.Adapter {
      readonly name = "test-no-config"
      readonly started = false
      readonly capabilities: ExternalAgent.Capabilities = {
        modelSwitch: false,
        interrupt: false,
      }

      // discover() ignores the config parameter — this mirrors the behavior of
      // claude-code / openclaw adapters that use Bun.which() without a config path.
      async discover(_?: Record<string, unknown>) {
        callCount++
        return { available: true, path: Bun.which("node") ?? undefined, version: "1.0" }
      }

      async start() {}
      async *turn(): AsyncGenerator<ExternalAgent.BridgeEvent> {
        yield { type: "turn_complete" }
      }
      async interrupt() {}
      async shutdown() {}
    }

    const name = `test-no-config-${Date.now()}`
    ExternalAgent.register(name, () => new NoConfigAdapter())

    const { ExternalAgentDiscovery } = await import("../../src/discovery")
    const results = await ExternalAgentDiscovery.discover({ [name]: undefined })

    // The adapter received the call and did not crash, even though its discover
    // signature accepts config but ignores it. This is the contract guarantee for
    // claude-code and openclaw adapters that have not yet adopted config-driven
    // discovery.
    expect(callCount).toBe(1)
    expect(results.has(name)).toBe(true)
  }))

test("single-adapter discovery preserves identity and isolates unavailable or failing adapters", () =>
  runtime.run(async () => {
    const { ExternalAgentDiscovery } = await import("../../src/discovery")
    expect(await ExternalAgentDiscovery.discoverOne("unregistered-fixture")).toBeUndefined()
    for (const outcome of ["available", "missing", "failure"] as const) {
      const name = `single-${outcome}`
      class FixtureAdapter extends TestAdapter {
        override async discover(config?: Record<string, unknown>) {
          expect(config).toEqual({ path: "fixture-executable" })
          if (outcome === "failure") throw new Error("Executable discovery failed")
          return { available: outcome === "available", path: "fixture-executable", version: "fixture-1" }
        }
      }
      ExternalAgent.register(name, () => new FixtureAdapter())
      const result = await ExternalAgentDiscovery.discoverOne(name, { path: "fixture-executable" })
      expect(result).toEqual(
        outcome === "available" ? { adapter: name, path: "fixture-executable", version: "fixture-1" } : undefined,
      )
    }
  }))

afterRuntimeTests(() => runtime.close())
