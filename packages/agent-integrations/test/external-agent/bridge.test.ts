import { expect, test } from "bun:test"
import { ExternalAgent } from "../../src/external-agent/bridge"

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

test("getAdapter returns distinct instances per sessionID", () => {
  const name = `test-${Date.now()}`
  ExternalAgent.register(name, () => new TestAdapter())

  const first = ExternalAgent.getAdapter(name, "ses_a")
  const second = ExternalAgent.getAdapter(name, "ses_b")
  const again = ExternalAgent.getAdapter(name, "ses_a")

  expect(first).toBeDefined()
  expect(second).toBeDefined()
  expect(first).not.toBe(second)
  expect(first).toBe(again)
})

test("getAdapter without sessionID preserves default singleton behavior", () => {
  const name = `test-default-${Date.now()}`
  ExternalAgent.register(name, () => new TestAdapter())

  const first = ExternalAgent.getAdapter(name)
  const second = ExternalAgent.getAdapter(name)

  expect(first).toBeDefined()
  expect(first).toBe(second)
})

test("discover forwards per-adapter config from discovery helper", async () => {
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
  const { ExternalAgentDiscovery } = await import("../../src/external-agent/discovery")
  const results = await ExternalAgentDiscovery.discover(cfg)

  expect(receivedConfig).toEqual({ path: "/custom/path", model: "gpt-5.5", nativeAuth: true })
  expect(results.has(name)).toBe(true)
  expect(results.get(name)?.path).toBe("/usr/bin/test")
})

test("adapter that does not consume config still satisfies discovery contract", async () => {
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

  const { ExternalAgentDiscovery } = await import("../../src/external-agent/discovery")
  const results = await ExternalAgentDiscovery.discover({ [name]: undefined })

  // The adapter received the call and did not crash, even though its discover
  // signature accepts config but ignores it. This is the contract guarantee for
  // claude-code and openclaw adapters that have not yet adopted config-driven
  // discovery.
  expect(callCount).toBe(1)
  expect(results.has(name)).toBe(true)
})
