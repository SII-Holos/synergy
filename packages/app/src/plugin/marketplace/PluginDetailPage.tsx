import { createSignal, createResource, For, Show, Switch, Match, createMemo } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import { PermissionDiffList } from "../consent/PermissionDiffList"
import { TrustTierExplanation } from "../consent/TrustTierExplanation"
import { InstallConsentDialog } from "../consent/InstallConsentDialog"
import type {
  RegistryPluginSummary,
  RegistryPluginVersion,
  RegistryPermissionItem,
  ApiPluginInfo,
} from "@ericsanchezok/synergy-sdk/client"
import type { PermissionItem, PluginPermissionDiff, TrustTier, PermissionSeverity } from "../consent/schema"
import { computeVersionDiffs } from "./changelog-utils"
import { ratingStars } from "./rating-stars"
import { StarRating } from "./StarRating"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const delta = Date.now() - ts
  const mins = Math.floor(delta / 60000)
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** Convert SDK RegistryPermissionItem → consent PermissionItem for PermissionDiffList. */
function toConsentPermission(sp: RegistryPermissionItem): PermissionItem {
  const cat = detectCategory(sp.key)
  return {
    key: sp.key,
    category: cat,
    severity: sp.risk as PermissionSeverity,
    title: sp.key.replace(/^permissions\./, "").replace(/\./g, " "),
    description: sp.description,
    technical: `permission key: ${sp.key}`,
  }
}

function detectCategory(key: string): PermissionItem["category"] {
  if (key.includes("tool.") || key.includes("shell") || key.includes("exec")) return "tools"
  if (key.includes("file.") || key.includes("fs") || key.includes("read") || key.includes("write")) return "files"
  if (key.includes("network") || key.includes("http") || key.includes("fetch") || key.includes("connect"))
    return "network"
  if (key.includes("data") || key.includes("db") || key.includes("storage")) return "data"
  if (key.includes("ui") || key.includes("view") || key.includes("panel")) return "ui"
  if (key.includes("runtime") || key.includes("process") || key.includes("hook")) return "runtime"
  return "tools"
}

function collectAllPermissions(versions: RegistryPluginVersion[]): RegistryPermissionItem[] {
  const seen = new Set<string>()
  const all: RegistryPermissionItem[] = []
  for (const v of versions) {
    for (const p of v.permissionsSummary ?? []) {
      if (!seen.has(p.key)) {
        seen.add(p.key)
        all.push(p)
      }
    }
  }
  return all
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "overview", label: "Overview", icon: "info" as const },
  { id: "permissions", label: "Permissions", icon: "shield-check" as const },
  { id: "versions", label: "Versions", icon: "history" as const },
  { id: "changelog", label: "Changelog", icon: "scroll-text" as const },
  { id: "reviews", label: "Reviews", icon: "message-square" as const },
] as const

// ── Component ────────────────────────────────────────────────────────────────

export function PluginDetailPage() {
  const params = useParams<{ pluginId: string }>()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const dialog = useDialog()

  const pluginId = () => decodeURIComponent(params.pluginId)

  const [activeTab, setActiveTab] = createSignal<string>("overview")
  const [installing, setInstalling] = createSignal(false)

  // Fetch plugin summary from search (registry has no direct GET /:id in SDK)
  const [summary] = createResource(pluginId, async (id: string) => {
    const res = await globalSDK.client.registry.plugins.search({ q: id, limit: 5 })
    const plugins = (res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []
    return plugins.find((p: RegistryPluginSummary) => p.id === id || p.name === id) ?? null
  })

  // Fetch versions from registry
  const [versions] = createResource(pluginId, async (id: string) => {
    const res = await globalSDK.client.registry.plugins.versions({ id })
    return (res.data as RegistryPluginVersion[]) ?? []
  })

  const latestVersion = createMemo(() => {
    const v = versions()
    if (!v?.length) return null
    return [...v].toSorted((a, b) => b.publishedAt - a.publishedAt)[0]
  })

  const allPermissions = createMemo(() => {
    const v = versions()
    if (!v) return []
    return collectAllPermissions(v)
  })

  const changelogEntries = createMemo(() => {
    const v = versions()
    if (!v?.length) return []
    return computeVersionDiffs(v).toReversed()
  })

  // ── Fetch installed plugins ─────────────────────────────────────────

  const [installedPlugins] = createResource(
    () => true,
    async () => {
      const res = await globalSDK.client.api.plugins.list()
      return (res.data as ApiPluginInfo[]) ?? []
    },
  )

  const installedVersion = createMemo(() => {
    const plugins = installedPlugins()
    const id = pluginId()
    if (!plugins || !id) return null
    return getInstalledVersion(plugins, id)
  })

  const updateAvailable = createMemo(() => {
    const latest = latestVersion()
    const installed = installedVersion()
    if (!latest) return false
    return checkUpdateAvailable(latest.version, installed)
  })

  // ── Install flow ──────────────────────────────────────────────────────

  const handleInstall = async () => {
    const p = summary()
    const v = latestVersion()
    if (!p || !v) return

    setInstalling(true)

    try {
      await globalSDK.client.api.plugins.installFromRegistry({ id: p.id, version: v.version })
    } catch (err) {
      console.error("Install failed:", err)
    } finally {
      setInstalling(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  const isLoading = () => summary.loading || versions.loading
  const isError = () => summary.error || versions.error
  const errorMessage = () => String(summary.error ?? versions.error ?? "Unknown error")
  const pluginData = () => summary()

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* ── Header ── */}
      <div class="shrink-0 px-6 pt-6 pb-3 border-b border-border-weaker-base/40">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors shrink-0"
                onClick={() => navigate("/plugins/marketplace")}
                aria-label="Back to marketplace"
              >
                <Icon name="arrow-left" size="small" />
              </button>
              <h1 class="text-15-medium text-text-strong truncate">{pluginData()?.name ?? pluginId()}</h1>
              <Show when={pluginData()}>
                <VerifiedBadge verified={pluginData()!.verified} official={pluginData()!.official} />
              </Show>
            </div>
            <p class="text-12-regular text-text-weak mt-1">{pluginData()?.description}</p>
          </div>

          {/* Install / Update button */}
          <Show
            when={!installedVersion()}
            fallback={
              <Show
                when={updateAvailable()}
                fallback={
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-13-medium bg-surface-success-soft text-text-success disabled:opacity-50 transition-colors disabled:cursor-not-allowed"
                    disabled
                  >
                    <Icon name="check-circle" size="small" />
                    Installed v{installedVersion()}
                  </button>
                }
              >
                <button
                  type="button"
                  class="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-13-medium bg-surface-warning-soft text-text-warning hover:bg-surface-warning-softer disabled:opacity-50 transition-colors disabled:cursor-not-allowed"
                  disabled={!pluginData() || installing()}
                  onClick={handleInstall}
                >
                  <Icon
                    name={installing() ? "loader-2" : "arrow-up-circle"}
                    size="small"
                    class={installing() ? "animate-spin" : ""}
                  />
                  {installing() ? "Updating..." : `Update to v${latestVersion()?.version ?? ""}`}
                </button>
              </Show>
            }
          >
            <button
              type="button"
              class="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-13-medium bg-surface-action text-text-on-primary hover:bg-surface-action-hover disabled:opacity-50 transition-colors disabled:cursor-not-allowed"
              disabled={!pluginData() || installing()}
              onClick={handleInstall}
            >
              <Icon
                name={installing() ? "loader-2" : "download"}
                size="small"
                class={installing() ? "animate-spin" : ""}
              />
              {installing() ? "Installing..." : "Install"}
            </button>
          </Show>
        </div>

        {/* Tab bar */}
        <div class="flex items-center gap-0.5 mt-4 -mb-px">
          <For each={TABS}>
            {(tab) => (
              <button
                type="button"
                classList={{
                  "px-3.5 py-2 text-13-medium border-b-2 transition-colors": true,
                  "border-text-action text-text-strong": activeTab() === tab.id,
                  "border-transparent text-text-weak hover:text-text-base": activeTab() !== tab.id,
                }}
                onClick={() => setActiveTab(tab.id)}
              >
                <span class="flex items-center gap-1.5">
                  <Icon name={tab.icon} size="small" />
                  {tab.label}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* ── Loading ── */}
      <Show when={isLoading()}>
        <div class="flex items-center justify-center py-16">
          <div class="size-5 rounded-full border-2 border-border-weaker-base border-t-text-base animate-spin" />
        </div>
      </Show>

      {/* ── Error ── */}
      <Show when={!isLoading() && isError()}>
        <div class="flex flex-col items-center justify-center py-16 gap-3">
          <Icon name="alert-triangle" size="large" class="text-icon-critical-base" />
          <p class="text-14-medium text-text-weak">Failed to load plugin</p>
          <p class="text-12-regular text-text-weaker">{errorMessage()}</p>
        </div>
      </Show>

      {/* ── Not found ── */}
      <Show when={!isLoading() && !isError() && !pluginData()}>
        <div class="flex flex-col items-center justify-center py-16 gap-3">
          <Icon name="package-search" size="large" class="text-icon-weak" />
          <p class="text-14-medium text-text-weak">Plugin not found</p>
          <p class="text-12-regular text-text-weaker">"{pluginId()}" does not exist in the registry.</p>
        </div>
      </Show>

      {/* ── Tab content ── */}
      <Show when={pluginData()}>
        <div class="flex-1 min-h-0 overflow-y-auto px-6 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Switch>
            {/* ── Overview ── */}
            <Match when={activeTab() === "overview"}>
              <div class="flex flex-col gap-5 pt-5">
                {/* Meta grid */}
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <MetaBox icon="tag" label="Latest Version" value={latestVersion()?.version ?? "—"} />
                  <MetaBox icon="user" label="Author" value={pluginData()!.author?.name ?? "Unknown"} />
                  <MetaBox
                    icon="shield-check"
                    label="Risk Level"
                    value={<PermissionRiskBadge risk={(latestVersion()?.risk as PermissionSeverity) ?? "low"} />}
                  />
                  <MetaBox icon="calendar" label="Updated" value={timeAgo(pluginData()!.updatedAt)} />
                  <MetaBox icon="download" label="Downloads" value={pluginData()!.downloads?.toLocaleString() ?? "0"} />
                  <MetaBox icon="star" label="Rating" value={<StarRating rating={pluginData()!.rating} />} />
                </div>

                {/* Description */}
                <div>
                  <h3 class="text-12-medium text-text-weak uppercase tracking-wider mb-2">About</h3>
                  <p class="text-13-regular text-text-base leading-relaxed whitespace-pre-wrap">
                    {pluginData()!.description || "No description provided."}
                  </p>
                </div>

                {/* Keywords */}
                <Show when={pluginData()!.keywords?.length > 0}>
                  <div>
                    <h3 class="text-12-medium text-text-weak uppercase tracking-wider mb-2">Keywords</h3>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={pluginData()!.keywords}>
                        {(kw) => (
                          <span class="text-11-medium text-text-weak bg-surface-inset-base rounded-full px-2.5 py-0.5">
                            {kw}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Trust tier */}
                <div>
                  <h3 class="text-12-medium text-text-weak uppercase tracking-wider mb-2">Trust Model</h3>
                  <TrustTierExplanation tier="trusted-import" />
                </div>
              </div>
            </Match>

            {/* ── Permissions ── */}
            <Match when={activeTab() === "permissions"}>
              <div class="pt-5">
                <Show
                  when={allPermissions().length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center py-16 gap-3">
                      <Icon name="shield-check" size="large" class="text-icon-weak" />
                      <p class="text-14-medium text-text-weak">No permissions declared</p>
                      <p class="text-12-regular text-text-weaker">
                        This plugin does not request any special permissions.
                      </p>
                    </div>
                  }
                >
                  <PermissionDiffList items={allPermissions().map(toConsentPermission)} mode="added" />
                </Show>
              </div>
            </Match>

            {/* ── Versions ── */}
            <Match when={activeTab() === "versions"}>
              <div class="flex flex-col gap-2 pt-5">
                <Show
                  when={versions() && versions()!.length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center py-16 gap-3">
                      <Icon name="history" size="large" class="text-icon-weak" />
                      <p class="text-14-medium text-text-weak">No versions available</p>
                    </div>
                  }
                >
                  <For each={[...versions()!].toSorted((a, b) => b.publishedAt - a.publishedAt)}>
                    {(ver) => (
                      <div class="flex items-start gap-4 px-4 py-3 rounded-xl bg-surface-raised-base">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="text-14-medium text-text-strong">v{ver.version}</span>
                            <PermissionRiskBadge risk={ver.risk as PermissionSeverity} />
                          </div>
                          <Show when={ver.changelog}>
                            <p class="text-12-regular text-text-weak mt-1 line-clamp-2">{ver.changelog}</p>
                          </Show>
                          <div class="flex items-center gap-3 mt-2 text-11-regular text-text-weaker">
                            <span>Published {formatDate(ver.publishedAt)}</span>
                            <span>•</span>
                            <span>{ver.permissionsSummary?.length ?? 0} permissions</span>
                            <Show when={ver.signature}>
                              <span>•</span>
                              <span class="text-text-success">Signed</span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Match>

            {/* ── Changelog ── */}
            <Match when={activeTab() === "changelog"}>
              <div class="flex flex-col gap-4 pt-5">
                <Show
                  when={changelogEntries().length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center py-16 gap-3">
                      <Icon name="scroll-text" size="large" class="text-icon-weak" />
                      <p class="text-14-medium text-text-weak">No versions available</p>
                      <p class="text-12-regular text-text-weaker">
                        Versions must be published before changelogs appear.
                      </p>
                    </div>
                  }
                >
                  <For each={changelogEntries()}>
                    {(entry) => (
                      <div class="flex flex-col gap-3 p-4 rounded-xl bg-surface-raised-base">
                        {/* Version header */}
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex items-center gap-2">
                            <span class="text-14-medium text-text-strong">v{entry.version}</span>
                            <PermissionRiskBadge risk={entry.risk as PermissionSeverity} />
                          </div>
                          <span class="text-11-regular text-text-weaker">{formatDate(entry.publishedAt)}</span>
                        </div>

                        {/* Changelog text */}
                        <Show when={entry.changelog}>
                          <div class="rounded-lg bg-surface-inset-base px-3 py-2">
                            <p class="text-12-regular text-text-weak whitespace-pre-wrap leading-relaxed">
                              {entry.changelog}
                            </p>
                          </div>
                        </Show>

                        {/* Permission summary */}
                        <div class="flex flex-col gap-1">
                          <p class="text-11-medium text-text-weaker uppercase tracking-wider mb-1">
                            Permission Changes
                          </p>
                          <Show
                            when={
                              entry.added.length +
                                entry.removed.length +
                                entry.changed.length +
                                entry.unchanged.length >
                              0
                            }
                            fallback={
                              <p class="text-12-regular text-text-weaker">No permission changes in this version.</p>
                            }
                          >
                            <div class="flex flex-wrap gap-1.5 text-11-medium">
                              <Show when={entry.added.length > 0}>
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-success-soft text-text-success">
                                  <Icon name="plus" size="small" />
                                  {entry.added.length} added
                                </span>
                              </Show>
                              <Show when={entry.removed.length > 0}>
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-critical-soft text-text-critical">
                                  <Icon name="minus" size="small" />
                                  {entry.removed.length} removed
                                </span>
                              </Show>
                              <Show when={entry.changed.length > 0}>
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-warning-soft text-text-warning">
                                  <Icon name="arrow-up-down" size="small" />
                                  {entry.changed.length} changed
                                </span>
                              </Show>
                            </div>

                            {/* Added permissions details */}
                            <Show when={entry.added.length > 0}>
                              <div class="mt-3 rounded-lg bg-surface-inset-base px-3 py-2">
                                <p class="text-11-medium text-text-success mb-1.5 uppercase tracking-wider">
                                  Added ({entry.added.length})
                                </p>
                                <ul class="flex flex-col gap-1">
                                  <For each={entry.added}>
                                    {(perm) => (
                                      <li class="flex items-start gap-1.5 text-12-regular text-text-base">
                                        <span class="text-text-success shrink-0 mt-0.5">+</span>
                                        <span class="min-w-0">
                                          <span class="text-text-strong">{perm.key}</span>
                                          <Show when={perm.description}>
                                            <span class="text-text-weak"> — {perm.description}</span>
                                          </Show>
                                        </span>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                              </div>
                            </Show>

                            {/* Removed permissions details */}
                            <Show when={entry.removed.length > 0}>
                              <div class="mt-2 rounded-lg bg-surface-inset-base px-3 py-2">
                                <p class="text-11-medium text-text-critical mb-1.5 uppercase tracking-wider">
                                  Removed ({entry.removed.length})
                                </p>
                                <ul class="flex flex-col gap-1">
                                  <For each={entry.removed}>
                                    {(perm) => (
                                      <li class="flex items-start gap-1.5 text-12-regular text-text-weak opacity-70">
                                        <span class="text-text-weaker shrink-0 mt-0.5">−</span>
                                        <span class="min-w-0 line-through">{perm.key}</span>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                              </div>
                            </Show>

                            {/* Changed permissions details */}
                            <Show when={entry.changed.length > 0}>
                              <div class="mt-2 rounded-lg bg-surface-inset-base px-3 py-2">
                                <p class="text-11-medium text-text-warning mb-1.5 uppercase tracking-wider">
                                  Changed ({entry.changed.length})
                                </p>
                                <ul class="flex flex-col gap-1">
                                  <For each={entry.changed}>
                                    {(ch) => (
                                      <li class="flex items-start gap-1.5 text-12-regular">
                                        <span class="text-text-warning shrink-0 mt-0.5">↔</span>
                                        <span class="min-w-0">
                                          <span class="text-text-strong">{ch.key}</span>
                                          <span class="text-text-weak">
                                            {" "}
                                            <span class="uppercase">{ch.before}</span> →{" "}
                                            <span class="uppercase">{ch.after}</span>
                                          </span>
                                        </span>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Match>

            {/* ── Reviews ── */}
            <Match when={activeTab() === "reviews"}>
              <div class="flex flex-col gap-4 pt-5">
                {/* Rating summary card */}
                <div class="flex items-center gap-6 p-4 rounded-xl bg-surface-raised-base">
                  <div class="flex flex-col items-center gap-1 min-w-[80px]">
                    <span class="text-28-medium text-text-strong leading-none">
                      {pluginData()!.rating?.toFixed(1) ?? "—"}
                    </span>
                    <StarRating rating={pluginData()!.rating} />
                    <span class="text-11-regular text-text-weaker">
                      {(pluginData() as any).ratingCount != null
                        ? `${(pluginData() as any).ratingCount} reviews`
                        : "No ratings yet"}
                    </span>
                  </div>
                  {/* Rating distribution bars (skeleton) */}
                  <div class="flex-1 flex flex-col gap-1.5">
                    {[5, 4, 3, 2, 1].map((star) => (
                      <div class="flex items-center gap-1.5">
                        <span class="text-11-regular text-text-weaker w-5 text-right">{star}</span>
                        <Icon name="star" size="small" class="text-text-weaker/40" />
                        <div class="flex-1 h-1.5 rounded-full bg-surface-inset-base overflow-hidden">
                          <div class="h-full rounded-full bg-surface-inset-base" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Reviews list skeleton */}
                <div class="flex flex-col items-center justify-center py-12 gap-3">
                  <Icon name="message-square" size="large" class="text-icon-weak" />
                  <p class="text-14-medium text-text-weak">No reviews yet</p>
                  <p class="text-12-regular text-text-weaker max-w-64 text-center">
                    Reviews will appear here once users rate this plugin after installation.
                  </p>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MetaBox(props: { icon: string; label: string; value: unknown }) {
  return (
    <div class="flex flex-col gap-1 p-3 rounded-xl bg-surface-inset-base">
      <span class="text-11-medium text-text-weaker uppercase tracking-wider flex items-center gap-1">
        <Icon name={props.icon as Parameters<typeof Icon>[0]["name"]} size="small" class="text-icon-weaker" />
        {props.label}
      </span>
      <span class="text-13-medium text-text-base">
        {props.value as string | Parameters<typeof Icon>[0]["children"]}
      </span>
    </div>
  )
}
