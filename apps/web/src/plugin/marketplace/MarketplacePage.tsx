import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { pluginMarketplace } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import { useNavigate, type RouteSectionProps } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { AppPanel, capturePanelFocusReturn } from "@/components/app-panel"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocale } from "@/context/locale"

import { VerifiedBadge } from "./VerifiedBadge"
import type { RegistryPluginSummary } from "@ericsanchezok/synergy-sdk/client"
import type { InstalledPlugin } from "./types"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import { PluginDetailDialog, type RegistrySource } from "./PluginDetailDialog"
import { loadRegistryResource } from "./registry-resource"
import {
  installationLabel,
  installedPluginStatusView,
  installedPluginsForView,
  MARKETPLACE_NAV_ITEMS,
  type MarketplaceView,
} from "./view-model"
import "./marketplace.css"

type RowState = "available" | "installed" | "update"
type MarketplacePageProps = Partial<RouteSectionProps> & {
  initialPluginId?: string
  initialSource?: RegistrySource
}

export function MarketplacePage(props: MarketplacePageProps) {
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const navigate = useNavigate()
  const onCloseWorkspace = useWorkspaceMobileHeaderClose()
  const { _ } = useLingui()
  const { controller, i18n } = useLocale()
  const [query, setQuery] = createSignal("")
  const [debouncedQuery, setDebouncedQuery] = createSignal("")
  const [view, setView] = createSignal<MarketplaceView>("discover")
  let searchInput: HTMLInputElement | undefined
  const [catalogSource, setCatalogSource] = createSignal<RegistrySource>(props.initialSource ?? "official")
  const localizedNavItems = createMemo(() => {
    controller.activeLocale()
    return MARKETPLACE_NAV_ITEMS.map((item) => ({ id: item.id, label: translateDescriptor(item.label, i18n) }))
  })

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const handleInput = (value: string) => {
    setQuery(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedQuery(value), 200)
  }

  const registryKey = () => JSON.stringify([debouncedQuery().trim(), catalogSource()])
  onCleanup(() => clearTimeout(debounceTimer))
  let acceptedCatalog: { key: string; data: RegistryPluginSummary[] } | undefined
  let acceptedInstalled: InstalledPlugin[] = []
  const [installedUnavailable, setInstalledUnavailable] = createSignal(false)

  const [searchResults, { refetch: refetchSearchResults }] = createResource(
    () => (view() === "discover" ? registryKey() : undefined),
    async (key) => {
      const [query, source] = JSON.parse(key) as [string, RegistrySource]
      const resource = await loadRegistryResource(
        async () => {
          const res = await globalSDK.client.registry.plugins.search(
            { q: query || undefined, limit: 50, source },
            { throwOnError: true },
          )
          return res.data?.plugins ?? []
        },
        acceptedCatalog?.key === key ? acceptedCatalog.data : [],
      )
      if (!resource.unavailable) acceptedCatalog = { key, data: resource.data }
      return { ...resource, key }
    },
  )
  const registryResult = () => (searchResults.latest?.key === registryKey() ? searchResults.latest : undefined)

  const [installedResource, { refetch: refetchInstalledPlugins }] = createResource(
    () => true,
    async () => {
      const resource = await loadRegistryResource(async () => {
        const res = await globalSDK.client.api.plugins.list(undefined, { throwOnError: true })
        return (res.data as InstalledPlugin[]) ?? []
      }, acceptedInstalled)
      setInstalledUnavailable(resource.unavailable)
      if (!resource.unavailable) acceptedInstalled = resource.data
      return resource.data
    },
  )
  const installedPlugins = () => installedResource.latest ?? []

  const installedVersionById = createMemo(() => {
    const map = new Map<string, string>()
    for (const plugin of installedPlugins() ?? []) {
      if (plugin.version && plugin.version !== "0.0.0") {
        map.set(plugin.id, plugin.version)
      }
    }
    return map
  })

  const installedList = createMemo(() => {
    const current = view()
    if (current === "discover") return []
    return installedPluginsForView(installedPlugins() ?? [], current, debouncedQuery())
  })

  const resultCount = createMemo(() =>
    view() === "discover" ? (registryResult()?.data.length ?? 0) : installedList().length,
  )
  const currentLabel = createMemo(
    () => localizedNavItems().find((item) => item.id === view())?.label ?? _(pluginMarketplace.navDiscover),
  )

  async function refreshMarketplace() {
    await Promise.all([refetchInstalledPlugins(), refetchSearchResults()])
  }

  const [refreshing, setRefreshing] = createSignal(false)

  async function handleRefresh() {
    if (refreshing()) return
    setRefreshing(true)
    try {
      const res = await globalSDK.client.registry.refresh()
      if (res.data?.refreshedAt) {
        showToast({
          type: "info",
          title: _(pluginMarketplace.refreshUpdated),
        })
      }
      await refreshMarketplace()
    } catch (error) {
      showToast({
        type: "error",
        title: _(pluginMarketplace.refreshFailed),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setRefreshing(false)
    }
  }

  function openPlugin(
    pluginId: string,
    options: { source?: RegistrySource; closeToMarketplace?: boolean; installedPlugin?: InstalledPlugin } = {},
  ) {
    const restoreFocus = capturePanelFocusReturn()
    dialog.show(
      () => (
        <PluginDetailDialog
          pluginId={pluginId}
          source={options.source}
          installedPlugin={options.installedPlugin}
          onChanged={refreshMarketplace}
        />
      ),
      () => {
        if (options.closeToMarketplace) navigate("/plugins/marketplace")
        else restoreFocus()
      },
    )
  }

  onMount(() => {
    if (!props.initialPluginId) return
    queueMicrotask(() =>
      openPlugin(props.initialPluginId!, {
        source: props.initialSource ?? "official",
        closeToMarketplace: true,
      }),
    )
  })

  return (
    <AppPanel.Root class="plugin-marketplace-workbench">
      <AppPanel.Content>
        <WorkspaceMobileHeader onClose={onCloseWorkspace} />
        <AppPanel.Header class="plugin-marketplace-header">
          <div class="plugin-marketplace-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>{_({ id: "app.plugin.marketplace.title", message: "Plugins" })}</AppPanel.Title>
            </AppPanel.HeaderRow>
            <div class="plugin-marketplace-nav">
              <AppPanel.Tabs
                id="plugins"
                label={_({ id: "app.plugin.marketplace.views", message: "Plugin views" })}
                items={localizedNavItems()}
                active={view()}
                onChange={(id) => setView(id as MarketplaceView)}
              />
            </div>
            <div class="plugin-marketplace-header-controls">
              <div class="plugin-marketplace-search">
                <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak-base shrink-0" />
                <input
                  ref={searchInput}
                  type="text"
                  value={query()}
                  onInput={(event) => handleInput(event.currentTarget.value)}
                  aria-label={_({ id: "app.plugin.marketplace.searchPlaceholder", message: "Search plugins" })}
                  placeholder={_({ id: "app.plugin.marketplace.searchPlaceholder", message: "Search plugins" })}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    aria-label={_({ id: "app.plugin.marketplace.clearSearch", message: "Clear search" })}
                    onClick={() => {
                      handleInput("")
                      searchInput?.focus()
                    }}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </Show>
              </div>
              <button
                type="button"
                class="plugin-marketplace-refresh"
                aria-label={_(pluginMarketplace.refreshButton)}
                title={_(pluginMarketplace.refreshButton)}
                disabled={refreshing()}
                onClick={() => void handleRefresh()}
              >
                <Icon
                  name={getSemanticIcon("action.refresh")}
                  size="small"
                  class={refreshing() ? "animate-spin" : ""}
                />
              </button>
            </div>
          </div>
        </AppPanel.Header>

        <AppPanel.Body padding={false} class="plugin-marketplace-body" tab={{ id: "plugins", value: view() }}>
          <div class="plugin-marketplace-stage">
            <section class="plugin-marketplace-list-panel" data-view={view()}>
              <div class="plugin-marketplace-list-heading">
                <div>
                  <p>
                    <Show
                      when={!searchResults.loading && !installedResource.loading}
                      fallback={_({ id: "app.plugin.marketplace.checkingPlugins", message: "Checking plugins" })}
                    >
                      {resultCount()}{" "}
                      {resultCount() === 1
                        ? _({ id: "app.plugin.marketplace.plugin.singular", message: "plugin" })
                        : _({ id: "app.plugin.marketplace.plugin.plural", message: "plugins" })}
                      <Show when={debouncedQuery()}>
                        {" "}
                        {_({
                          id: "app.plugin.marketplace.matchingQuery",
                          message: `matching "{query}"`,
                          values: { query: debouncedQuery() },
                        })}
                      </Show>
                    </Show>
                  </p>
                </div>
                <Show when={query() || (view() === "discover" && catalogSource() !== "official")}>
                  <button
                    type="button"
                    class="plugin-marketplace-filter-reset"
                    onClick={() => {
                      handleInput("")
                      setCatalogSource("official")
                      searchInput?.focus()
                    }}
                  >
                    {_({ id: "app.plugin.marketplace.clearFilters", message: "Clear filters" })}
                  </button>
                </Show>
                <Show when={view() === "discover"}>
                  <AppPanel.Selection
                    label={_({ id: "app.plugin.marketplace.catalogSource", message: "Plugin catalog source" })}
                    items={[
                      {
                        id: "official",
                        label: _({ id: "app.plugin.marketplace.source.official", message: "Official" }),
                      },
                      {
                        id: "local",
                        label: _({ id: "app.plugin.marketplace.source.localRegistry", message: "Local registry" }),
                      },
                    ]}
                    active={catalogSource()}
                    onChange={(id) => setCatalogSource(id as RegistrySource)}
                  />
                </Show>
              </div>

              <Show when={view() === "discover" && searchResults.loading && !registryResult()?.data.length}>
                <SkeletonRows />
              </Show>

              <Show when={view() !== "discover" && installedResource.loading && !installedPlugins().length}>
                <SkeletonRows />
              </Show>

              <Show when={view() !== "discover" && !installedResource.loading && installedUnavailable()}>
                <EmptyState
                  compact={installedPlugins().length > 0}
                  title={_({
                    id: "app.plugin.marketplace.installedUnavailable",
                    message: "Unable to load installed plugins",
                  })}
                  description={_({
                    id: "app.plugin.marketplace.installedUnavailableDescription",
                    message: "Check the connection and retry. Any previously loaded plugins remain available.",
                  })}
                  onRetry={() => void refetchInstalledPlugins()}
                />
              </Show>

              <Show when={view() === "discover" && !searchResults.loading && registryResult()?.unavailable}>
                <EmptyState
                  compact={(registryResult()?.data.length ?? 0) > 0}
                  title={_(pluginMarketplace.registryUnavailableTitle)}
                  description={_(pluginMarketplace.registryUnavailableDescription)}
                  onRetry={() => void refetchSearchResults()}
                />
              </Show>

              <Show
                when={
                  view() === "discover" &&
                  !searchResults.loading &&
                  !registryResult()?.unavailable &&
                  (registryResult()?.data.length ?? 0) === 0
                }
              >
                <EmptyState
                  action={
                    debouncedQuery() ? (
                      <button
                        type="button"
                        class="plugin-marketplace-retry"
                        onClick={() => {
                          handleInput("")
                          searchInput?.focus()
                        }}
                      >
                        {_({ id: "app.plugin.marketplace.clearFilters", message: "Clear filters" })}
                      </button>
                    ) : undefined
                  }
                  title={
                    debouncedQuery()
                      ? _({ id: "app.plugin.marketplace.empty.noPluginsFound", message: "No plugins found" })
                      : _({ id: "app.plugin.marketplace.empty.noPluginsAvailable", message: "No plugins available" })
                  }
                  description={
                    debouncedQuery()
                      ? _({
                          id: "app.plugin.marketplace.empty.noResultsFor",
                          message: `No results for "{query}".`,
                          values: { query: debouncedQuery() },
                        })
                      : catalogSource() === "official"
                        ? _({
                            id: "app.plugin.marketplace.empty.officialEmpty",
                            message: "The official plugin registry has not returned any plugins yet.",
                          })
                        : _({
                            id: "app.plugin.marketplace.empty.localEmpty",
                            message: "No packages have been published to the local registry.",
                          })
                  }
                />
              </Show>

              <Show
                when={
                  view() !== "discover" &&
                  !installedResource.loading &&
                  !installedUnavailable() &&
                  installedList().length === 0
                }
              >
                <EmptyState
                  action={
                    debouncedQuery() ? (
                      <button
                        type="button"
                        class="plugin-marketplace-retry"
                        onClick={() => {
                          handleInput("")
                          searchInput?.focus()
                        }}
                      >
                        {_({ id: "app.plugin.marketplace.clearFilters", message: "Clear filters" })}
                      </button>
                    ) : view() === "installed" ? (
                      <button type="button" class="plugin-marketplace-retry" onClick={() => setView("discover")}>
                        {_({ id: "app.plugin.marketplace.browse", message: "Browse plugins" })}
                      </button>
                    ) : (
                      <a
                        class="plugin-marketplace-retry"
                        href="https://github.com/SII-Holos/synergy/blob/dev/docs/plugins/README.md"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {_({ id: "app.plugin.marketplace.developmentDocs", message: "Plugin development guide" })}
                      </a>
                    )
                  }
                  title={
                    debouncedQuery()
                      ? view() === "development"
                        ? _({
                            id: "app.plugin.marketplace.empty.noDevelopmentPluginsFound",
                            message: "No development plugins found",
                          })
                        : _({
                            id: "app.plugin.marketplace.empty.noInstalledPluginsFound",
                            message: "No installed plugins found",
                          })
                      : view() === "development"
                        ? _({
                            id: "app.plugin.marketplace.empty.noDevelopmentPlugins",
                            message: "No development plugins",
                          })
                        : _({
                            id: "app.plugin.marketplace.empty.noPluginsInstalled",
                            message: "No plugins installed",
                          })
                  }
                  description={
                    debouncedQuery()
                      ? _({
                          id: "app.plugin.marketplace.empty.noMatchQuery",
                          message: `No plugins match "{query}".`,
                          values: { query: debouncedQuery() },
                        })
                      : view() === "development"
                        ? _({
                            id: "app.plugin.marketplace.empty.developmentHint",
                            message: "Directory plugins registered with file:// or plugin-kit dev will appear here.",
                          })
                        : _({
                            id: "app.plugin.marketplace.empty.installedHint",
                            message: "Installed plugins will appear here regardless of where they came from.",
                          })
                  }
                />
              </Show>

              <Show when={view() === "discover" && (registryResult()?.data.length ?? 0) > 0}>
                <div class="plugin-marketplace-list" data-panel-list>
                  <For each={registryResult()?.data}>
                    {(plugin) => {
                      const installed = () =>
                        installedVersionById().get(plugin.id) ??
                        getInstalledVersion(installedPlugins() ?? [], plugin.id)
                      const rowState = (): RowState =>
                        !installed()
                          ? "available"
                          : checkUpdateAvailable(plugin.latestVersion, installed())
                            ? "update"
                            : "installed"
                      return (
                        <PluginRow
                          plugin={plugin}
                          state={rowState()}
                          installedVersion={installed()}
                          onClick={() => openPlugin(plugin.id, { source: plugin.source as RegistrySource })}
                        />
                      )
                    }}
                  </For>
                </div>
              </Show>

              <Show when={view() !== "discover" && installedList().length > 0}>
                <div class="plugin-marketplace-list" data-panel-list>
                  <For each={installedList()}>
                    {(plugin) => (
                      <InstalledPluginRow
                        plugin={plugin}
                        development={view() === "development"}
                        onClick={() =>
                          openPlugin(plugin.id, {
                            installedPlugin: plugin,
                            source: plugin.installation.kind === "registry" ? plugin.installation.registry : undefined,
                          })
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </div>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}

function PluginRow(props: {
  plugin: RegistryPluginSummary
  state: RowState
  installedVersion: string | null
  onClick: () => void
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const installStatusLabel = () => {
    if (props.state === "update") {
      return props.installedVersion
        ? _({
            id: "app.plugin.marketplace.row.updateAvailable",
            message: "Update available from v{version}",
            values: { version: props.installedVersion },
          })
        : _({ id: "app.plugin.marketplace.row.updateAvailable.generic", message: "Update available" })
    }
    if (props.installedVersion) {
      return _({
        id: "app.plugin.marketplace.row.installedVersion",
        message: "Installed v{version}",
        values: { version: props.installedVersion },
      })
    }
    return _({ id: "app.plugin.marketplace.row.available", message: "Not installed" })
  }

  return (
    <button
      type="button"
      data-panel-item={props.plugin.id}
      data-panel-focus-entry
      class="plugin-marketplace-row group"
      aria-haspopup="dialog"
      onClick={props.onClick}
    >
      <Show when={props.state !== "available"}>
        <span
          class={`plugin-marketplace-install-dot plugin-marketplace-install-dot-${props.state === "update" ? "update" : "installed"}`}
          aria-label={installStatusLabel()}
          title={installStatusLabel()}
        />
      </Show>
      <MarketplacePluginIcon plugin={props.plugin} class="plugin-marketplace-plugin-icon" />

      <span class="plugin-marketplace-row-main">
        <span class="plugin-marketplace-row-title">
          {/* plugin.name is author content — pass through */}
          <span>{props.plugin.name}</span>
        </span>
        {/* plugin.description is author content — pass through */}
        <span class="plugin-marketplace-row-description">
          {props.plugin.description ||
            _({ id: "app.plugin.detail.noDescription", message: "The author has not provided a description." })}
        </span>
      </span>

      <span class="plugin-marketplace-row-status">
        <span class="plugin-marketplace-state">{installStatusLabel()}</span>
        <VerifiedBadge verified={props.plugin.verified} official={props.plugin.official} />
      </span>
      <span class="plugin-marketplace-row-arrow">
        <Icon name={getSemanticIcon("action.view")} size="small" />
      </span>
    </button>
  )
}

function InstalledPluginRow(props: { plugin: InstalledPlugin; development: boolean; onClick: () => void }) {
  const { _ } = useLingui()
  const { controller, i18n } = useLocale()
  const localizedInstallationLabel = () => {
    controller.activeLocale()
    return translateDescriptor(installationLabel(props.plugin), i18n)
  }
  const status = () => installedPluginStatusView(props.plugin, props.development ? "development" : "installed")
  const localizedStatusLabel = () => {
    controller.activeLocale()
    return translateDescriptor(status().label, i18n)
  }
  const iconSource = () => ({
    name: props.plugin.name ?? props.plugin.id,
    keywords: ["plugin"],
  })

  return (
    <article data-panel-item={props.plugin.id} class="plugin-marketplace-row plugin-marketplace-installed-row group">
      <button
        type="button"
        data-panel-focus-entry
        class="plugin-marketplace-installed-content"
        aria-haspopup="dialog"
        onClick={props.onClick}
      >
        <MarketplacePluginIcon plugin={iconSource()} class="plugin-marketplace-plugin-icon" />
        <span class="plugin-marketplace-row-main">
          <span class="plugin-marketplace-row-title">
            {/* plugin.name is author content; id is catalog identifier */}
            <span>{props.plugin.name ?? props.plugin.id}</span>
            <span class="plugin-marketplace-version">
              {_(pluginMarketplace.versionLabel.id, { version: props.plugin.version ?? "0.0.0" })}
            </span>
          </span>
          <span class="plugin-marketplace-row-description">
            <Show
              when={status().isDisabled}
              fallback={
                // eslint-disable-next-line solid/prefer-show
                props.development && props.plugin.installation.kind === "directory" ? (
                  props.plugin.installation.path
                ) : (
                  <>
                    {_({
                      id: "app.plugin.marketplace.row.installedSummary",
                      message: "{tools} tools · {operations} operations · {ui} UI surfaces",
                      values: {
                        tools: props.plugin.tools.length,
                        operations: props.plugin.operations.length,
                        ui: props.plugin.uiContributions,
                      },
                    })}
                  </>
                )
              }
            >
              {/* disabledReason is plugin data — pass through */}
              {props.plugin.disabledReason ??
                _({ id: "app.plugin.marketplace.row.pluginDisabled", message: "Plugin disabled" })}
            </Show>
          </span>
          <span class="plugin-marketplace-row-meta">
            {/* plugin.id is catalog identifier — pass through */}
            <span>{props.plugin.id}</span>
            <span>{localizedInstallationLabel()}</span>
          </span>
        </span>
      </button>
      <span class="plugin-marketplace-row-status">
        <span
          classList={{
            "plugin-marketplace-state": true,
            "plugin-marketplace-state-installed": !status().isDisabled,
            "plugin-marketplace-state-disabled": status().isDisabled,
          }}
        >
          {localizedStatusLabel()}
        </span>
      </span>
      <button type="button" class="plugin-marketplace-maintain" aria-haspopup="dialog" onClick={props.onClick}>
        {status().canReviewPermissions
          ? _({ id: "app.plugin.detail.action.reviewPermissions", message: "Review permissions" })
          : _({ id: "app.plugin.marketplace.manage", message: "Manage" })}
      </button>
    </article>
  )
}

function EmptyState(props: {
  title: string
  description: string
  onRetry?: () => void
  compact?: boolean
  action?: import("solid-js").JSX.Element
}) {
  const { _ } = useLingui()
  return (
    <div
      class="plugin-marketplace-empty"
      classList={{ "plugin-marketplace-empty-compact": props.compact }}
      role={props.onRetry ? "alert" : undefined}
    >
      <span class="plugin-marketplace-empty-icon">
        <Icon
          name={getSemanticIcon(props.onRetry ? "state.warning" : "plugins.main")}
          size="large"
          class="text-icon-weak-base"
        />
      </span>
      <span class="plugin-marketplace-empty-title">{props.title}</span>
      <span class="plugin-marketplace-empty-description">{props.description}</span>
      {props.action}
      <Show when={props.onRetry}>
        {(onRetry) => (
          <button type="button" class="plugin-marketplace-retry" onClick={onRetry()}>
            {_(pluginMarketplace.retry)}
          </button>
        )}
      </Show>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div class="plugin-marketplace-list" data-panel-list>
      <For each={[0, 1, 2]}>{() => <div class="plugin-marketplace-skeleton-row" />}</For>
    </div>
  )
}
