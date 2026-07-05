import { Config } from "@/config/config"

export namespace TimeoutConfig {
  export interface Resolved {
    invokeMs: number
    providerTtfbMs: number
    providerIdleMs: number | false
    providerWallMs: number | false
    toolDefaultMs: number
    toolOverrides: Record<string, number>
    permissionAskMs: number
  }

  const DEFAULTS: Resolved = {
    invokeMs: 21_600_000,
    providerTtfbMs: 3_600_000,
    providerIdleMs: 900_000,
    providerWallMs: 0,
    toolDefaultMs: 7_200_000,
    toolOverrides: {},
    permissionAskMs: 3_600_000,
  }

  let cached: Resolved | undefined

  export async function resolve(): Promise<Resolved> {
    if (cached) return cached

    const cfg = await Config.current()
    const timeout = (cfg as any).timeout as
      | {
          invoke_sec?: number
          provider?: { ttfb_sec?: number; idle_sec?: number | false; wall_sec?: number | false }
          tool?: { default_sec?: number; overrides?: Record<string, number> }
          permission?: { ask_sec?: number }
        }
      | undefined

    const secToMs = (sec: number | undefined, fallback: number): number => (sec !== undefined ? sec * 1000 : fallback)

    const providerIdleRaw = timeout?.provider?.idle_sec
    const providerIdleMs =
      providerIdleRaw === false || providerIdleRaw === 0
        ? (false as const)
        : providerIdleRaw !== undefined
          ? providerIdleRaw * 1000
          : DEFAULTS.providerIdleMs

    const providerWallRaw = timeout?.provider?.wall_sec
    const providerWallMs =
      providerWallRaw === false
        ? (false as const)
        : providerWallRaw !== undefined && providerWallRaw > 0
          ? providerWallRaw * 1000
          : DEFAULTS.providerWallMs

    cached = {
      invokeMs: secToMs(timeout?.invoke_sec, DEFAULTS.invokeMs),
      providerTtfbMs: secToMs(timeout?.provider?.ttfb_sec, DEFAULTS.providerTtfbMs),
      providerIdleMs,
      providerWallMs,
      toolDefaultMs: secToMs(timeout?.tool?.default_sec, DEFAULTS.toolDefaultMs),
      toolOverrides: timeout?.tool?.overrides
        ? Object.fromEntries(Object.entries(timeout.tool.overrides).map(([k, v]) => [k, v * 1000]))
        : DEFAULTS.toolOverrides,
      permissionAskMs: secToMs(timeout?.permission?.ask_sec, DEFAULTS.permissionAskMs),
    }

    return cached
  }

  export function invalidate(): void {
    cached = undefined
  }
}
