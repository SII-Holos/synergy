import type { PluginThemeDefinition } from "@ericsanchezok/synergy-ui/theme"
import type { PluginContribution } from "./api"
import type { PluginUIAssets } from "./ui-assets"

const GLOBAL_THEME_RETRY_DELAY_MS = 2000

export interface GlobalThemeRegistrarDeps {
  serverUrl: () => string | undefined
  fetchContributions: (serverUrl: string) => Promise<PluginContribution[]>
  loadAssets: (contributions: PluginContribution[], serverUrl: string) => Promise<PluginUIAssets>
  replaceThemes: (themes: Iterable<PluginThemeDefinition>) => void
  retryDelayMs?: number
}

export interface GlobalThemeRegistrar {
  refresh: () => Promise<void>
  dispose: () => void
}

/**
 * Themes are a global user preference, so plugin theme registration must not
 * follow the Scope-scoped plugin-host reload cycle. The registrar pulls the
 * cross-scope aggregate, parses theme assets, and atomically publishes one
 * registry generation; concurrent refreshes are generation-guarded and a
 * failed fetch retries once, keeping the last published generation otherwise.
 */
export function createGlobalThemeRegistrar(deps: GlobalThemeRegistrarDeps): GlobalThemeRegistrar {
  const retryDelayMs = deps.retryDelayMs ?? GLOBAL_THEME_RETRY_DELAY_MS
  let generation = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  async function refresh(isRetry = false): Promise<void> {
    const serverUrl = deps.serverUrl()
    if (!serverUrl) return
    const current = ++generation
    clearRetry()
    try {
      const contributions = await deps.fetchContributions(serverUrl)
      const assets = await deps.loadAssets(contributions, serverUrl)
      if (current !== generation) return
      deps.replaceThemes(assets.themes.values())
    } catch {
      if (current !== generation) return
      if (!isRetry) retryTimer = setTimeout(() => void refresh(true), retryDelayMs)
    }
  }

  return {
    refresh,
    dispose() {
      generation++
      clearRetry()
    },
  }
}
