import {
  ErrorBoundary,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js"
import { useParams } from "@solidjs/router"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SandboxIframe } from "./sandbox"
import {
  getAppPanel,
  subscribeAppPanels,
  type AppPanelContentProps,
  type AppPanelEntry,
} from "./registries/app-panel-registry"
import {
  getAppRoute,
  subscribeAppRoutes,
  type AppRouteContentProps,
  type AppRouteEntry,
} from "./registries/app-route-registry"

type PluginSurfaceProps = {
  pluginId: string
  panelId?: string
  routeId?: string
}

function PluginSurfaceFrame(props: { title: string; children: JSX.Element }) {
  return (
    <div class="size-full min-h-0 overflow-hidden bg-background-base text-text-base">
      <div class="size-full min-h-0">{props.children}</div>
    </div>
  )
}

function PluginSurfaceUnavailable(props: { title: string; message: string }) {
  return (
    <PluginSurfaceFrame title={props.title}>
      <div class="size-full flex items-center justify-center p-6">
        <div class="max-w-md rounded-lg border border-border-base bg-surface-base p-5">
          <div class="mb-3 flex items-center gap-2 text-14-medium text-text-strong">
            <Icon name={getSemanticIcon("state.warning")} size="small" />
            <span>{props.title}</span>
          </div>
          <p class="text-13-regular text-text-weak">{props.message}</p>
        </div>
      </div>
    </PluginSurfaceFrame>
  )
}

function PluginSurfaceContent(props: {
  entry: AppPanelEntry | AppRouteEntry
  loadProps: PluginSurfaceProps
  emptyMessage: string
}) {
  const [component, setComponent] = createSignal<Component<PluginSurfaceProps> | null>(null)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const entry = props.entry
    setComponent(
      () => ("component" in entry ? (entry.component ?? null) : null) as Component<PluginSurfaceProps> | null,
    )
    if (!entry.loader || entry.sandbox) {
      setLoading(false)
      return
    }
    setLoading(true)
    entry.loader().then(
      (mod) => {
        setComponent(() => mod.default as Component<PluginSurfaceProps>)
        setLoading(false)
      },
      () => setLoading(false),
    )
  })

  return (
    <PluginSurfaceFrame title={props.entry.label}>
      <Show
        when={!loading()}
        fallback={
          <div class="size-full flex items-center justify-center">
            <Spinner class="size-5" />
          </div>
        }
      >
        <Show when={props.entry.sandbox && props.entry.sandboxUrl}>
          <ErrorBoundary
            fallback={(error) => <PluginSurfaceUnavailable title={props.entry.label} message={error.message} />}
          >
            <SandboxIframe src={props.entry.sandboxUrl!} pluginId={props.entry.pluginId} panelId={props.entry.id} />
          </ErrorBoundary>
        </Show>
        <Show when={!props.entry.sandbox}>
          <Show
            when={component()}
            fallback={<PluginSurfaceUnavailable title={props.entry.label} message={props.emptyMessage} />}
          >
            {(Loaded) => (
              <Suspense
                fallback={
                  <div class="size-full flex items-center justify-center">
                    <Spinner class="size-5" />
                  </div>
                }
              >
                {(() => {
                  const SurfaceComponent = Loaded()
                  return <SurfaceComponent {...props.loadProps} />
                })()}
              </Suspense>
            )}
          </Show>
        </Show>
      </Show>
    </PluginSurfaceFrame>
  )
}

export function PluginAppPanelPage() {
  const params = useParams()
  const [registryVersion, setRegistryVersion] = createSignal(0)
  const unsubscribe = subscribeAppPanels(() => setRegistryVersion((version) => version + 1))
  onCleanup(unsubscribe)
  const pluginId = () => params.pluginId
  const panelId = () => params.panelId

  const entry = createMemo(() => {
    registryVersion()
    const currentPluginId = pluginId()
    const currentPanelId = panelId()
    if (!currentPluginId || !currentPanelId) return undefined
    return getAppPanel(currentPluginId, currentPanelId)
  })

  return (
    <Show
      when={entry()}
      fallback={
        <PluginSurfaceUnavailable
          title="Plugin panel unavailable"
          message={`No plugin app panel is registered for ${pluginId() ?? ""}/${panelId() ?? ""}.`}
        />
      }
    >
      {(panel) => (
        <PluginSurfaceContent
          entry={panel()}
          loadProps={{ pluginId: pluginId()!, panelId: panelId()! } satisfies AppPanelContentProps}
          emptyMessage="This plugin app panel is not available."
        />
      )}
    </Show>
  )
}

export function PluginAppRoutePage() {
  const params = useParams()
  const [registryVersion, setRegistryVersion] = createSignal(0)
  const unsubscribe = subscribeAppRoutes(() => setRegistryVersion((version) => version + 1))
  onCleanup(unsubscribe)
  const pluginId = () => params.pluginId
  const routeId = () => params.routeId

  const entry = createMemo(() => {
    registryVersion()
    const currentPluginId = pluginId()
    const currentRouteId = routeId()
    if (!currentPluginId || !currentRouteId) return undefined
    return getAppRoute(currentPluginId, currentRouteId)
  })

  return (
    <Show
      when={entry()}
      fallback={
        <PluginSurfaceUnavailable
          title="Plugin route unavailable"
          message={`No plugin app route is registered for ${pluginId() ?? ""}/${routeId() ?? ""}.`}
        />
      }
    >
      {(route) => (
        <PluginSurfaceContent
          entry={route()}
          loadProps={{ pluginId: pluginId()!, routeId: routeId()! } satisfies AppRouteContentProps}
          emptyMessage="This plugin app route is not available."
        />
      )}
    </Show>
  )
}
