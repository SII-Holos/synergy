import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { TimeoutConfig } from "../../src/util/timeout-config"

const originalConfigCurrent = Config.current

afterEach(() => {
  ;(Config.current as any) = originalConfigCurrent
  TimeoutConfig.invalidate()
})

describe("TimeoutConfig", () => {
  test("uses long-run friendly defaults", async () => {
    ;(Config.current as any) = mock(async () => ({}))

    await expect(TimeoutConfig.resolve()).resolves.toMatchObject({
      invokeMs: 21_600_000,
      providerTtfbMs: 3_600_000,
      providerIdleMs: 900_000,
      providerWallMs: 0,
      toolDefaultMs: 7_200_000,
      toolOverrides: {},
      permissionAskMs: 3_600_000,
    })
  })

  test("resolves explicit timeout overrides", async () => {
    ;(Config.current as any) = mock(async () => ({
      timeout: {
        invoke_sec: 60,
        provider: { ttfb_sec: 30, idle_sec: 12, wall_sec: 90 },
        tool: { default_sec: 45, overrides: { bash: 120 } },
        permission: { ask_sec: 75 },
      },
    }))

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
    ;(Config.current as any) = mock(async () => ({ timeout: { provider: { idle_sec: 0 } } }))
    expect((await TimeoutConfig.resolve()).providerIdleMs).toBe(false)

    TimeoutConfig.invalidate()
    ;(Config.current as any) = mock(async () => ({ timeout: { provider: { idle_sec: false } } }))
    expect((await TimeoutConfig.resolve()).providerIdleMs).toBe(false)
  })
})
