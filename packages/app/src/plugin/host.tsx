import {
  batch,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
  type ParentProps,
  useContext,
} from "solid-js"
import { pluginAssetUrl } from "@ericsanchezok/synergy-plugin/artifact"
import { PluginToolId } from "@ericsanchezok/synergy-plugin/ids"
import { registerPluginTheme } from "@ericsanchezok/synergy-ui/theme"
import { useServer } from "@/context/server"
import { fetchUIContributions, type PluginContribution } from "./api"
import type { PluginLifecycleState } from "./lifecycle"
import { loadPluginExport } from "./loaders"
import { registerComposerSlot, type ComposerSlotProps } from "./registries/composer-slot-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerMessageSlot, type MessageSlotProps } from "./registries/message-slot-registry"
import { registerNavigation, type NavigationContentProps } from "./registries/navigation-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { toolRendererRegistry, type ToolRenderer } from "./registries/tool-registry"
import { registerUICommand, type PluginUICommand } from "./registries/ui-command-registry"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "./registries/workbench-panel-registry"

export type PluginUIStatus = PluginLifecycleState

export interface PluginUIError {
  pluginId: string
  message: string
  timestamp: number
}

interface PluginHostValue {
  plugins: () => PluginContribution[]
  status: () => Map<string, PluginUIStatus>
  loadedPluginIds: () => string[]
  errors: () => PluginUIError[]
  reload: () => Promise<void>
}

const PluginHostContext = createContext<PluginHostValue>()

function pluginSurfaceId(pluginId: string, surfaceId: string) {
  return `${pluginId}:${surfaceId}`
}

function pluginNavigationPath(pluginId: string, navigationId: string) {
  return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(navigationId)}`
}

function registerPluginSurfaces(contributions: PluginContribution[]) {
  const disposersByPlugin = new Map<string, Array<() => void>>()
  const uiErrors: PluginUIError[] = []

  const addError = (pluginId: string, message: string) => {
    uiErrors.push({ pluginId, message, timestamp: Date.now() })
  }

  const assetUrl = (contribution: PluginContribution, filePath: string) =>
    pluginAssetUrl(contribution.pluginId, contribution.version, filePath)

  const pluginToolId = (pluginId: string, toolId: string) =>
    PluginToolId.is(toolId) ? toolId : PluginToolId.format(pluginId, toolId)

  const loadComponent = <Props extends object>(
    contribution: PluginContribution,
    modulePath: string | undefined,
    exportName: string | undefined,
  ) => {
    if (!modulePath) return undefined
    return () =>
      loadPluginExport<Component<Props>>(
        contribution.pluginId,
        assetUrl(contribution, modulePath),
        exportName ?? "default",
        contribution.ui?.minUIApiVersion ?? "",
      ).catch((err) => {
        console.error(
          `[plugin host ${contribution.pluginId}] loadComponent failed for ${exportName ?? "default"}:`,
          err,
        )
        throw err
      })
  }

  const loadCommand = (
    contribution: PluginContribution,
    modulePath: string | undefined,
    exportName: string | undefined,
  ) => {
    if (!modulePath) return undefined
    return () =>
      loadPluginExport<PluginUICommand>(
        contribution.pluginId,
        assetUrl(contribution, modulePath),
        exportName ?? "default",
        contribution.ui?.minUIApiVersion ?? "",
      )
  }

  for (const contribution of contributions) {
    const ui = contribution.ui
    if (!ui) continue

    disposersByPlugin.set(contribution.pluginId, [])
    const disposers = disposersByPlugin.get(contribution.pluginId)!

    if (contribution.permissions?.ui !== true) {
      addError(
        contribution.pluginId,
        "This plugin declares UI surfaces but permissions.ui is not enabled. Enable the UI permission or remove contributes.ui.",
      )
      continue
    }

    for (const renderer of ui.toolRenderers ?? []) {
      const toolId = pluginToolId(contribution.pluginId, renderer.tool)
      if (toolRendererRegistry.has(toolId)) continue
      const loader = ui.entry
        ? () =>
            loadPluginExport<ToolRenderer>(
              contribution.pluginId,
              assetUrl(contribution, ui.entry!),
              renderer.exportName ?? "default",
              ui.minUIApiVersion ?? "",
            )
        : undefined
      if (!loader && !renderer.fallback) {
        addError(
          contribution.pluginId,
          `Tool renderer "${renderer.tool}" needs contributes.ui.entry or a declarative fallback.`,
        )
        continue
      }
      disposers.push(
        toolRendererRegistry.register(toolId, {
          loader,
          fallback: renderer.fallback,
        }),
      )
    }

    for (const renderer of ui.partRenderers ?? []) {
      if (!ui.entry) {
        addError(contribution.pluginId, `Part renderer "${renderer.type}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerPartRenderer(renderer.type, undefined, () =>
          loadPluginExport<Component>(
            contribution.pluginId,
            assetUrl(contribution, ui.entry!),
            renderer.exportName ?? "default",
            ui.minUIApiVersion ?? "",
          ),
        ),
      )
    }

    for (const panel of ui.workbenchPanels ?? []) {
      const loader = loadComponent<WorkbenchPanelContentProps>(contribution, ui.entry, panel.exportName)
      if (!loader) {
        addError(contribution.pluginId, `Workbench panel "${panel.id}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerWorkbenchPanel({
          id: pluginSurfaceId(contribution.pluginId, panel.id),
          label: panel.label,
          icon: panel.icon,
          surface: panel.surface,
          cardinality: panel.cardinality,
          requiresSession: panel.requiresSession,
          loader,
          pluginId: contribution.pluginId,
          exportName: panel.exportName,
          order: panel.order,
        }),
      )
    }

    for (const navigation of ui.navigation ?? []) {
      const loader = loadComponent<NavigationContentProps>(contribution, ui.entry, navigation.exportName)
      if (!loader) {
        addError(contribution.pluginId, `Navigation surface "${navigation.id}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerNavigation({
          id: pluginSurfaceId(contribution.pluginId, navigation.id),
          navigationId: navigation.id,
          label: navigation.label,
          icon: navigation.icon,
          placement: navigation.placement,
          path: pluginNavigationPath(contribution.pluginId, navigation.id),
          order: navigation.order,
          loader,
          pluginId: contribution.pluginId,
          exportName: navigation.exportName,
        }),
      )
    }

    for (const section of ui.settings ?? []) {
      const loader = loadComponent(contribution, ui.entry, section.exportName)
      if (!loader && !section.formSchema) {
        addError(contribution.pluginId, `Settings section "${section.id}" needs a form schema or contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerSettingsSection({
          id: pluginSurfaceId(contribution.pluginId, section.id),
          label: section.label,
          icon: section.icon,
          group: section.group,
          formSchema: section.formSchema,
          order: section.order,
          visibility: section.visibility,
          loader,
          pluginId: contribution.pluginId,
          exportName: section.exportName,
        }),
      )
    }

    for (const slot of ui.messageSlots ?? []) {
      if (!ui.entry) {
        addError(contribution.pluginId, `Message slot "${slot.id}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerMessageSlot({
          id: pluginSurfaceId(contribution.pluginId, slot.id),
          slot: slot.slot,
          loader: () =>
            loadPluginExport<Component<MessageSlotProps>>(
              contribution.pluginId,
              assetUrl(contribution, ui.entry!),
              slot.exportName ?? "default",
              ui.minUIApiVersion ?? "",
            ),
          pluginId: contribution.pluginId,
        }),
      )
    }

    for (const slot of ui.composerSlots ?? []) {
      if (!ui.entry) {
        addError(contribution.pluginId, `Composer slot "${slot.id}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerComposerSlot({
          id: pluginSurfaceId(contribution.pluginId, slot.id),
          slot: slot.slot,
          order: slot.order,
          loader: () =>
            loadPluginExport<Component<ComposerSlotProps>>(
              contribution.pluginId,
              assetUrl(contribution, ui.entry!),
              slot.exportName ?? "default",
              ui.minUIApiVersion ?? "",
            ),
          pluginId: contribution.pluginId,
        }),
      )
    }

    for (const theme of ui.themes ?? []) {
      disposers.push(
        registerPluginTheme({
          id: pluginSurfaceId(contribution.pluginId, theme.id),
          label: theme.label,
          cssUrl: assetUrl(contribution, theme.path),
          pluginId: contribution.pluginId,
        }),
      )
    }

    for (const icon of ui.icons ?? []) {
      let disposed = false
      let disposeIcon: (() => void) | undefined
      disposers.push(() => {
        disposed = true
        disposeIcon?.()
      })
      fetch(assetUrl(contribution, icon.path))
        .then((response) => (response.ok ? response.text() : ""))
        .then((svgContent) => {
          if (disposed || !svgContent) return
          disposeIcon = registerIcon({ name: icon.name, svgContent, pluginId: contribution.pluginId })
        })
        .catch((error) => {
          if (disposed) return
          addError(
            contribution.pluginId,
            `Icon "${icon.name}" failed to load: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }

    for (const command of ui.commands ?? []) {
      const loader = loadCommand(contribution, ui.entry, command.exportName)
      if (!loader) {
        addError(contribution.pluginId, `Command "${command.id}" needs contributes.ui.entry.`)
        continue
      }
      disposers.push(
        registerUICommand({
          id: pluginSurfaceId(contribution.pluginId, command.id),
          commandId: command.id,
          label: command.label,
          description: command.description,
          icon: command.icon,
          pluginId: contribution.pluginId,
          loader,
        }),
      )
    }
  }

  return { disposersByPlugin, uiErrors }
}

export function PluginHostProvider(props: ParentProps) {
  const server = useServer()
  let disposePluginSurfaces: Array<() => void> = []

  const [pluginContributions, setPluginContributions] = createSignal<PluginContribution[]>([])
  const [statusMap, setStatusMap] = createSignal<Map<string, PluginUIStatus>>(new Map())
  const [errors, setErrors] = createSignal<PluginUIError[]>([])

  function disposeRegisteredSurfaces() {
    for (const dispose of disposePluginSurfaces) dispose()
    disposePluginSurfaces = []
  }

  async function reload() {
    const url = server.url
    if (!url) return

    try {
      const contributions = await fetchUIContributions(url)
      disposeRegisteredSurfaces()
      const registered = registerPluginSurfaces(contributions)
      disposePluginSurfaces = Array.from(registered.disposersByPlugin.values()).flat()

      batch(() => {
        setPluginContributions(contributions)
        const nextStatus = new Map<string, PluginUIStatus>()
        for (const contribution of contributions) {
          nextStatus.set(contribution.pluginId, "active")
        }
        setStatusMap(nextStatus)
        setErrors(registered.uiErrors)
      })
    } catch (error) {
      setErrors([
        {
          pluginId: "",
          message: `Failed to fetch contributions: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        },
      ])
    }
  }

  createEffect(() => {
    const url = server.url
    if (url) void reload()
  })

  onCleanup(disposeRegisteredSurfaces)

  const value: PluginHostValue = {
    plugins: pluginContributions,
    status: statusMap,
    loadedPluginIds: () => pluginContributions().map((plugin) => plugin.pluginId),
    errors,
    reload,
  }

  return <PluginHostContext.Provider value={value}>{props.children}</PluginHostContext.Provider>
}

export function usePluginHost(): PluginHostValue {
  const context = useContext(PluginHostContext)
  if (!context) throw new Error("usePluginHost must be used within a PluginHostProvider")
  return context
}
