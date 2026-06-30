import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { useNavigate, type RouteSectionProps } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { AppPanel } from "@/components/app-panel"
import { useGlobalSDK } from "@/context/global-sdk"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import type { ApiPluginInfo, RegistryPluginSummary } from "@ericsanchezok/synergy-sdk/client"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import { PluginDetailDialog, type RegistrySource } from "./PluginDetailDialog"
import "./marketplace.css"

type MarketplaceView = RegistrySource | "installed"
type RowState = "available" | "installed" | "update"
type MarketplacePageProps = Partial<RouteSectionProps> & {
  initialPluginId?: string
  initialSource?: RegistrySource
}

const NAV_ITEMS: { id: MarketplaceView; label: string }[] = [
  { id: "official", label: "Official" },
  { id: "installed", label: "Installed" },
  { id: "local", label: "Local" },
]

function timeAgo(ts: number | string): string {
  const timestamp = typeof ts === "number" ? ts : Date.parse(ts)
  const delta = Date.now() - (Number.isFinite(timestamp) ? timestamp : Date.now())
  const mins = Math.floor(delta / 60000)
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

export function MarketplacePage(props: MarketplacePageProps) {
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [debouncedQuery, setDebouncedQuery] = createSignal("")
  const [view, setView] = createSignal<MarketplaceView>(props.initialSource ?? "official")

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const handleInput = (value: string) => {
    setQuery(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedQuery(value), 200)
  }

  const [searchResults, { refetch: refetchSearchResults }] = createResource(
    () => (view() === "installed" ? undefined : { q: debouncedQuery(), source: view() as RegistrySource }),
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
      return (res.data as ApiPluginInfo[]) ?? []
    },
  )

  const installedVersionById = createMemo(() => {
    const map = new Map<string, string>()
    for (const plugin of installedPlugins() ?? []) {
      if (plugin.version && plugin.version !== "0.0.0") {
        map.set(plugin.pluginId, plugin.version)
      }
    }
    return map
  })

  const installedList = createMemo(() => {
    const q = normalize(debouncedQuery())
    const list = installedPlugins() ?? []
    if (!q) return list
    return list.filter((plugin) =>
      [plugin.pluginId, plugin.name, plugin.version, plugin.trustTier].some((value) => normalize(value).includes(q)),
    )
  })

  const resultCount = createMemo(() =>
    view() === "installed" ? installedList().length : (searchResults()?.length ?? 0),
  )
  const currentLabel = createMemo(() => NAV_ITEMS.find((item) => item.id === view())?.label ?? "Official")

  async function refreshMarketplace() {
    await Promise.all([refetchInstalledPlugins(), refetchSearchResults()])
  }

  function openPlugin(
    pluginId: string,
    source: RegistrySource,
    options: { closeToMarketplace?: boolean; installedPlugin?: ApiPluginInfo } = {},
  ) {
    dialog.show(
      () => (
        <PluginDetailDialog
          pluginId={pluginId}
          source={source}
          installedPlugin={options.installedPlugin}
          onChanged={() => {
            void refreshMarketplace()
          }}
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
      openPlugin(props.initialPluginId!, props.initialSource ?? "official", { closeToMarketplace: true }),
    )
  })

  return (
    <AppPanel.Root class="plugin-marketplace-workbench">
      <AppPanel.Content>
        <AppPanel.Header class="plugin-marketplace-header">
          <div class="plugin-marketplace-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>Plugins</AppPanel.Title>
            </AppPanel.HeaderRow>
            <div class="plugin-marketplace-header-controls">
              <div class="plugin-marketplace-nav">
                <AppPanel.SegmentedNav
                  items={NAV_ITEMS}
                  active={view()}
                  onChange={(id) => setView(id as MarketplaceView)}
                />
              </div>
              <div class="plugin-marketplace-search">
                <Icon name="search" size="small" class="text-icon-weak shrink-0" />
                <input
                  type="text"
                  value={query()}
                  onInput={(event) => handleInput(event.currentTarget.value)}
                  placeholder="Search plugins"
                />
                <Show when={query()}>
                  <button type="button" aria-label="Clear search" onClick={() => handleInput("")}>
                    <Icon name="x" size="small" />
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
                  <h2>{currentLabel()} plugins</h2>
                  <p>
                    <Show when={!searchResults.loading && !installedPlugins.loading} fallback="Checking plugins">
                      {resultCount()} {resultCount() === 1 ? "plugin" : "plugins"}
                      <Show when={debouncedQuery()}> matching "{debouncedQuery()}"</Show>
                    </Show>
                  </p>
                </div>
              </div>

              <Show when={view() !== "installed" && searchResults.loading}>
                <SkeletonRows />
              </Show>

              <Show when={view() === "installed" && installedPlugins.loading}>
                <SkeletonRows />
              </Show>

              <Show when={view() !== "installed" && !searchResults.loading && (searchResults()?.length ?? 0) === 0}>
                <EmptyState
                  title={debouncedQuery() ? "No plugins found" : "No plugins available"}
                  description={
                    debouncedQuery()
                      ? `No results for "${debouncedQuery()}".`
                      : view() === "official"
                        ? "The official marketplace has not returned any plugins yet."
                        : "Local development plugins will appear here once registered."
                  }
                />
              </Show>

              <Show when={view() === "installed" && !installedPlugins.loading && installedList().length === 0}>
                <EmptyState
                  title={debouncedQuery() ? "No installed plugins found" : "No plugins installed"}
                  description={
                    debouncedQuery()
                      ? `No installed plugins match "${debouncedQuery()}".`
                      : "Install a plugin from the official marketplace to see it here."
                  }
                />
              </Show>

              <Show when={view() !== "installed" && (searchResults()?.length ?? 0) > 0}>
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
                          onClick={() => openPlugin(plugin.id, plugin.source as RegistrySource)}
                        />
                      )
                    }}
                  </For>
                </div>
              </Show>

              <Show when={view() === "installed" && installedList().length > 0}>
                <div class="plugin-marketplace-list">
                  <For each={installedList()}>
                    {(plugin) => (
                      <InstalledPluginRow
                        plugin={plugin}
                        onClick={() =>
                          openPlugin(plugin.pluginId, props.initialSource ?? "local", { installedPlugin: plugin })
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
  const installStatusLabel = () =>
    props.state === "update"
      ? `Update available${props.installedVersion ? ` from v${props.installedVersion}` : ""}`
      : props.installedVersion
        ? `Installed v${props.installedVersion}`
        : "Installed"

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
          <span>{props.plugin.name}</span>
          <Show when={props.plugin.latestVersion}>
            <span class="plugin-marketplace-version">v{props.plugin.latestVersion}</span>
          </Show>
        </span>
        <span class="plugin-marketplace-row-description">{props.plugin.description}</span>
        <span class="plugin-marketplace-row-meta">
          <span>{props.plugin.author?.name ?? "Unknown author"}</span>
          <span aria-hidden="true">·</span>
          <span>{props.plugin.tools.length} tools</span>
          <span aria-hidden="true">·</span>
          <span>{props.plugin.runtimeMode}</span>
          <span aria-hidden="true">·</span>
          <span>Updated {timeAgo(props.plugin.updatedAt)}</span>
        </span>
      </span>

      <span class="plugin-marketplace-row-status">
        <VerifiedBadge verified={props.plugin.verified} official={props.plugin.official} />
        <PermissionRiskBadge risk={props.plugin.risk} />
      </span>
      <Icon name="chevron-right" size="small" class="plugin-marketplace-row-arrow" />
    </button>
  )
}

function InstalledPluginRow(props: { plugin: ApiPluginInfo; onClick: () => void }) {
  const iconSource = () => ({
    name: props.plugin.name ?? props.plugin.pluginId,
    keywords: ["plugin"],
  })

  return (
    <button type="button" class="plugin-marketplace-row group" onClick={props.onClick}>
      <MarketplacePluginIcon plugin={iconSource()} class="plugin-marketplace-plugin-icon" />
      <span class="plugin-marketplace-row-main">
        <span class="plugin-marketplace-row-title">
          <span>{props.plugin.name ?? props.plugin.pluginId}</span>
          <span class="plugin-marketplace-version">v{props.plugin.version ?? "0.0.0"}</span>
        </span>
        <span class="plugin-marketplace-row-description">
          {props.plugin.skillCount} skills · {props.plugin.agentCount} agents · {props.plugin.cliCommands.length}{" "}
          commands
        </span>
        <span class="plugin-marketplace-row-meta">
          <span>{props.plugin.trustTier}</span>
          <span aria-hidden="true">·</span>
          <span>{props.plugin.pluginId}</span>
        </span>
      </span>
      <span class="plugin-marketplace-row-status">
        <span class="plugin-marketplace-state plugin-marketplace-state-installed">Installed</span>
      </span>
      <Icon name="chevron-right" size="small" class="plugin-marketplace-row-arrow" />
    </button>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div class="plugin-marketplace-empty">
      <span class="plugin-marketplace-empty-icon">
        <Icon name="package" size="large" class="text-icon-weak" />
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
