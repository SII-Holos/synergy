import type { PluginUILifetime } from "@ericsanchezok/synergy-plugin"

export function createPluginSurfaceAccess(input: {
  lifetime: PluginUILifetime
  capabilities: readonly string[]
  current(): boolean
}) {
  function require(capability: string) {
    input.lifetime.signal.throwIfAborted()
    if (!input.current()) throw new DOMException("Plugin surface identity changed", "AbortError")
    if (!input.capabilities.includes(capability)) throw new Error(`Plugin is not approved for ${capability}`)
  }
  return {
    require,
    own(capability: string, acquire: () => () => void) {
      require(capability)
      return input.lifetime.onDispose(acquire())
    },
    async run<T>(capability: string, call: () => T | Promise<T>): Promise<T> {
      require(capability)
      const result = await call()
      require(capability)
      return result
    },
  }
}
