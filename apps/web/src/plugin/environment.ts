import { useGlobalSync } from "@/context/global-sync"
import type { PluginSessionCollection } from "@ericsanchezok/synergy-plugin"
import { createSignal, onCleanup, type Accessor } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import type { PluginUIEnvironment, PluginUINavigation, PluginRoute } from "@ericsanchezok/synergy-plugin"
import { useTheme } from "@ericsanchezok/synergy-ui/theme/context"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useLocale } from "@/context/locale"
import { usePlatform } from "@/context/platform"
import { getNavigationByPath } from "./registries/navigation-registry"
import { useWorkbenchPanels } from "@/context/workbench"
import { createWorkbenchService } from "./workbench-service"
import { createPluginResourceService } from "./resource-service"

export function createPluginEnvironment(scopeKey: Accessor<string>) {
  const workbench = createWorkbenchService(useWorkbenchPanels())
  const resources = createPluginResourceService()
  const sync = useGlobalSync()
  const state = () => sync.ensureScopeState(scopeKey())[0]
  const sessions: PluginSessionCollection = {
    list: () => state().session,
    get: (id) => state().session.find((session) => session.id === id),
    total: () => state().sessionTotal,
    ready: () => state().status === "complete",
    refresh: () => sync.scope.loadSessions(scopeKey()),
  }
  const location = useLocation()
  const params = useParams()
  const navigate = useNavigate()
  const platform = usePlatform()
  const locale = useLocale()
  const theme = useTheme()
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight })
  const visibility = () => setVisible(document.visibilityState !== "hidden")
  const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
  document.addEventListener("visibilitychange", visibility)
  window.addEventListener("resize", resize)
  onCleanup(() => {
    document.removeEventListener("visibilitychange", visibility)
    window.removeEventListener("resize", resize)
  })
  const environment: PluginUIEnvironment = {
    route(): PluginRoute {
      if (params.pluginId)
        return params.navigationId
          ? { page: "plugin-page", pluginId: params.pluginId, navigationId: params.navigationId }
          : { page: "plugin-detail", pluginId: params.pluginId }
      const id = getNavigationByPath(location.pathname)?.navigationId
      if (id === "agenda" || id === "kanban" || id === "library" || id === "performance" || id === "plugins")
        return { page: id }
      return { page: "session", sessionId: params.id }
    },
    scopeKey,
    platform: () => platform.platform,
    locale: locale.controller.activeLocale,
    theme: () => ({ id: theme.themeId(), mode: theme.mode() }),
    visible,
    viewport,
  }
  const navigation: PluginUINavigation = {
    open(route, options) {
      if (route.page === "session") {
        navigate(
          `/${base64Encode(scopeKey())}/session${route.sessionId ? `/${encodeURIComponent(route.sessionId)}` : ""}`,
          options,
        )
        return
      }
      if (route.page === "plugin-page") {
        navigate(
          `/plugins/${encodeURIComponent(route.pluginId)}/${encodeURIComponent(route.navigationId)}?_scope=${encodeURIComponent(base64Encode(scopeKey()))}`,
          options,
        )
        return
      }
      if (route.page === "plugin-detail") {
        navigate(`/plugins/${encodeURIComponent(route.pluginId)}`, options)
        return
      }
      navigate(route.page === "plugins" ? "/plugins/marketplace" : `/${route.page}`, options)
    },
  }
  return {
    environment,
    workbench,
    resources,
    sessions,
    navigation,
    navigate,
    sessionId: () => {
      const route = environment.route()
      return route.page === "session" ? route.sessionId : undefined
    },
  }
}
