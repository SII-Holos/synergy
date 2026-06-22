import { createContext, createSignal, useContext, onMount, createEffect, batch, type ParentProps } from "solid-js"
import { fetchUIContributions } from "./api"
import { discoverAndActivate, deactivatePlugin, type PluginInstance, type PluginLifecycleState } from "./lifecycle"
import type { PluginContribution } from "./contributions-fetcher"
import { useServer } from "@/context/server"
import { toolRendererRegistry } from "./registries/tool-registry"
import { loadPluginExport } from "./loaders"
import type { ToolRenderer } from "./registries/tool-registry"
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

  const [plugins, setPlugins] = createSignal<PluginContribution[]>([])
  const [statusMap, setStatusMap] = createSignal<Map<string, PluginUIStatus>>(new Map())
  const [errors, setErrors] = createSignal<PluginUIError[]>([])

  async function reload() {
    const url = server.url
    if (!url) return

    try {
      const contributions = await fetchUIContributions(url)
      batch(() => {
        setPlugins(contributions)
        const map = new Map<string, PluginUIStatus>()
        for (const c of contributions) {
          map.set(c.pluginId, "active")
        }
        setStatusMap(map)
        setErrors([])
      })

      // Register tool renderers from plugin contributions into the ToolRendererRegistry.
      // Trusted (Tier 2) plugins get lazy-loaders; sandbox plugins get fallback metadata only.
      for (const contrib of contributions) {
        const ui = contrib.ui
        if (!ui?.toolRenderers) continue

        for (const tr of ui.toolRenderers) {
          const isTrusted = contrib.trustTier === "trusted"
          const toolId = tr.tool

          // Skip if already registered
          if (toolRendererRegistry.has(toolId)) continue

          if (isTrusted) {
            toolRendererRegistry.register(toolId, {
              loader: () =>
                loadPluginExport(contrib, tr.exportName ?? "default").then((c) => ({
                  default: c as ToolRenderer,
                })),
              fallback: tr.fallback,
            })
          } else {
            // Sandbox plugin — register fallback metadata only
            toolRendererRegistry.register(toolId, {
              fallback: tr.fallback,
            })
          }
        }
      }
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
