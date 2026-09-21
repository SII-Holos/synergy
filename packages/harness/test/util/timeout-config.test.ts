import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { TimeoutConfig } from "../../src/util/timeout-config"

const originalConfigCurrent = Config.current

function installConfig(config: unknown) {
  ;(Config.current as any) = mock(async () => config)
  TimeoutConfig.invalidate()
}

afterEach(() => {
  ;(Config.current as any) = originalConfigCurrent
  TimeoutConfig.invalidate()
})

describe("TimeoutConfig", () => {
  test("uses long-run friendly step, tool, and permission defaults with bounded provider watchdogs", async () => {
    installConfig({})

    await expect(TimeoutConfig.resolve()).resolves.toMatchObject({
      invokeMs: 21_600_000,
      providerTtfbMs: 15_000,
      providerIdleMs: 120_000,
      providerWallMs: 1_800_000,
      toolDefaultMs: 7_200_000,
      toolOverrides: {},
      permissionAskMs: 3_600_000,
    })
  })

  test("resolves explicit timeout overrides", async () => {
    installConfig({
      timeout: {
        invoke_sec: 60,
        provider: { ttfb_sec: 30, idle_sec: 12, wall_sec: 90 },
        tool: { default_sec: 45, overrides: { bash: 120 } },
        permission: { ask_sec: 75 },
      },
    })

    await expect(TimeoutConfig.resolve()).resolves.toMatchObject({
      invokeMs: 60_000,
      providerTtfbMs: 30_000,
      providerIdleMs: 12_000,
      providerWallMs: 90_000,
      toolDefaultMs: 45_000,
      toolOverrides: { bash: 120_000 },
      permissionAskMs: 75_000,
    })
  })

  test("disables provider idle timeout with 0 or false", async () => {
    installConfig({ timeout: { provider: { idle_sec: 0 } } })
    expect((await TimeoutConfig.resolve()).providerIdleMs).toBe(false)

    installConfig({ timeout: { provider: { idle_sec: false } } })
    expect((await TimeoutConfig.resolve()).providerIdleMs).toBe(false)
  })

  test("disables provider wall timeout with false while keeping the default enabled", async () => {
    installConfig({ timeout: { provider: { wall_sec: false } } })
    expect((await TimeoutConfig.resolve()).providerWallMs).toBe(false)

    installConfig({ timeout: { provider: { wall_sec: 0 } } })
    expect((await TimeoutConfig.resolve()).providerWallMs).toBe(1_800_000)
  })
})

describe("TimeoutConfig.forProvider", () => {
  test("inherits the global provider timeouts when the provider configures nothing", async () => {
    installConfig({})

    await expect(TimeoutConfig.forProvider({ providerID: "boyue" })).resolves.toEqual({
      providerTtfbMs: 15_000,
      providerIdleMs: 120_000,
      providerWallMs: 1_800_000,
    })
  })

  test("applies provider-level seconds over the global block", async () => {
    installConfig({
      timeout: { provider: { ttfb_sec: 30, idle_sec: 60, wall_sec: 120 } },
      provider: { "o1-pro": { timeout: { ttfb_sec: 900, idle_sec: 600, wall_sec: 3600 } } },
    })

    await expect(TimeoutConfig.forProvider({ providerID: "o1-pro" })).resolves.toEqual({
      providerTtfbMs: 900_000,
      providerIdleMs: 600_000,
      providerWallMs: 3_600_000,
    })
    // A provider without its own block still inherits the global values.
    await expect(TimeoutConfig.forProvider({ providerID: "boyue" })).resolves.toEqual({
      providerTtfbMs: 30_000,
      providerIdleMs: 60_000,
      providerWallMs: 120_000,
    })
  })

  test("keeps the legacy options.timeout idle shorthand working beneath provider.timeout", async () => {
    installConfig({ provider: { boyue: { options: { timeout: 450_000 } } } })

    await expect(TimeoutConfig.forProvider({ providerID: "boyue", legacyIdle: 450_000 })).resolves.toMatchObject({
      providerIdleMs: 450_000,
      providerTtfbMs: 15_000,
    })
  })

  test("provider.timeout.idle_sec beats the legacy options.timeout shorthand", async () => {
    installConfig({ provider: { boyue: { timeout: { idle_sec: 30 } } } })

    await expect(TimeoutConfig.forProvider({ providerID: "boyue", legacyIdle: 450_000 })).resolves.toMatchObject({
      providerIdleMs: 30_000,
    })
  })

  test("treats false and 0 as disabling idle for both override layers", async () => {
    installConfig({})
    await expect(TimeoutConfig.forProvider({ providerID: "boyue", legacyIdle: false })).resolves.toMatchObject({
      providerIdleMs: false,
    })

    installConfig({ provider: { boyue: { timeout: { idle_sec: false } } } })
    await expect(TimeoutConfig.forProvider({ providerID: "boyue" })).resolves.toMatchObject({ providerIdleMs: false })

    installConfig({ provider: { boyue: { timeout: { idle_sec: 0 } } } })
    await expect(TimeoutConfig.forProvider({ providerID: "boyue" })).resolves.toMatchObject({ providerIdleMs: false })
  })

  test("ignores unrelated legacy options values", async () => {
    installConfig({ provider: { boyue: { options: { timeout: "450000" } } } })

    await expect(TimeoutConfig.forProvider({ providerID: "boyue", legacyIdle: "450000" })).resolves.toMatchObject({
      providerIdleMs: 120_000,
    })
  })

  test("resolves identical values on repeated calls for the worker and control plane paths", async () => {
    installConfig({ provider: { boyue: { timeout: { ttfb_sec: 45, idle_sec: 90, wall_sec: 300 } } } })

    const controlPlane = await TimeoutConfig.forProvider({ providerID: "boyue" })
    const worker = await TimeoutConfig.forProvider({ providerID: "boyue" })

    expect(worker).toEqual(controlPlane)
  })
})
