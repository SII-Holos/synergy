import {
  createContext,
  createSignal,
  useContext,
  onMount,
  createEffect,
  batch,
  type ParentProps,
  type Component,
} from "solid-js"
import { fetchUIContributions } from "./api"
import type { PluginContribution } from "./api"
import type { PluginLifecycleState } from "./lifecycle"
import { PluginToolId } from "@ericsanchezok/synergy-plugin/ids"
import { useServer } from "@/context/server"
import { toolRendererRegistry, type ToolRenderer } from "./registries/tool-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerWorkspacePanel } from "./registries/workspace-registry"
import { registerGlobalPanel } from "./registries/panel-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { registerChatComponent } from "./registries/chat-registry"
import { registerTheme } from "./registries/theme-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerPluginRoute } from "./registries/route-registry"
import { registerPluginCommand } from "./registries/command-registry"
import { loadPluginExport } from "./loaders"
// ── Types ────────────────────────────────────────────────────────────────────

export type PluginUIStatus = PluginLifecycleState

export interface PluginUIError {
  pluginId: string
  message: string
  timestamp: number
}

// ── Context ──────────────────────────────────────────────────────────────────

interface PluginHostValue {
  plugins: () => PluginContribution[]
  status: () => Map<string, PluginUIStatus>
  loadedPluginIds: () => string[]
  errors: () => PluginUIError[]
  reload: () => Promise<void>
}

const PluginHostContext = createContext<PluginHostValue>()

// ── Provider ─────────────────────────────────────────────────────────────────

export function PluginHostProvider(props: ParentProps) {
  const server = useServer()

  const pluginDisposers = new Map<string, Array<() => void>>()

  const [plugins, setPlugins] = createSignal<PluginContribution[]>([])
  const [statusMap, setStatusMap] = createSignal<Map<string, PluginUIStatus>>(new Map())
  const [errors, setErrors] = createSignal<PluginUIError[]>([])

  /**
   * Register UI contributions (tool renderers, panels, settings, chat components)
   * from active plugin contributions. Trusted (Tier 2) plugins get lazy-loaders;
   * sandbox plugins get sandbox metadata only.
   */
  function activateContributions(contributions: PluginContribution[]) {
    const assetUrl = (contrib: PluginContribution, filePath: string) =>
      `/plugin/assets/${contrib.pluginId}/${contrib.version}/${filePath.replace(/^\.\//, "")}`
    const pluginToolId = (pluginId: string, toolId: string) =>
      PluginToolId.is(toolId) ? toolId : PluginToolId.format(pluginId, toolId)

    for (const contrib of contributions) {
      const ui = contrib.ui
      if (!ui) continue
      const isTrusted = contrib.trustTier === "trusted-import" || contrib.trustTier === "declarative"
      const disposers: Array<() => void> = []

      // ── Tool renderers ──
      if (ui.toolRenderers) {
        for (const tr of ui.toolRenderers) {
          const toolId = pluginToolId(contrib.pluginId, tr.tool)
          if (toolRendererRegistry.has(toolId)) continue
          disposers.push(
            toolRendererRegistry.register(toolId, {
              loader:
                isTrusted && ui.entry
                  ? () => {
                      return loadPluginExport<ToolRenderer>(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        tr.exportName ?? "default",
                        ui.minUIApiVersion ?? "",
                      )
                    }
                  : undefined,
              fallback: tr.fallback,
            }),
          )
        }
      }

      // ── Part renderers ──
      if (ui.partRenderers) {
        for (const pr of ui.partRenderers) {
          disposers.push(
            registerPartRenderer(
              pr.type,
              undefined,
              isTrusted && ui.entry
                ? () => {
                    return loadPluginExport<Component>(
                      contrib.pluginId,
                      assetUrl(contrib, ui.entry!),
                      pr.exportName ?? "default",
                      ui.minUIApiVersion ?? "",
                    )
                  }
                : undefined,
            ),
          )
        }
      }

      // ── Workspace panels ──
      if (ui.workspacePanels) {
        for (const wp of ui.workspacePanels) {
          disposers.push(
            registerWorkspacePanel({
              id: `${contrib.pluginId}:${wp.id}`,
              label: wp.label,
              icon: wp.icon,
              loader:
                isTrusted && ui.entry
                  ? () => {
                      return loadPluginExport<Component>(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        wp.exportName ?? "default",
                        ui.minUIApiVersion ?? "",
                      )
                    }
                  : undefined,
              sandbox: wp.sandbox,
              sandboxUrl: wp.sandbox ? `/plugin/${contrib.pluginId}/sandbox/${wp.id}` : undefined,
              pluginId: contrib.pluginId,
              exportName: wp.exportName,
            }),
          )
        }
      }

      // ── Global panels ──
      if (ui.globalPanels) {
        for (const gp of ui.globalPanels) {
          disposers.push(
            registerGlobalPanel({
              id: `${contrib.pluginId}:${gp.id}`,
              label: gp.label,
              icon: gp.icon,
              loader:
                isTrusted && ui.entry
                  ? () => {
                      return loadPluginExport<Component>(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        gp.exportName ?? "default",
                        ui.minUIApiVersion ?? "",
                      )
                    }
                  : undefined,
              sandbox: gp.sandbox,
              sandboxUrl: gp.sandbox ? `/plugin/${contrib.pluginId}/sandbox/${gp.id}` : undefined,
              pluginId: contrib.pluginId,
              exportName: gp.exportName,
            }),
          )
        }
      }

      // ── Settings ──
      if (ui.settings) {
        for (const s of ui.settings) {
          disposers.push(
            registerSettingsSection({
              id: `${contrib.pluginId}:${s.id}`,
              label: s.label,
              icon: s.icon,
              group: s.group,
              loader:
                isTrusted && ui.entry
                  ? () => {
                      return loadPluginExport<Component>(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        s.exportName ?? "default",
                        ui.minUIApiVersion ?? "",
                      )
                    }
                  : undefined,
              sandbox: s.sandbox,
              sandboxUrl: s.sandbox ? `/plugin/${contrib.pluginId}/sandbox/${s.id}` : undefined,
              pluginId: contrib.pluginId,
              exportName: s.exportName,
            }),
          )
        }
      }

      // ── Chat components ──
      if (ui.chatComponents) {
        for (const cc of ui.chatComponents) {
          disposers.push(
            registerChatComponent({
              id: `${contrib.pluginId}:${cc.id}`,
              slot: cc.slot ?? "after-tools",
              component: undefined as any,
              loader:
                isTrusted && ui.entry
                  ? () => {
                      return loadPluginExport<Component>(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        cc.exportName ?? "default",
                        ui.minUIApiVersion ?? "",
                      )
                    }
                  : undefined,
              pluginId: contrib.pluginId,
            }),
          )
        }
      }

      // ── Themes ──
      if (ui.themes) {
        for (const theme of ui.themes) {
          disposers.push(
            registerTheme({
              id: `${contrib.pluginId}:${theme.id}`,
              label: theme.label,
              variables: {},
              cssUrl: assetUrl(contrib, theme.path),
              pluginId: contrib.pluginId,
            }),
          )
        }
      }

      // ── Icons ──
      if (ui.icons) {
        for (const icon of ui.icons) {
          let disposed = false
          let disposeIcon: (() => void) | undefined
          disposers.push(() => {
            disposed = true
            disposeIcon?.()
          })
          fetch(assetUrl(contrib, icon.path))
            .then((res) => (res.ok ? res.text() : ""))
            .then((svgContent) => {
              if (disposed || !svgContent) return
              disposeIcon = registerIcon({ name: icon.name, svgContent, pluginId: contrib.pluginId })
            })
            .catch(() => {})
        }
      }

      // ── Routes ──
      if (ui.routes) {
        for (const route of ui.routes) {
          disposers.push(
            registerPluginRoute({
              path: route.path,
              label: route.label,
              icon: route.icon,
              entry: assetUrl(contrib, route.entry),
              pluginId: contrib.pluginId,
            }),
          )
        }
      }

      // ── Commands ──
      if (ui.commands) {
        for (const command of ui.commands) {
          disposers.push(
            registerPluginCommand({
              id: `${contrib.pluginId}:${command.id}`,
              label: command.label,
              description: command.description,
              icon: command.icon,
              pluginId: contrib.pluginId,
              loader:
                isTrusted && ui.entry && command.exportName
                  ? () =>
                      loadPluginExport(
                        contrib.pluginId,
                        assetUrl(contrib, ui.entry!),
                        command.exportName!,
                        ui.minUIApiVersion ?? "",
                      )
                  : undefined,
            }),
          )
        }
      }

      pluginDisposers.set(contrib.pluginId, disposers)
    }
  }

  async function reload() {
    const url = server.url
    if (!url) return

    try {
      const contributions = await fetchUIContributions(url)

      // Dispose old registrations before re-activating
      for (const disposers of pluginDisposers.values()) {
        for (const dispose of disposers) {
          dispose()
        }
      }
      pluginDisposers.clear()

      batch(() => {
        setPlugins(contributions)
        const map = new Map<string, PluginUIStatus>()
        for (const c of contributions) {
          map.set(c.pluginId, "active")
        }
        setStatusMap(map)
        setErrors([])
      })

      activateContributions(contributions)
    } catch (err) {
      setErrors((prev) => [
        ...prev,
        {
          pluginId: "",
          message: `Failed to fetch contributions: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        },
      ])
    }
  }

  onMount(() => {
    reload()
  })

  // Re-fetch when server URL changes
  createEffect(() => {
    const url = server.url
    if (url) {
      reload()
    }
  })

  const value: PluginHostValue = {
    plugins,
    status: statusMap,
    loadedPluginIds: () => plugins().map((p) => p.pluginId),
    errors,
    reload,
  }

  return <PluginHostContext.Provider value={value}>{props.children}</PluginHostContext.Provider>
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function usePluginHost(): PluginHostValue {
  const ctx = useContext(PluginHostContext)
  if (!ctx) throw new Error("usePluginHost must be used within a PluginHostProvider")
  return ctx
}
