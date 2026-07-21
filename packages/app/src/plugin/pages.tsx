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
import { useLingui } from "@lingui/solid"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import {
  getBuiltinNavigation,
  getPluginNavigation,
  subscribeNavigation,
  navigationEntryLabel,
  type NavigationContentProps,
  type NavigationEntry,
} from "./registries/navigation-registry"

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function PluginNavigationContent(props: { entry: NavigationEntry; loadProps: NavigationContentProps }) {
  const { _ } = useLingui()
  const [component, setComponent] = createSignal<Component<NavigationContentProps> | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | undefined>()
  const label = () => navigationEntryLabel(props.entry, _)

  let disposed = false

  const loadEntry = (entry: NavigationEntry) => {
    setComponent(() => entry.component ?? null)
    setLoadError(undefined)
    if (!entry.loader) {
      setLoading(false)
      return
    }

    setLoading(true)
    entry.loader().then(
      (mod) => {
        if (disposed) return
        setComponent(() => mod.default)
        setLoading(false)
      },
      (error) => {
        if (disposed) return
        setLoadError(errorMessage(error))
        setLoading(false)
      },
    )
  }

  createEffect(() => loadEntry(props.entry))

  onCleanup(() => {
    disposed = true
  })

  return (
    <PluginSurfaceFrame title={label()}>
      <Show
        when={!loading()}
        fallback={
          <div class="size-full flex items-center justify-center">
            <Spinner class="size-5" />
          </div>
        }
      >
        <Show when={!loadError()} fallback={<PluginSurfaceUnavailable title={label()} message={loadError()!} />}>
          <Show
            when={component()}
            fallback={
              <PluginSurfaceUnavailable
                title={label()}
                message={_({
                  id: "app.plugin.surface.noComponent",
                  message:
                    "This plugin navigation surface has no loadable Solid component. Rebuild or validate the plugin.",
                })}
              />
            }
          >
            {(Loaded) => (
              <ErrorBoundary
                fallback={(error) => <PluginSurfaceUnavailable title={label()} message={errorMessage(error)} />}
              >
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
              </ErrorBoundary>
            )}
          </Show>
        </Show>
      </Show>
    </PluginSurfaceFrame>
  )
}

function NavigationPageContent(props: {
  entry: () => NavigationEntry | undefined
  title: string
  message: () => string
}) {
  return (
    <Show when={props.entry()} fallback={<PluginSurfaceUnavailable title={props.title} message={props.message()} />}>
      {(navigation) => (
        <PluginNavigationContent
          entry={navigation()}
          loadProps={{
            pluginId: navigation().pluginId,
            navigationId: navigation().navigationId,
            placement: navigation().placement,
          }}
        />
      )}
    </Show>
  )
}

export function BuiltinNavigationPage(props: { navigationId: string }) {
  const { _ } = useLingui()
  const [registryVersion, setRegistryVersion] = createSignal(0)
  onCleanup(subscribeNavigation(() => setRegistryVersion((version) => version + 1)))
  const entry = createMemo(() => {
    registryVersion()
    return getBuiltinNavigation(props.navigationId)
  })

  return (
    <NavigationPageContent
      entry={entry}
      title={_({ id: "app.plugin.surface.pageUnavailable", message: "Page unavailable" })}
      message={() =>
        _({
          id: "app.plugin.surface.noBuiltinNav",
          message: "No built-in navigation surface is registered for {id}.",
          values: { id: props.navigationId },
        })
      }
    />
  )
}

export function PluginNavigationPage() {
  const { _ } = useLingui()
  const params = useParams()
  const [registryVersion, setRegistryVersion] = createSignal(0)
  onCleanup(subscribeNavigation(() => setRegistryVersion((version) => version + 1)))
  const pluginId = () => params.pluginId
  const navigationId = () => params.navigationId

  const entry = createMemo(() => {
    registryVersion()
    const currentPluginId = pluginId()
    const currentNavigationId = navigationId()
    if (!currentPluginId || !currentNavigationId) return undefined
    return getPluginNavigation(currentPluginId, currentNavigationId)
  })

  return (
    <NavigationPageContent
      entry={entry}
      title={_({ id: "app.plugin.surface.pluginPageUnavailable", message: "Plugin page unavailable" })}
      message={() =>
        _({
          id: "app.plugin.surface.noPluginNav",
          message: "No plugin navigation surface is registered for {pluginId}/{navigationId}.",
          values: { pluginId: pluginId() ?? "", navigationId: navigationId() ?? "" },
        })
      }
    />
  )
}
