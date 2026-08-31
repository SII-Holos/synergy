import { createEffect, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { replacePluginThemes } from "@ericsanchezok/synergy-ui/theme"
import { useServer } from "@/context/server"
import { fetchGlobalThemeContributions } from "./api"
import { loadPluginUIAssets } from "./ui-assets"
import { usePluginHost } from "./host"
import { createGlobalThemeRegistrar } from "./global-theme-registrar"

/**
 * Mounts the global plugin-theme registration for the whole router tree: it
 * survives Scope/session switches (the registrar refetches when the scope or
 * the plugin host's contribution list changes) and is the only caller of
 * replacePluginThemes in the app.
 */
export function GlobalPluginThemesRegistrar() {
  const server = useServer()
  const host = usePluginHost()
  const params = useParams()
  const registrar = createGlobalThemeRegistrar({
    serverUrl: () => server.url,
    fetchContributions: fetchGlobalThemeContributions,
    loadAssets: (contributions, serverUrl) => loadPluginUIAssets(contributions, { serverUrl }),
    replaceThemes: (themes) => replacePluginThemes(themes),
    clearThemes: () => replacePluginThemes([], { ready: false }),
  })
  createEffect(() => {
    params.dir
    host.plugins()
    if (server.url) void registrar.refresh()
  })
  onCleanup(() => registrar.dispose())
  return null
}
