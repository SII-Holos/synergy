import { Config } from "../config/config"

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

  export interface ProviderTimeouts {
    providerTtfbMs: number
    providerIdleMs: number | false
    providerWallMs: number | false
  }

  const DEFAULTS: Resolved = {
    invokeMs: 21_600_000,
    providerTtfbMs: 15_000,
    providerIdleMs: 120_000,
    providerWallMs: 1_800_000,
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

  /**
   * Resolve the provider request timeouts for one provider, layering
   * `provider.<id>.timeout` over the legacy `provider.<id>.options.timeout`
   * (milliseconds, idle only) over the global `timeout.provider` block.
   *
   * This is the only place per-provider timeouts are parsed: the control plane
   * ships the result to the agent worker through the worker plan, so both sides
   * observe identical values.
   */
  export async function forProvider(input: { providerID: string; legacyIdle?: unknown }): Promise<ProviderTimeouts> {
    const resolved = await resolve()
    const cfg = await Config.current()
    const override = (cfg as any).provider?.[input.providerID]?.timeout as
      | { ttfb_sec?: number; idle_sec?: number | false; wall_sec?: number | false }
      | undefined

    const idleOverride =
      override?.idle_sec === false || override?.idle_sec === 0
        ? (false as const)
        : override?.idle_sec !== undefined
          ? override.idle_sec * 1000
          : undefined

    const legacyIdle =
      input.legacyIdle === false
        ? (false as const)
        : typeof input.legacyIdle === "number"
          ? input.legacyIdle
          : undefined

    const wallOverride =
      override?.wall_sec === false
        ? (false as const)
        : override?.wall_sec !== undefined && override.wall_sec > 0
          ? override.wall_sec * 1000
          : undefined

    return {
      providerTtfbMs: override?.ttfb_sec !== undefined ? override.ttfb_sec * 1000 : resolved.providerTtfbMs,
      providerIdleMs: idleOverride ?? legacyIdle ?? resolved.providerIdleMs,
      providerWallMs: wallOverride ?? resolved.providerWallMs,
    }
  }
}
