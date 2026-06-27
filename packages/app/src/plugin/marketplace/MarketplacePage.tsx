import { createSignal, createResource, For, Show, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import type { RegistryPluginSummary } from "@ericsanchezok/synergy-sdk/client"
import "./marketplace.css"

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

function pluginIcon(plugin: RegistryPluginSummary) {
  const keywords = plugin.keywords.map((item) => item.toLowerCase())
  if (keywords.some((item) => item.includes("image") || item.includes("meme"))) return "image"
  if (keywords.some((item) => item.includes("frontend") || item.includes("ui"))) return "layout-grid"
  if (keywords.some((item) => item.includes("hash") || item.includes("password") || item.includes("id")))
    return "fingerprint"
  return "package"
}

// ── Component ────────────────────────────────────────────────────────────────

export function MarketplacePage() {
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [debouncedQuery, setDebouncedQuery] = createSignal("")
  const [source, setSource] = createSignal<"official" | "local">("official")

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const handleInput = (value: string) => {
    setQuery(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebouncedQuery(value), 250)
  }

  const [searchResults] = createResource(
    () => ({ q: debouncedQuery(), source: source() }),
    async ({ q, source }) => {
      const res = await globalSDK.client.registry.plugins.search({ q: q || undefined, limit: 50, source })
      return (res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []
    },
  )

  const isEmpty = createMemo(() => {
    const results = searchResults()
    return results !== undefined && results.length === 0
  })

  const resultCount = createMemo(() => searchResults()?.length ?? 0)

  return (
    <div class="synergy-workbench-canvas plugin-marketplace-page flex h-full min-h-0 flex-col bg-background-stronger text-text-base">
      <div class="plugin-marketplace-scroll flex-1 min-h-0 overflow-y-auto px-5 py-7 sm:px-6">
        <div class="plugin-marketplace-shell mx-auto flex w-full max-w-[760px] flex-col gap-5">
          <header class="flex flex-col gap-4">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="flex items-center gap-2.5">
                  <span class="plugin-marketplace-icon-tile">
                    <Icon name="package" size="normal" class="text-icon-weak" />
                  </span>
                  <h1 class="text-18-medium text-text-strong">Plugins</h1>
                </div>
                <p class="mt-1 text-13-regular leading-relaxed text-text-weak">
                  Browse trusted extensions that add tools, agents, UI surfaces, and workflows to Synergy.
                </p>
              </div>

              <div class="plugin-marketplace-source-switch inline-flex shrink-0 items-center rounded-xl bg-surface-inset-base p-0.5 ring-1 ring-inset ring-border-weaker-base/55">
                <For each={["official", "local"] as const}>
                  {(item) => (
                    <button
                      type="button"
                      classList={{
                        "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-12-medium transition-colors": true,
                        "workbench-selected-surface text-text-strong": source() === item,
                        "text-text-weak hover:text-text-base": source() !== item,
                      }}
                      onClick={() => setSource(item)}
                    >
                      <Icon name={item === "official" ? "badge-check" : "hard-drive"} size="small" />
                      {item === "official" ? "Official" : "Local"}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center">
                <Icon name="search" size="small" class="text-icon-weak" />
              </span>
              <input
                type="text"
                value={query()}
                onInput={(e) => handleInput(e.currentTarget.value)}
                placeholder="Search plugins"
                class="workbench-input-surface h-10 w-full rounded-xl px-9 text-13-regular text-text-base outline-none placeholder:text-text-weak"
              />
            </div>
          </header>

          <section class="flex flex-col gap-2.5">
            <div class="flex items-center justify-between px-0.5">
              <div>
                <h2 class="text-13-medium text-text-strong">
                  {source() === "official" ? "Official marketplace" : "Local registry"}
                </h2>
                <p class="text-12-regular text-text-weak">
                  <Show
                    when={!searchResults.loading}
                    fallback={source() === "official" ? "Checking official registry" : "Checking local registry"}
                  >
                    {resultCount()} {resultCount() === 1 ? "plugin" : "plugins"}
                    <Show when={debouncedQuery()}> matching "{debouncedQuery()}"</Show>
                  </Show>
                </p>
              </div>
            </div>

            <Show when={searchResults.loading}>
              <div class="flex flex-col gap-2">
                <For each={[0, 1, 2]}>
                  {() => <div class="plugin-marketplace-skeleton-row workbench-card-surface h-[92px] rounded-2xl" />}
                </For>
              </div>
            </Show>

            <Show when={isEmpty()}>
              <div class="workbench-card-surface flex flex-col items-center justify-center rounded-2xl px-6 py-14 text-center">
                <span class="plugin-marketplace-empty-icon">
                  <Icon name="package" size="large" class="text-icon-weak" />
                </span>
                <p class="mt-3 text-14-medium text-text-strong">
                  {debouncedQuery() ? "No plugins found" : "No plugins available"}
                </p>
                <p class="mt-1 max-w-72 text-12-regular leading-relaxed text-text-weak">
                  {debouncedQuery()
                    ? `No results for "${debouncedQuery()}". Try a different search term.`
                    : source() === "official"
                      ? "The official marketplace has not returned any plugins yet."
                      : "Local development plugins will appear here once registered."}
                </p>
              </div>
            </Show>

            <Show when={searchResults() && searchResults()!.length > 0}>
              <div class="flex flex-col gap-2">
                <For each={searchResults()}>
                  {(plugin) => (
                    <PluginRow
                      plugin={plugin}
                      onClick={() =>
                        navigate(
                          `/plugins/${encodeURIComponent(plugin.id)}?source=${encodeURIComponent(plugin.source)}`,
                        )
                      }
                    />
                  )}
                </For>
              </div>
            </Show>
          </section>
        </div>
      </div>
    </div>
  )
}

function PluginRow(props: { plugin: RegistryPluginSummary; onClick: () => void }) {
  return (
    <button
      type="button"
      class="plugin-marketplace-row workbench-card-surface group flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus:ring-2 focus:ring-border-base/35"
      onClick={props.onClick}
    >
      <span class="plugin-marketplace-plugin-icon">
        <Icon name={pluginIcon(props.plugin)} size="normal" class="text-icon-weak" />
      </span>

      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 flex-wrap items-center gap-1.5">
          <span class="truncate text-14-medium text-text-strong">{props.plugin.name}</span>
          <Show when={props.plugin.latestVersion}>
            <span class="rounded-md bg-surface-inset-base px-1.5 py-px text-11-medium text-text-weaker">
              v{props.plugin.latestVersion}
            </span>
          </Show>
        </span>
        <span class="mt-1 block line-clamp-2 text-12-regular leading-relaxed text-text-weak">
          {props.plugin.description}
        </span>
        <span class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weaker">
          <span>{props.plugin.author?.name ?? "Unknown author"}</span>
          <span aria-hidden="true">·</span>
          <span>{props.plugin.tools.length} tools</span>
          <span aria-hidden="true">·</span>
          <span>{props.plugin.runtimeMode}</span>
          <span aria-hidden="true">·</span>
          <span>Updated {timeAgo(props.plugin.updatedAt)}</span>
        </span>
      </span>

      <span class="hidden shrink-0 items-center gap-1.5 sm:flex">
        <VerifiedBadge verified={props.plugin.verified} official={props.plugin.official} />
        <PermissionRiskBadge risk={props.plugin.risk} />
      </span>
      <span class="plugin-marketplace-row-arrow shrink-0 text-icon-weaker transition-transform group-hover:translate-x-0.5 group-hover:text-icon-base">
        <Icon name="chevron-right" size="small" />
      </span>
    </button>
  )
}
