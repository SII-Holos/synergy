import {
  batch,
  createContext,
  createEffect,
  createSignal,
  onMount,
  useContext,
  type Component,
  type ParentProps,
} from "solid-js"
import { pluginAssetUrl } from "@ericsanchezok/synergy-plugin/artifact"
import { PluginToolId } from "@ericsanchezok/synergy-plugin/ids"
import { registerPluginTheme } from "@ericsanchezok/synergy-ui/theme"
import { useServer } from "@/context/server"
import { fetchUIContributions, type PluginContribution } from "./api"
import type { PluginLifecycleState } from "./lifecycle"
import { loadPluginExport } from "./loaders"
import { registerAppPanel } from "./registries/app-panel-registry"
import { registerAppRoute } from "./registries/app-route-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerMessageSlot } from "./registries/message-slot-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { toolRendererRegistry, type ToolRenderer } from "./registries/tool-registry"
import { registerUICommand, type PluginUICommand } from "./registries/ui-command-registry"
import { registerWorkbenchPanel } from "./registries/workbench-panel-registry"

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

type UIArea =
  | "toolRenderers"
  | "partRenderers"
  | "workbenchPanels"
  | "appPanels"
  | "settings"
  | "messageSlots"
  | "themes"
  | "icons"
  | "appRoutes"
  | "commands"

function pluginSurfaceId(pluginId: string, surfaceId: string) {
  return `${pluginId}:${surfaceId}`
}

function sandboxUrl(pluginId: string, surface: UIArea, surfaceId: string) {
  return `/plugin/${pluginId}/sandbox/${surface}/${surfaceId}`
}

function permissionGranted(contribution: PluginContribution, area: UIArea) {
  return contribution.permissions?.ui?.[area] === true
}

function canLoadSolidBundle(contribution: PluginContribution) {
  return contribution.trustTier === "trusted-import" && contribution.permissions?.ui?.trustedImport === true
}

function canLoadSandboxIframe(contribution: PluginContribution) {
  return contribution.permissions?.ui?.sandboxIframe === true
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

  const registerIfPermitted = (
    contribution: PluginContribution,
    area: UIArea,
    register: (disposers: Array<() => void>) => void,
  ) => {
    if (!permissionGranted(contribution, area)) {
      addError(contribution.pluginId, `UI permission missing for ${area}`)
      return
    }
    const disposers = disposersByPlugin.get(contribution.pluginId)
    if (!disposers) return
    register(disposers)
  }

  const loadComponent = <Props extends object>(
    contribution: PluginContribution,
    modulePath: string | undefined,
    exportName: string | undefined,
  ) => {
    if (!modulePath) return undefined
    if (!canLoadSolidBundle(contribution)) return undefined
    return () =>
      loadPluginExport<Component<Props>>(
        contribution.pluginId,
        assetUrl(contribution, modulePath),
        exportName ?? "default",
        contribution.ui?.minUIApiVersion ?? "",
      )
  }

  const loadCommand = (
    contribution: PluginContribution,
    modulePath: string | undefined,
    exportName: string | undefined,
  ) => {
    if (!modulePath) return undefined
    if (!canLoadSolidBundle(contribution)) return undefined
    return () =>
      loadPluginExport<PluginUICommand>(
        contribution.pluginId,
        assetUrl(contribution, modulePath),
        exportName ?? "default",
        contribution.ui?.minUIApiVersion ?? "",
      )
  }

  const needsSandbox = (surface: { sandbox?: boolean }) => surface.sandbox === true
  const hasSandboxEntry = (surface: { sandboxEntry?: string; entry?: string }, uiEntry: string | undefined) =>
    Boolean(surface.sandboxEntry ?? surface.entry ?? uiEntry)

  for (const contribution of contributions) {
    const ui = contribution.ui
    if (!ui) continue
    disposersByPlugin.set(contribution.pluginId, [])

    if (ui.toolRenderers?.length) {
      registerIfPermitted(contribution, "toolRenderers", (disposers) => {
        for (const renderer of ui.toolRenderers ?? []) {
          const toolId = pluginToolId(contribution.pluginId, renderer.tool)
          if (toolRendererRegistry.has(toolId)) continue
          const loader =
            canLoadSolidBundle(contribution) && ui.entry
              ? () =>
                  loadPluginExport<ToolRenderer>(
                    contribution.pluginId,
                    assetUrl(contribution, ui.entry!),
                    renderer.exportName ?? "default",
                    ui.minUIApiVersion ?? "",
                  )
              : undefined
          if (!loader && !renderer.fallback) {
            addError(contribution.pluginId, `Tool renderer "${renderer.tool}" requires permissions.ui.trustedImport`)
            continue
          }
          disposers.push(
            toolRendererRegistry.register(toolId, {
              loader,
              fallback: renderer.fallback,
            }),
          )
        }
      })
    }

    if (ui.partRenderers?.length) {
      registerIfPermitted(contribution, "partRenderers", (disposers) => {
        if (!canLoadSolidBundle(contribution) || !ui.entry) {
          addError(
            contribution.pluginId,
            "Part renderers require permissions.ui.trustedImport and contributes.ui.entry",
          )
          return
        }
        for (const renderer of ui.partRenderers ?? []) {
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
      })
    }

    if (ui.workbenchPanels?.length) {
      registerIfPermitted(contribution, "workbenchPanels", (disposers) => {
        for (const panel of ui.workbenchPanels ?? []) {
          const loader = loadComponent(contribution, ui.entry, panel.exportName)
          const sandbox = needsSandbox(panel)
          if (sandbox && !canLoadSandboxIframe(contribution)) {
            addError(contribution.pluginId, `Workbench panel "${panel.id}" requires permissions.ui.sandboxIframe`)
            continue
          }
          if (sandbox && !hasSandboxEntry(panel, ui.entry)) {
            addError(
              contribution.pluginId,
              `Workbench panel "${panel.id}" requires sandboxEntry or contributes.ui.entry`,
            )
            continue
          }
          if (!sandbox && !loader) {
            addError(contribution.pluginId, `Workbench panel "${panel.id}" requires permissions.ui.trustedImport`)
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
              sandbox,
              sandboxUrl: sandbox ? sandboxUrl(contribution.pluginId, "workbenchPanels", panel.id) : undefined,
              pluginId: contribution.pluginId,
              exportName: panel.exportName,
              order: panel.order,
            }),
          )
        }
      })
    }

    if (ui.appPanels?.length) {
      registerIfPermitted(contribution, "appPanels", (disposers) => {
        for (const panel of ui.appPanels ?? []) {
          const loader = loadComponent(contribution, ui.entry, panel.exportName)
          const sandbox = needsSandbox(panel)
          if (sandbox && !canLoadSandboxIframe(contribution)) {
            addError(contribution.pluginId, `App panel "${panel.id}" requires permissions.ui.sandboxIframe`)
            continue
          }
          if (sandbox && !hasSandboxEntry(panel, ui.entry)) {
            addError(contribution.pluginId, `App panel "${panel.id}" requires sandboxEntry or contributes.ui.entry`)
            continue
          }
          if (!sandbox && !loader) {
            addError(contribution.pluginId, `App panel "${panel.id}" requires permissions.ui.trustedImport`)
            continue
          }
          disposers.push(
            registerAppPanel({
              id: pluginSurfaceId(contribution.pluginId, panel.id),
              panelId: panel.id,
              label: panel.label,
              icon: panel.icon,
              order: panel.order,
              loader,
              sandbox,
              sandboxUrl: sandbox ? sandboxUrl(contribution.pluginId, "appPanels", panel.id) : undefined,
              pluginId: contribution.pluginId,
              exportName: panel.exportName,
            }),
          )
        }
      })
    }

    if (ui.settings?.length) {
      registerIfPermitted(contribution, "settings", (disposers) => {
        for (const section of ui.settings ?? []) {
          const loader = loadComponent(contribution, ui.entry, section.exportName)
          const sandbox = needsSandbox(section)
          if (sandbox && !canLoadSandboxIframe(contribution)) {
            addError(contribution.pluginId, `Settings section "${section.id}" requires permissions.ui.sandboxIframe`)
            continue
          }
          if (sandbox && !hasSandboxEntry(section, ui.entry)) {
            addError(
              contribution.pluginId,
              `Settings section "${section.id}" requires sandboxEntry or contributes.ui.entry`,
            )
            continue
          }
          if (!sandbox && !loader && !section.formSchema) {
            addError(contribution.pluginId, `Settings section "${section.id}" requires a form schema or trusted UI`)
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
              loader,
              sandbox,
              sandboxUrl: sandbox ? sandboxUrl(contribution.pluginId, "settings", section.id) : undefined,
              pluginId: contribution.pluginId,
              exportName: section.exportName,
            }),
          )
        }
      })
    }

    if (ui.messageSlots?.length) {
      registerIfPermitted(contribution, "messageSlots", (disposers) => {
        if (!canLoadSolidBundle(contribution) || !ui.entry) {
          addError(contribution.pluginId, "Message slots require permissions.ui.trustedImport and contributes.ui.entry")
          return
        }
        for (const slot of ui.messageSlots ?? []) {
          disposers.push(
            registerMessageSlot({
              id: pluginSurfaceId(contribution.pluginId, slot.id),
              slot: slot.slot,
              loader: () =>
                loadPluginExport<Component>(
                  contribution.pluginId,
                  assetUrl(contribution, ui.entry!),
                  slot.exportName ?? "default",
                  ui.minUIApiVersion ?? "",
                ),
              pluginId: contribution.pluginId,
            }),
          )
        }
      })
    }

    if (ui.themes?.length) {
      registerIfPermitted(contribution, "themes", (disposers) => {
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
      })
    }

    if (ui.icons?.length) {
      registerIfPermitted(contribution, "icons", (disposers) => {
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
      })
    }

    if (ui.appRoutes?.length) {
      registerIfPermitted(contribution, "appRoutes", (disposers) => {
        for (const route of ui.appRoutes ?? []) {
          const loader = loadComponent(contribution, route.entry ?? ui.entry, route.exportName)
          const sandbox = needsSandbox(route)
          if (sandbox && !canLoadSandboxIframe(contribution)) {
            addError(contribution.pluginId, `App route "${route.id}" requires permissions.ui.sandboxIframe`)
            continue
          }
          if (sandbox && !hasSandboxEntry(route, ui.entry)) {
            addError(
              contribution.pluginId,
              `App route "${route.id}" requires sandboxEntry, entry, or contributes.ui.entry`,
            )
            continue
          }
          if (!sandbox && !loader) {
            addError(contribution.pluginId, `App route "${route.id}" requires permissions.ui.trustedImport`)
            continue
          }
          disposers.push(
            registerAppRoute({
              id: pluginSurfaceId(contribution.pluginId, route.id),
              routeId: route.id,
              label: route.label,
              icon: route.icon,
              loader,
              sandbox,
              sandboxUrl: sandbox ? sandboxUrl(contribution.pluginId, "appRoutes", route.id) : undefined,
              pluginId: contribution.pluginId,
              exportName: route.exportName,
            }),
          )
        }
      })
    }

    if (ui.commands?.length) {
      registerIfPermitted(contribution, "commands", (disposers) => {
        for (const command of ui.commands ?? []) {
          const loader = loadCommand(contribution, ui.entry, command.exportName)
          if (!loader) {
            addError(contribution.pluginId, `Command "${command.id}" requires permissions.ui.trustedImport`)
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
      })
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
      setErrors((prev) => [
        ...prev,
        {
          pluginId: "",
          message: `Failed to fetch contributions: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        },
      ])
    }
  }

  onMount(() => {
    void reload()
  })

  createEffect(() => {
    const url = server.url
    if (url) void reload()
  })

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
