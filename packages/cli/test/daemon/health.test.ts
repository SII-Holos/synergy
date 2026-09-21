import { describe, expect, test } from "bun:test"
import { DaemonHealth } from "../../src/daemon/health"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("daemon.health", () => {
  test("waitForPortToStop resolves true when port is already free", () =>
    runtime.run(async () => {
      const result = await DaemonHealth.waitForPortToStop(65530, "127.0.0.1", 200, 10)
      expect(result).toBe(true)
    }))

  test("waitForHealthy returns false for unreachable server", () =>
    runtime.run(async () => {
      const result = await DaemonHealth.waitForHealthy("http://127.0.0.1:65530", 200, 10)
      expect(result).toBe(false)
    }))
})

afterRuntimeTests(() => runtime.close())
