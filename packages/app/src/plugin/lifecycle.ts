import { createSignal } from "solid-js"
import type { ToolRenderer } from "./registries/tool-registry"
import { fetchContributions, type PluginContribution } from "./contributions-fetcher"
import { loadPluginExport } from "./loaders"
import { registerToolRenderer, clearAllToolRenderers } from "./registries/tool-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerWorkspacePanel, clearWorkspacePanels } from "./registries/workspace-registry"
import { registerGlobalPanel, clearGlobalPanels } from "./registries/panel-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { registerTheme } from "./registries/theme-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerChatComponent } from "./registries/chat-registry"
import { registerPluginRoute } from "./registries/route-registry"

// ── Lifecycle State ─────────────────────────────────────────────────────────

export type PluginLifecycleState = "registered" | "activating" | "active" | "deactivated" | "disposed"

export interface PluginInstance {
  id: string
  contribution: PluginContribution
  state: PluginLifecycleState
  disposers: Array<() => void>
}

const [instances, setInstances] = createSignal<PluginInstance[]>([])

// ── Host Capability ─────────────────────────────────────────────────────────

/** Current UI API version reported to plugins via PluginUIContext. */
export const HOST_UI_API_VERSION = "2.0.0"

// ── Main Entry Point ────────────────────────────────────────────────────────

/** Discover all plugins from the server and activate their UI contributions. */
export async function discoverAndActivate(serverUrl: string): Promise<void> {
  const contributions = await fetchContributions(serverUrl)

  for (const contrib of contributions) {
    await activatePlugin(contrib)
  }
}

// ── Activate One Plugin ─────────────────────────────────────────────────────

async function activatePlugin(contrib: PluginContribution): Promise<void> {
  const disposers: Array<() => void> = []
  const ui = contrib.ui
  if (!ui) {
    setInstances((prev) => [...prev, { id: contrib.pluginId, contribution: contrib, state: "active", disposers: [] }])
    return
  }

  const isTrusted = contrib.trustTier === "trusted"

  // ── Tool renderers ──
  if (ui.toolRenderers) {
    for (const tr of ui.toolRenderers) {
      const dispose = registerToolRenderer({
        name: tr.tool,
        loader: isTrusted
          ? () =>
              loadPluginExport(contrib, tr.exportName ?? "default").then((c) => ({
                default: c as ToolRenderer,
              }))
          : undefined,
      })
      disposers.push(dispose)
    }
  }

  // ── Part renderers ──
  if (ui.partRenderers) {
    for (const pr of ui.partRenderers) {
      const dispose = registerPartRenderer(pr.type, undefined as any)
      disposers.push(dispose)
    }
  }

  // ── Workspace panels ──
  if (ui.workspacePanels) {
    for (const wp of ui.workspacePanels) {
      const dispose = registerWorkspacePanel({
        id: `${contrib.pluginId}:${wp.id}`,
        label: wp.label,
        icon: wp.icon,
        sandbox: wp.sandbox,
        sandboxUrl: wp.sandboxEntry,
        pluginId: contrib.pluginId,
        exportName: wp.exportName,
      })
      disposers.push(dispose)
    }
  }

  // ── Global panels ──
  if (ui.globalPanels) {
    for (const gp of ui.globalPanels) {
      const dispose = registerGlobalPanel({
        id: `${contrib.pluginId}:${gp.id}`,
        label: gp.label,
        icon: gp.icon,
        sandbox: gp.sandbox,
        sandboxUrl: gp.sandboxEntry,
        pluginId: contrib.pluginId,
        exportName: gp.exportName,
      })
      disposers.push(dispose)
    }
  }

  // ── Settings ──
  if (ui.settings) {
    for (const s of ui.settings) {
      const dispose = registerSettingsSection({
        id: `${contrib.pluginId}:${s.id}`,
        label: s.label,
        icon: s.icon,
        group: s.group,
        sandbox: s.sandbox,
        sandboxUrl: s.sandboxEntry,
        pluginId: contrib.pluginId,
        exportName: s.exportName,
      })
      disposers.push(dispose)
    }
  }

  // ── Themes ──
  if (ui.themes) {
    for (const t of ui.themes) {
      const dispose = registerTheme({
        id: `${contrib.pluginId}:${t.id}`,
        label: t.label,
        variables: {},
        pluginId: contrib.pluginId,
      })
      disposers.push(dispose)
    }
  }

  // ── Icons ──
  if (ui.icons) {
    for (const i of ui.icons) {
      const dispose = registerIcon({
        name: `${contrib.pluginId}:${i.name}`,
        svgContent: "",
        pluginId: contrib.pluginId,
      })
      disposers.push(dispose)
    }
  }

  // ── Chat components ──
  if (ui.chatComponents) {
    for (const cc of ui.chatComponents) {
      const dispose = registerChatComponent({
        id: `${contrib.pluginId}:${cc.id}`,
        slot: cc.slot ?? "after-tools",
        component: undefined as any,
        pluginId: contrib.pluginId,
      })
      disposers.push(dispose)
    }
  }

  // ── Routes ──
  if (ui.routes) {
    for (const r of ui.routes) {
      const dispose = registerPluginRoute({
        path: `/plugin/${contrib.pluginId}/${r.path}`,
        label: r.label,
        icon: r.icon,
        entry: r.entry,
        pluginId: contrib.pluginId,
      })
      disposers.push(dispose)
    }
  }

  setInstances((prev) => [...prev, { id: contrib.pluginId, contribution: contrib, state: "active", disposers }])
}

// ── Deactivate ──────────────────────────────────────────────────────────────

/** Deactivate a plugin by running all its disposers and removing it from state. */
export function deactivatePlugin(pluginId: string): void {
  setInstances((prev) => {
    const inst = prev.find((i) => i.id === pluginId)
    if (inst) {
      for (const dispose of inst.disposers) dispose()
    }
    return prev.filter((i) => i.id !== pluginId)
  })
}

// ── Accessors ───────────────────────────────────────────────────────────────

/** Get all active plugin instances (reactive). */
export function getActivePlugins(): PluginInstance[] {
  return instances()
}

/** Get a plugin contribution by id for lazy-loading its components. */
export function getPluginContribution(pluginId: string): PluginContribution | undefined {
  return instances().find((i) => i.id === pluginId)?.contribution
}
