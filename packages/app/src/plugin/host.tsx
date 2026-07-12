import {
  type Accessor,
  batch,
  createComponent,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
  type ParentProps,
  useContext,
} from "solid-js"
import type { PluginManifestContribution, PluginSurfaceContext } from "@ericsanchezok/synergy-plugin"
import { pluginAssetUrl } from "@ericsanchezok/synergy-plugin/artifact"
import { registerPluginTheme } from "@ericsanchezok/synergy-ui/theme"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { fetchUIContributions, type PluginContribution } from "./api"
import type { PluginLifecycleState } from "./lifecycle"
import { loadPluginExport } from "./loaders"
import { loadPluginUIAssets, resolvePluginIconReference, type PluginUIAssets } from "./ui-assets"
import { pluginSurfaceId } from "./surface-id"
import { registerComposerSlot, type ComposerSlotProps } from "./registries/composer-slot-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerNavigation, type NavigationContentProps } from "./registries/navigation-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "./registries/workbench-panel-registry"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

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
const navigationPath = (pluginId: string, id: string) =>
  `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(id)}`

function navigate(path: string) {
  window.history.pushState({}, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

function currentSessionId() {
  const match = window.location.pathname.match(/\/session\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function surfaceContext(input: {
  contribution: PluginContribution
  contributionId: string
  kind: string
  serverUrl: string
  events: ReturnType<typeof useGlobalSDK>["event"]
  scopeKey: string
  sessionId?: string
  resource?: { id: string; title?: string; state?: unknown }
}): PluginSurfaceContext {
  const pluginId = input.contribution.pluginId
  const requireHostActions = () => {
    if (!input.contribution.capabilities.includes("ui.hostActions"))
      throw new Error("Plugin is not approved for ui.hostActions")
  }
  const invoke = async (type: "query" | "command", id: string, value?: unknown) => {
    const declared = input.contribution.contributions.find((item) => item.kind === "operation" && item.id === id)
    if (!declared || declared.kind !== "operation" || declared.type !== type)
      throw new Error(`Plugin operation ${id} is not a ${type}`)
    const response = await fetch(
      `${input.serverUrl}/plugin/${encodeURIComponent(pluginId)}/operations/${encodeURIComponent(id)}/invoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-synergy-plugin-caller": "ui",
          "x-synergy-scope-id": encodeURIComponent(input.contribution.scopeId),
        },
        body: JSON.stringify({ input: value ?? {}, sessionId: input.sessionId }),
      },
    )
    const body = await response.json()
    if (!response.ok)
      throw Object.assign(new Error(body.message ?? `Plugin operation failed (${response.status})`), {
        code: body.code,
      })
    return body.data
  }
  return {
    pluginId,
    scopeId: input.contribution.scopeId,
    sessionId: input.sessionId,
    surface: {
      kind: input.kind,
      id: input.contributionId,
      ...(input.resource ? { resource: input.resource } : {}),
    },
    operations: {
      query: (id, value) => invoke("query", id, value),
      command: (id, value) => invoke("command", id, value),
    },
    events: {
      subscribe(eventId, listener) {
        return input.events.listen((event: any) => {
          if (event?.type !== "plugin.event") return
          const value = event.properties
          if (
            value?.pluginId === pluginId &&
            value?.scopeId === input.contribution.scopeId &&
            value?.eventId === eventId
          )
            listener(value)
        })
      },
    },
    settings: {
      async get() {
        const response = await fetch(`${input.serverUrl}/plugin/${encodeURIComponent(pluginId)}/config`, {
          headers: { "x-synergy-scope-id": encodeURIComponent(input.contribution.scopeId) },
        })
        if (!response.ok) throw new Error(`Plugin settings request failed (${response.status})`)
        return (await response.json()) as Record<string, unknown>
      },
      subscribe(listener) {
        const onChange = (event: Event) => {
          const detail = (event as CustomEvent<{ pluginId?: string; values?: Record<string, unknown> }>).detail
          if (detail?.pluginId === pluginId && detail.values) listener(detail.values)
        }
        window.addEventListener("synergy:plugin-config-changed", onChange)
        return () => window.removeEventListener("synergy:plugin-config-changed", onChange)
      },
    },
    host: {
      openSession(sessionId) {
        requireHostActions()
        navigate(`/${base64Encode(input.scopeKey)}/session/${encodeURIComponent(sessionId)}`)
      },
      openPluginPage(path, params) {
        requireHostActions()
        const queryParams = new URLSearchParams(params)
        queryParams.set("_scope", base64Encode(input.scopeKey))
        const query = queryParams.toString()
        navigate(`/plugins/${encodeURIComponent(pluginId)}/${path.replace(/^\//, "")}${query ? `?${query}` : ""}`)
      },
      openWorkbenchPanel(panelId, resource) {
        requireHostActions()
        window.dispatchEvent(
          new CustomEvent("synergy:plugin-open-workbench", {
            detail: { panelId: pluginSurfaceId(pluginId, panelId), resource },
          }),
        )
      },
      openResource(resource) {
        requireHostActions()
        window.dispatchEvent(new CustomEvent("synergy:plugin-open-resource", { detail: resource }))
      },
      notify(message, options) {
        requireHostActions()
        showToast({ type: options?.kind ?? "info", title: message })
      },
      confirm: async (options) => {
        requireHostActions()
        return window.confirm(`${options.title}\n\n${options.message}`)
      },
    },
  }
}

function registerPluginSurfaces(input: {
  contributions: PluginContribution[]
  serverUrl: string
  events: ReturnType<typeof useGlobalSDK>["event"]
  scopeKey: string
  assets: PluginUIAssets
}) {
  const disposers: Array<() => void> = []
  const errors: PluginUIError[] = input.assets.errors.map((error) => ({ ...error, timestamp: Date.now() }))
  const fail = (pluginId: string, message: string) => errors.push({ pluginId, message, timestamp: Date.now() })

  for (const plugin of input.contributions) {
    const asset = (file: string) => pluginAssetUrl(plugin.pluginId, plugin.generation, file)
    const componentLoader = <Props extends object>(
      item: PluginManifestContribution,
      session: (props: Props) => string | undefined = () => currentSessionId(),
      resource: (props: Props) => { id: string; title?: string; state?: unknown } | undefined = () => undefined,
    ) => {
      if (!("component" in item) || !item.component) return undefined
      return async () => {
        const loaded = await loadPluginExport<Component<PluginSurfaceContext>>(
          plugin.pluginId,
          asset(item.component!.entry),
          item.component!.exportName,
          "3.0",
        )
        const Wrapper: Component<Props> = (props) =>
          createComponent(
            loaded.default,
            surfaceContext({
              contribution: plugin,
              contributionId: item.id,
              kind: item.kind,
              serverUrl: input.serverUrl,
              events: input.events,
              scopeKey: input.scopeKey,
              sessionId: session(props),
              resource: resource(props),
            }),
          )
        return { default: Wrapper }
      }
    }

    const adapters = {
      "ui.workbenchPanel": (item: Extract<PluginManifestContribution, { kind: "ui.workbenchPanel" }>) => {
        const loader = componentLoader<WorkbenchPanelContentProps>(
          item,
          () => currentSessionId(),
          (props) =>
            props.tab.resourceId
              ? {
                  id: props.tab.resourceId,
                  ...(props.tab.title ? { title: props.tab.title } : {}),
                  ...(props.tab.state !== undefined ? { state: props.tab.state } : {}),
                }
              : undefined,
        )
        if (!loader) {
          fail(plugin.pluginId, `Workbench panel ${item.id} has no trusted component`)
          return
        }
        disposers.push(
          registerWorkbenchPanel({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            surface: item.surface,
            cardinality: item.cardinality,
            requiresSession: item.requiresSession,
            pluginId: plugin.pluginId,
            loader,
            defaultResource: item.defaultResource
              ? {
                  resourceId: item.defaultResource.id,
                  title: item.defaultResource.title,
                  state: item.defaultResource.state,
                  source: "plugin",
                }
              : undefined,
            createTab: item.defaultResource
              ? () => ({
                  resourceId: item.defaultResource!.id,
                  title: item.defaultResource!.title,
                  state: item.defaultResource!.state,
                  source: "plugin",
                })
              : undefined,
          }),
        )
      },
      "ui.navigationItem": (item: Extract<PluginManifestContribution, { kind: "ui.navigationItem" }>) => {
        const loader = componentLoader<NavigationContentProps>(item)
        if (!loader) {
          fail(plugin.pluginId, `Navigation item ${item.id} has no trusted component`)
          return
        }
        disposers.push(
          registerNavigation({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            navigationId: item.id,
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            placement: item.placement,
            path: navigationPath(plugin.pluginId, item.id),
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.messageRenderer": (item: Extract<PluginManifestContribution, { kind: "ui.messageRenderer" }>) => {
        const loader = componentLoader<{ sessionId?: string }>(item, (props) => props.sessionId ?? currentSessionId())
        if (loader) disposers.push(registerPartRenderer(item.messageType, undefined, loader as never))
      },
      "ui.composerAction": (item: Extract<PluginManifestContribution, { kind: "ui.composerAction" }>) => {
        const loader = componentLoader<ComposerSlotProps>(item, (props) => props.sessionId)
        if (loader)
          disposers.push(
            registerComposerSlot({
              id: pluginSurfaceId(plugin.pluginId, item.id),
              slot: item.slot as ComposerSlotProps["slot"],
              order: item.order,
              pluginId: plugin.pluginId,
              loader,
            }),
          )
      },
      "ui.settings": (item: Extract<PluginManifestContribution, { kind: "ui.settings" }>) => {
        const loader = componentLoader<Record<string, never>>(item)
        disposers.push(
          registerSettingsSection({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            group: item.group,
            order: item.order,
            formSchema: item.formSchema,
            visibility: item.visibility,
            pluginId: plugin.pluginId,
            loader: loader as never,
          }),
        )
      },
      "ui.theme": (item: Extract<PluginManifestContribution, { kind: "ui.theme" }>) => {
        const loaded = input.assets.themes.get(pluginSurfaceId(plugin.pluginId, item.id))
        if (loaded) disposers.push(registerPluginTheme(loaded))
      },
      "ui.icon": (item: Extract<PluginManifestContribution, { kind: "ui.icon" }>) => {
        const loaded = input.assets.icons.get(pluginSurfaceId(plugin.pluginId, item.id))
        if (loaded) disposers.push(registerIcon(loaded))
      },
    }

    for (const item of plugin.contributions) {
      const adapter = adapters[item.kind as keyof typeof adapters]
      if (adapter) adapter(item as never)
    }
  }
  return { disposers, errors }
}

export function PluginHostProvider(props: ParentProps<{ scopeKey: Accessor<string> }>) {
  const server = useServer()
  const globalSDK = useGlobalSDK()
  const scopeKey = props.scopeKey
  let disposers: Array<() => void> = []
  let reloadGeneration = 0
  let reloadController: AbortController | undefined
  const [plugins, setPlugins] = createSignal<PluginContribution[]>([])
  const [status, setStatus] = createSignal(new Map<string, PluginUIStatus>())
  const [errors, setErrors] = createSignal<PluginUIError[]>([])
  const dispose = () => {
    for (const item of disposers) item()
    disposers = []
  }
  async function reload() {
    if (!server.url) return
    const generation = ++reloadGeneration
    reloadController?.abort()
    const controller = new AbortController()
    reloadController = controller
    try {
      const next = await fetchUIContributions(server.url, scopeKey())
      const assets = await loadPluginUIAssets(next, { signal: controller.signal })
      if (generation !== reloadGeneration) return
      dispose()
      const registered = registerPluginSurfaces({
        contributions: next,
        serverUrl: server.url,
        events: globalSDK.event,
        scopeKey: scopeKey(),
        assets,
      })
      disposers = registered.disposers
      batch(() => {
        setPlugins(next)
        setStatus(new Map(next.map((item) => [item.pluginId, "active" as const])))
        setErrors(registered.errors)
      })
    } catch (error) {
      if (controller.signal.aborted || generation !== reloadGeneration) return
      setErrors([
        { pluginId: "", message: error instanceof Error ? error.message : String(error), timestamp: Date.now() },
      ])
    }
  }
  createEffect(() => {
    scopeKey()
    if (server.url) void reload()
  })
  onCleanup(() => {
    reloadController?.abort()
    dispose()
  })
  return (
    <PluginHostContext.Provider
      value={{ plugins, status, loadedPluginIds: () => plugins().map((item) => item.pluginId), errors, reload }}
    >
      {props.children}
    </PluginHostContext.Provider>
  )
}

export function usePluginHost() {
  const value = useContext(PluginHostContext)
  if (!value) throw new Error("usePluginHost must be used within PluginHostProvider")
  return value
}
