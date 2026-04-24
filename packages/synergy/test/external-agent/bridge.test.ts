import { expect, test } from "bun:test"
import { ExternalAgent } from "../../src/external-agent/bridge"

class TestAdapter implements ExternalAgent.Adapter {
  readonly name = "test-adapter"
  readonly started = false
  readonly capabilities: ExternalAgent.Capabilities = {
    modelSwitch: false,
    interrupt: false,
  }

  async discover() {
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
