import { describe, expect, test } from "bun:test"
import { DaemonHealth } from "../../src/daemon/health"

describe("daemon.health", () => {
  test("waitForPortToStop resolves true when port is already free", async () => {
    const result = await DaemonHealth.waitForPortToStop(65530, "127.0.0.1", 100, 10)
    expect(result).toBe(true)
  })

  test("waitForHealthy returns false for unreachable server", async () => {
    const result = await DaemonHealth.waitForHealthy("http://127.0.0.1:65530", 100, 10)
    expect(result).toBe(false)
  })
})
