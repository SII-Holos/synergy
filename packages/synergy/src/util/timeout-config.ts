import { Config } from "@/config/config"

export namespace TimeoutConfig {
  export interface Resolved {
    invokeMs: number
    providerIdleMs: number | false
    providerWallMs: number
    toolDefaultMs: number
    toolOverrides: Record<string, number>
  }

  const DEFAULTS: Resolved = {
    invokeMs: 900_000,
    providerIdleMs: 180_000,
    providerWallMs: 900_000,
    toolDefaultMs: 300_000,
    toolOverrides: {},
  }

  let cached: Resolved | undefined

  export async function resolve(): Promise<Resolved> {
    if (cached) return cached

    const cfg = await Config.get()
    const timeout = (cfg as any).timeout as
      | {
          invoke_sec?: number
          provider?: { idle_sec?: number | false; wall_sec?: number }
          tool?: { default_sec?: number; overrides?: Record<string, number> }
        }
      | undefined

    const secToMs = (sec: number | undefined, fallback: number): number => (sec !== undefined ? sec * 1000 : fallback)

    const providerIdleRaw = timeout?.provider?.idle_sec
    const providerIdleMs =
      providerIdleRaw === false
        ? (false as const)
        : providerIdleRaw !== undefined
          ? providerIdleRaw * 1000
          : DEFAULTS.providerIdleMs

    cached = {
      invokeMs: secToMs(timeout?.invoke_sec, DEFAULTS.invokeMs),
      providerIdleMs,
      providerWallMs: secToMs(timeout?.provider?.wall_sec, DEFAULTS.providerWallMs),
      toolDefaultMs: secToMs(timeout?.tool?.default_sec, DEFAULTS.toolDefaultMs),
      toolOverrides: timeout?.tool?.overrides
        ? Object.fromEntries(Object.entries(timeout.tool.overrides).map(([k, v]) => [k, v * 1000]))
        : DEFAULTS.toolOverrides,
    }

    return cached
  }

  export function invalidate(): void {
    cached = undefined
  }
}
