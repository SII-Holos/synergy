import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { pluginMarketplace } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import { useNavigate, type RouteSectionProps } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { AppPanel } from "@/components/app-panel"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale } from "@/context/locale"

import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import type { RegistryPluginSummary } from "@ericsanchezok/synergy-sdk/client"
import type { InstalledPlugin } from "./types"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import { PluginDetailDialog, type RegistrySource } from "./PluginDetailDialog"
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

  const [searchResults, { refetch: refetchSearchResults }] = createResource(
    () => (view() === "discover" ? { q: debouncedQuery(), source: catalogSource() } : undefined),
    async (input) => {
      const res = await globalSDK.client.registry.plugins.search({
        q: input.q || undefined,
        limit: 50,
        source: input.source,
      })
      return (res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []
    },
  )

  const [installedPlugins, { refetch: refetchInstalledPlugins }] = createResource(
    () => true,
    async () => {
      const res = await globalSDK.client.api.plugins.list()
      return (res.data as InstalledPlugin[]) ?? []
    },
  )

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
    view() === "discover" ? (searchResults()?.length ?? 0) : installedList().length,
  )
  const currentLabel = createMemo(
    () => localizedNavItems().find((item) => item.id === view())?.label ?? _(pluginMarketplace.navDiscover),
  )

  async function refreshMarketplace() {
    await Promise.all([refetchInstalledPlugins(), refetchSearchResults()])
  }

  function openPlugin(
    pluginId: string,
    options: { source?: RegistrySource; closeToMarketplace?: boolean; installedPlugin?: InstalledPlugin } = {},
  ) {
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
            <div class="plugin-marketplace-header-controls">
              <div class="plugin-marketplace-nav">
                <AppPanel.SegmentedNav
                  items={localizedNavItems()}
                  active={view()}
                  onChange={(id) => setView(id as MarketplaceView)}
                />
              </div>
              <div class="plugin-marketplace-search">
                <Icon name={getSemanticIcon("action.search")} size="small" class="text-icon-weak-base shrink-0" />
                <input
                  type="text"
                  value={query()}
                  onInput={(event) => handleInput(event.currentTarget.value)}
                  placeholder={_({ id: "app.plugin.marketplace.searchPlaceholder", message: "Search plugins" })}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    aria-label={_({ id: "app.plugin.marketplace.clearSearch", message: "Clear search" })}
                    onClick={() => handleInput("")}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </AppPanel.Header>

        <AppPanel.Body padding={false} class="plugin-marketplace-body">
          <div class="plugin-marketplace-stage">
            <section class="plugin-marketplace-list-panel">
              <div class="plugin-marketplace-list-heading">
                <div>
                  <h2>
                    {_({
                      id: "app.plugin.marketplace.heading.label",
                      message: "{label} plugins",
                      values: { label: currentLabel() },
                    })}
                  </h2>
                  <p>
                    <Show
                      when={!searchResults.loading && !installedPlugins.loading}
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
                <Show when={view() === "discover"}>
                  <div
                    class="plugin-marketplace-source-filter"
                    aria-label={_({ id: "app.plugin.marketplace.catalogSource", message: "Plugin catalog source" })}
                  >
                    <button
                      type="button"
                      aria-pressed={catalogSource() === "official"}
                      classList={{ active: catalogSource() === "official" }}
                      onClick={() => setCatalogSource("official")}
                    >
                      {_({ id: "app.plugin.marketplace.source.official", message: "Official" })}
                    </button>
                    <button
                      type="button"
                      aria-pressed={catalogSource() === "local"}
                      classList={{ active: catalogSource() === "local" }}
                      onClick={() => setCatalogSource("local")}
                    >
                      {_({ id: "app.plugin.marketplace.source.localRegistry", message: "Local registry" })}
                    </button>
                  </div>
                </Show>
              </div>

              <Show when={view() === "discover" && searchResults.loading}>
                <SkeletonRows />
              </Show>

              <Show when={view() !== "discover" && installedPlugins.loading}>
                <SkeletonRows />
              </Show>

              <Show when={view() === "discover" && !searchResults.loading && (searchResults()?.length ?? 0) === 0}>
                <EmptyState
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

              <Show when={view() !== "discover" && !installedPlugins.loading && installedList().length === 0}>
                <EmptyState
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

              <Show when={view() === "discover" && (searchResults()?.length ?? 0) > 0}>
                <div class="plugin-marketplace-list">
                  <For each={searchResults()}>
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
                <div class="plugin-marketplace-list">
                  <For each={installedList()}>
                    {(plugin) => (
                      <InstalledPluginRow
                        plugin={plugin}
                        development={view() === "development"}
                        onClick={() => openPlugin(plugin.id, { installedPlugin: plugin })}
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
    return _({ id: "app.plugin.marketplace.row.installed", message: "Installed" })
  }

  return (
    <button type="button" class="plugin-marketplace-row group" onClick={props.onClick}>
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
          <Show when={props.plugin.latestVersion}>
            <span class="plugin-marketplace-version">
              {_(pluginMarketplace.versionLabel.id, { version: props.plugin.latestVersion })}
            </span>
          </Show>
        </span>
        {/* plugin.description is author content — pass through */}
        <span class="plugin-marketplace-row-description">{props.plugin.description}</span>
        <span class="plugin-marketplace-row-meta">
          {/* plugin.author.name is author content — fallback is host chrome */}
          <span>
            {props.plugin.author?.name ??
              _({ id: "app.plugin.marketplace.row.unknownAuthor", message: "Unknown author" })}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {_({
              id: "app.plugin.marketplace.row.tools",
              message: "{count} tools",
              values: { count: props.plugin.tools.length },
            })}
          </span>
          <span aria-hidden="true">·</span>
          {/* plugin.runtimeMode is catalog data — pass through */}
          <span>{props.plugin.runtimeMode}</span>
          <span>
            {_({
              id: "app.plugin.marketplace.row.updated",
              message: "Updated {time}",
              values: { time: fmt.relative(new Date(props.plugin.updatedAt)) },
            })}
          </span>
        </span>
      </span>

      <span class="plugin-marketplace-row-status">
        <VerifiedBadge verified={props.plugin.verified} official={props.plugin.official} />
        <PermissionRiskBadge risk={props.plugin.risk} />
      </span>
      <Icon name={getSemanticIcon("navigation.expand")} size="small" class="plugin-marketplace-row-arrow" />
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
  const iconSource = () => ({
    name: props.plugin.name ?? props.plugin.id,
    keywords: ["plugin"],
  })

  return (
    <button type="button" class="plugin-marketplace-row group" onClick={props.onClick}>
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
          <span aria-hidden="true">·</span>
          <span>{localizedInstallationLabel()}</span>
          <Show when={props.plugin.apiVersion}>
            <span aria-hidden="true">·</span>
            <span>{_(pluginMarketplace.apiVersionLabel.id, { version: props.plugin.apiVersion })}</span>
          </Show>
          <Show when={props.plugin.generation}>
            {(generation) => (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {_({
                    id: "app.plugin.marketplace.generation.label",
                    message: "Generation {id}",
                    values: { id: generation().slice(0, 8) },
                  })}
                </span>
              </>
            )}
          </Show>
        </span>
      </span>
      <span class="plugin-marketplace-row-status">
        <span
          classList={{
            "plugin-marketplace-state": true,
            "plugin-marketplace-state-installed": !status().isDisabled,
            "plugin-marketplace-state-disabled": status().isDisabled,
          }}
        >
          {status().label}
        </span>
      </span>
      <Icon name={getSemanticIcon("navigation.expand")} size="small" class="plugin-marketplace-row-arrow" />
    </button>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div class="plugin-marketplace-empty">
      <span class="plugin-marketplace-empty-icon">
        <Icon name={getSemanticIcon("plugins.main")} size="large" class="text-icon-weak-base" />
      </span>
      <span class="plugin-marketplace-empty-title">{props.title}</span>
      <span class="plugin-marketplace-empty-description">{props.description}</span>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div class="plugin-marketplace-list">
      <For each={[0, 1, 2]}>{() => <div class="plugin-marketplace-skeleton-row" />}</For>
    </div>
  )
}
