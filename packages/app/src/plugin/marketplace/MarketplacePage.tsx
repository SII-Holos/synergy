import { createSignal, createResource, For, Show, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import type { RegistryPluginSummary } from "@ericsanchezok/synergy-sdk/client"

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

function pluginOverallRisk(plugin: RegistryPluginSummary): "low" | "medium" | "high" {
  // If the latest version has a known risk, use it
  // Otherwise do keyword-based heuristic
  const keywords = plugin.keywords ?? []
  const lower = keywords.map((k) => k.toLowerCase())
  if (lower.some((k) => k.includes("filesystem") || k.includes("shell") || k.includes("exec"))) return "high"
  if (lower.some((k) => k.includes("network") || k.includes("api"))) return "medium"
  return "low"
}

// ── Component ────────────────────────────────────────────────────────────────

export function MarketplacePage() {
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [debouncedQuery, setDebouncedQuery] = createSignal("")

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const handleInput = (value: string) => {
    setQuery(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedQuery(value), 250)
  }

  const [searchResults] = createResource(
    () => debouncedQuery(),
    async (q) => {
      const res = await globalSDK.client.registry.plugins.search({ q: q || undefined, limit: 50 })
      return (res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []
    },
  )

  const isEmpty = createMemo(() => {
    const results = searchResults()
    return results !== undefined && results.length === 0
  })

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* ── Header ── */}
      <div class="shrink-0 px-6 pt-6 pb-3 flex flex-col gap-3.5 border-b border-border-weaker-base/40">
        <div class="flex items-center gap-2">
          <Icon name="package-open" size="normal" class="text-icon-weak shrink-0" />
          <span class="text-15-medium text-text-strong flex-1">Plugin Marketplace</span>
        </div>
        <p class="text-12-regular text-text-weak -mt-1">Browse and install plugins for Synergy</p>
        {/* ── Search bar ── */}
        <div class="relative">
          <Icon
            name="search"
            size="small"
            class="absolute left-3 top-1/2 -translate-y-1/2 text-icon-weak pointer-events-none"
          />
          <input
            type="text"
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            placeholder="Search plugins..."
            class="w-full pl-9 pr-4 py-2 rounded-lg bg-surface-inset-base text-text-base text-13-regular border border-border-weaker-base/40 focus:outline-none focus:ring-2 focus:ring-border-action/30 placeholder:text-text-weaker transition-colors"
          />
        </div>
      </div>

      {/* ── Results ── */}
      <div class="flex-1 min-h-0 overflow-y-auto px-6 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Loading */}
        <Show when={searchResults.loading}>
          <div class="flex items-center justify-center py-16">
            <div class="size-5 rounded-full border-2 border-border-weaker-base border-t-text-base animate-spin" />
          </div>
        </Show>

        {/* Empty state */}
        <Show when={isEmpty()}>
          <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Icon name="package-open" size="large" class="text-icon-weak" />
            <div>
              <p class="text-14-medium text-text-weak">
                {debouncedQuery() ? "No plugins found" : "No plugins available"}
              </p>
              <p class="text-12-regular text-text-weaker mt-1 max-w-64">
                {debouncedQuery()
                  ? `No results for "${debouncedQuery()}". Try a different search term.`
                  : "The plugin marketplace is empty. Plugins will appear here once published."}
              </p>
            </div>
          </div>
        </Show>

        {/* Results grid */}
        <Show when={searchResults() && searchResults()!.length > 0}>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
            <For each={searchResults()}>
              {(plugin) => (
                <button
                  type="button"
                  class="flex flex-col gap-3 px-4 py-3.5 rounded-xl text-left w-full transition-colors bg-surface-raised-base hover:bg-surface-raised-base-hover cursor-pointer ring-1 ring-transparent hover:ring-border-action/20"
                  onClick={() => navigate(`/plugins/${encodeURIComponent(plugin.id)}`)}
                >
                  {/* Top row: name + badges */}
                  <div class="flex items-start gap-2">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <h3 class="text-14-medium text-text-strong truncate">{plugin.name}</h3>
                        <Show when={plugin.latestVersion}>
                          <span class="text-11-medium text-text-weaker bg-surface-inset-base rounded px-1.5 py-px shrink-0">
                            v{plugin.latestVersion}
                          </span>
                        </Show>
                      </div>
                      <p class="text-12-regular text-text-weak mt-1 line-clamp-2">{plugin.description}</p>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <VerifiedBadge verified={plugin.verified} official={plugin.official} />
                      <PermissionRiskBadge risk={pluginOverallRisk(plugin)} />
                    </div>
                  </div>

                  {/* Bottom row: author + time */}
                  <div class="flex items-center gap-3 text-11-regular text-text-weaker">
                    <span class="flex items-center gap-1">
                      <Icon name="user" size="small" class="text-icon-weaker" />
                      {plugin.author?.name ?? "Unknown"}
                    </span>
                    <span>•</span>
                    <span>Updated {timeAgo(plugin.updatedAt)}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
