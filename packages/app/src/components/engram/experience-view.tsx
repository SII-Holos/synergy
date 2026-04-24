import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { VList, type VListHandle } from "virtua/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import { Panel } from "@/components/panel"
import { absoluteDate, relativeTime } from "@/utils/time"
import type {
  ExperienceDetailInfo,
  ExperienceInfo,
  ExperienceListPage,
  ExperienceListSort,
  ExperienceSearchResult,
  RewardsInfo,
} from "@ericsanchezok/synergy-sdk/client"
import {
  type ExperienceFilter,
  type ExperienceSortKey,
  DISCRETE_DIMENSIONS,
  experienceSortLabels,
  engramActionButtonClass,
  engramCardBaseClass,
  engramCardExpandedClass,
  engramCardHoverClass,
  engramInsetClass,
  engramMenuClass,
  engramMetaLabelClass,
  SelectionBar,
  SelectionCheckbox,
} from "./shared"

const PAGE_SIZE = 50
const LOAD_MORE_THRESHOLD = 800

type ExperienceSearchItem = ExperienceSearchResult &
  Pick<ExperienceInfo, "reward" | "qVisits" | "turnsRemaining" | "sessionID" | "scopeID" | "updatedAt">

type ExperienceItem = ExperienceInfo | ExperienceSearchItem

type ExperienceRow =
  | {
      kind: "items"
      items: [ExperienceItem, ExperienceItem | undefined]
    }
  | {
      kind: "status"
    }

function experienceTimestamp(item: ExperienceItem): number {
  return item.updatedAt
}

function experienceReward(item: ExperienceItem): number {
  return item.reward ?? -Infinity
}

function experienceVisits(item: ExperienceItem): number {
  return item.qVisits
}

function experienceSimilarity(item: ExperienceItem): number | undefined {
  return "similarity" in item ? item.similarity : undefined
}

function experienceScore(item: ExperienceItem): number | undefined {
  return "score" in item ? item.score : undefined
}

export function ExperienceView(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  isSearching: boolean
  setSearchError: (v: boolean) => void
  onRegisterRefetch: (fn: () => void) => void
  refetchStats: () => void
  currentScopeID: string | undefined
  currentSessionID: string | undefined
}) {
  const [sort, setSort] = createSignal<ExperienceSortKey>("newest")
  const [sortOpen, setSortOpen] = createSignal(false)
  const [filter, setFilter] = createSignal<ExperienceFilter>("all")
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set())
  const [experienceDetails, setExperienceDetails] = createSignal<Record<string, ExperienceDetailInfo>>({})
  const [expandedSections, setExpandedSections] = createSignal<Set<string>>(new Set())
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [deleting, setDeleting] = createSignal(false)
  const [pagedItems, setPagedItems] = createSignal<ExperienceInfo[]>([])
  const [total, setTotal] = createSignal(0)
  const [hasMore, setHasMore] = createSignal(false)
  const [initialLoading, setInitialLoading] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [pageError, setPageError] = createSignal(false)

  const scopeAvailable = createMemo(() => !!props.currentScopeID)
  const sessionAvailable = createMemo(() => !!props.currentSessionID && !props.isSearching)

  const effectiveFilter = createMemo<ExperienceFilter>(() => {
    if (filter() === "scope" && !scopeAvailable()) return "all"
    if (filter() === "session" && !sessionAvailable()) return "all"
    return filter()
  })

  const serverSort = createMemo<ExperienceListSort>(() => {
    const key = sort()
    if (key === "relevance") return "newest"
    return key
  })

  const [searchResults, { refetch: refetchSearch }] = createResource(
    () => ({ query: props.search, filter: effectiveFilter(), scopeID: props.currentScopeID }),
    async ({ query, filter, scopeID }) => {
      if (!query) return []
      try {
        const result = await props.sdk.client.engram.experience.search({
          query,
          topK: 50,
          scopeID: filter === "scope" ? scopeID : undefined,
        })
        return (result.data ?? []) as ExperienceSearchItem[]
      } catch {
        props.setSearchError(true)
        return []
      }
    },
  )

  let listHandle: VListHandle | undefined
  let pageRequestID = 0

  props.onRegisterRefetch(() => {
    if (props.isSearching) {
      refetchSearch()
      return
    }
    void loadPage(true)
  })

  createEffect(() => {
    if (!props.isSearching && sort() === "relevance") {
      setSort("newest")
    }
  })

  createEffect(() => {
    props.search
    listHandle?.scrollTo(0)
    if (selecting()) exitSelection()
  })

  createEffect(() => {
    if (props.isSearching) return
    effectiveFilter()
    serverSort()
    props.currentScopeID
    props.currentSessionID
    listHandle?.scrollTo(0)
    if (selecting()) exitSelection()
    void loadPage(true)
  })

  createEffect(() => {
    if (props.isSearching) return
    if (initialLoading() || loadingMore() || !hasMore() || !listHandle) return
    if (listHandle.scrollSize <= listHandle.viewportSize + LOAD_MORE_THRESHOLD) {
      void loadPage(false)
    }
  })

  const displayedItems = createMemo<ExperienceItem[]>(() => {
    if (!props.isSearching) return pagedItems()

    let list = [...(searchResults() ?? [])]
    if (effectiveFilter() === "session" && props.currentSessionID) {
      list = list.filter((item) => item.sessionID === props.currentSessionID)
    }

    switch (sort()) {
      case "newest":
        return list.sort((a, b) => experienceTimestamp(b) - experienceTimestamp(a))
      case "oldest":
        return list.sort((a, b) => experienceTimestamp(a) - experienceTimestamp(b))
      case "relevance":
        return list.sort((a, b) => (experienceSimilarity(b) ?? 0) - (experienceSimilarity(a) ?? 0))
      case "reward":
        return list.sort((a, b) => experienceReward(b) - experienceReward(a))
      case "qvalue":
        return list.sort((a, b) => b.qValue - a.qValue)
      case "visits":
        return list.sort((a, b) => experienceVisits(b) - experienceVisits(a))
    }
  })

  const rows = createMemo<ExperienceRow[]>(() => {
    const items = displayedItems()
    const next: ExperienceRow[] = []
    for (let index = 0; index < items.length; index += 2) {
      const left = items[index]
      const right = items[index + 1]
      next.push({
        kind: "items",
        items: [left, right],
      })
    }
    if (!props.isSearching && (items.length > 0 || initialLoading() || pageError())) {
      next.push({ kind: "status" })
    }
    return next
  })

  const availableSorts = createMemo<ExperienceSortKey[]>(() => {
    const base: ExperienceSortKey[] = ["newest", "oldest"]
    if (props.isSearching) base.push("relevance")
    base.push("reward", "qvalue", "visits")
    return base
  })

  const statusText = createMemo(() => {
    if (pageError()) return "Failed to load more experiences"
    if (loadingMore()) return "Loading more experiences..."
    if (hasMore()) return `Showing ${pagedItems().length} of ${total()} experiences`
    if (pagedItems().length > 0) return `Showing all ${total()} experiences`
    return ""
  })

  const loading = createMemo(() => (props.isSearching ? searchResults.loading : initialLoading()))
  const empty = createMemo(() => !loading() && displayedItems().length === 0)

  async function loadPage(reset: boolean) {
    if (props.isSearching) return
    if (!reset && (initialLoading() || loadingMore() || !hasMore())) return

    const requestID = ++pageRequestID
    const offset = reset ? 0 : pagedItems().length

    if (reset) {
      setInitialLoading(true)
      setLoadingMore(false)
      setPageError(false)
      setHasMore(false)
      setTotal(0)
      setPagedItems([])
    } else {
      setLoadingMore(true)
      setPageError(false)
    }

    try {
      const result = await props.sdk.client.engram.experience.page({
        filter: effectiveFilter(),
        sort: serverSort(),
        scopeID: props.currentScopeID,
        sessionID: effectiveFilter() === "session" ? props.currentSessionID : undefined,
        limit: PAGE_SIZE,
        offset,
      })
      if (requestID !== pageRequestID) return

      const page = result.data as ExperienceListPage | undefined
      const items = page?.items ?? []
      setPagedItems((prev) => (reset ? items : [...prev, ...items]))
      setTotal(page?.total ?? items.length)
      setHasMore(page?.hasMore ?? false)
      setPageError(false)
    } catch {
      if (requestID !== pageRequestID) return
      setPageError(true)
    } finally {
      if (requestID !== pageRequestID) return
      setInitialLoading(false)
      setLoadingMore(false)
    }
  }

  function maybeLoadMore(offset: number) {
    if (props.isSearching || !listHandle || initialLoading() || loadingMore() || !hasMore()) return
    if (offset + listHandle.viewportSize >= listHandle.scrollSize - LOAD_MORE_THRESHOLD) {
      void loadPage(false)
    }
  }

  function toggleCard(id: string) {
    if (selecting()) {
      toggleSelect(id)
      return
    }
    const wasExpanded = expandedCards().has(id)
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!wasExpanded) void loadExperienceDetail(id)
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelection() {
    setSelecting(false)
    setSelected(new Set<string>())
  }

  function selectAll() {
    const ids = displayedItems().map((experience) => experience.id)
    setSelected(new Set(ids))
  }

  async function refreshList() {
    if (props.isSearching) {
      await refetchSearch()
      return
    }
    await loadPage(true)
  }

  async function deleteSelected() {
    const ids = [...selected()]
    if (ids.length === 0) return
    setDeleting(true)
    try {
      await Promise.all(ids.map((id) => props.sdk.client.engram.experience.remove({ id })))
      setExpandedCards((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      exitSelection()
      await refreshList()
      props.refetchStats()
    } catch {}
    setDeleting(false)
  }

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function loadExperienceDetail(id: string) {
    if (experienceDetails()[id]) return
    try {
      const result = await props.sdk.client.engram.experience.get({ id })
      if (result.data) {
        setExperienceDetails((prev) => ({ ...prev, [id]: result.data as ExperienceDetailInfo }))
      }
    } catch {}
  }

  async function deleteExperience(id: string, e: MouseEvent) {
    e.stopPropagation()
    try {
      await props.sdk.client.engram.experience.remove({ id })
      setExpandedCards((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await refreshList()
      props.refetchStats()
    } catch {}
  }

  return (
    <>
      <Panel.SubHeader>
        <Show
          when={!selecting()}
          fallback={
            <SelectionBar
              count={selected().size}
              total={displayedItems().length}
              deleting={deleting()}
              onSelectAll={selectAll}
              onDelete={deleteSelected}
              onCancel={exitSelection}
            />
          }
        >
          <div class="flex items-center gap-1.5 flex-wrap">
            <Show when={scopeAvailable() || sessionAvailable()}>
              <Panel.FilterChip active={effectiveFilter() === "all"} onClick={() => setFilter("all")}>
                All
              </Panel.FilterChip>
              <Show when={scopeAvailable()}>
                <Panel.FilterChip active={effectiveFilter() === "scope"} onClick={() => setFilter("scope")}>
                  Scope
                </Panel.FilterChip>
              </Show>
              <Show when={sessionAvailable()}>
                <Panel.FilterChip active={effectiveFilter() === "session"} onClick={() => setFilter("session")}>
                  Session
                </Panel.FilterChip>
              </Show>
            </Show>
            <div class="ml-auto flex items-center gap-1">
              <Show when={displayedItems().length > 0}>
                <button type="button" class={engramActionButtonClass} onClick={() => setSelecting(true)}>
                  <Icon name="square-check" size="small" class="opacity-70" />
                  <span>Select</span>
                </button>
              </Show>
              <Popover open={sortOpen()} onOpenChange={setSortOpen} placement="bottom-end" gutter={6}>
                <Popover.Trigger as="button" class={engramActionButtonClass}>
                  <span>{experienceSortLabels[sort()]}</span>
                  <Icon name="chevron-down" size="small" class="opacity-60" />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content class={engramMenuClass}>
                    <For each={availableSorts()}>
                      {(key) => (
                        <button
                          type="button"
                          classList={{
                            "w-full rounded-[0.8rem] px-3 py-2 text-left text-12-medium transition-colors": true,
                            "bg-surface-inset-base/7 text-text-interactive-base": sort() === key,
                            "text-text-base hover:bg-surface-inset-base/55": sort() !== key,
                          }}
                          onClick={() => {
                            setSort(key)
                            setSortOpen(false)
                          }}
                        >
                          {experienceSortLabels[key]}
                        </button>
                      )}
                    </For>
                  </Popover.Content>
                </Popover.Portal>
              </Popover>
            </div>
          </div>
        </Show>
      </Panel.SubHeader>

      <Panel.Body class="overflow-hidden">
        <Show when={loading()}>
          <Panel.Loading />
        </Show>

        <Show when={!loading()}>
          <Show
            when={!pageError() || displayedItems().length > 0 || props.isSearching}
            fallback={
              <Panel.Empty
                icon="brain"
                title="Failed to load experiences"
                description="Try refreshing the panel to load the latest experience records."
              />
            }
          >
            <Show
              when={!empty()}
              fallback={
                <Panel.Empty
                  icon="brain"
                  title="No experiences yet"
                  description="Experiences are recorded as you work with the agent and capture behavioral patterns."
                />
              }
            >
              <VList
                ref={(handle) => {
                  listHandle = handle
                }}
                data={rows()}
                style={{ height: "100%" }}
                class="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                onScroll={maybeLoadMore}
              >
                {(row) => {
                  if (row.kind === "status") {
                    return (
                      <div class="py-2.5 flex items-center justify-center">
                        <div class="flex items-center gap-2 text-11-regular text-text-weaker">
                          <Show when={loadingMore()}>
                            <Spinner class="size-3.5" />
                          </Show>
                          <span>{statusText()}</span>
                          <Show when={pageError() && !loadingMore()}>
                            <button
                              type="button"
                              class="px-1.5 py-0.5 rounded-md text-text-interactive-base hover:bg-surface-raised-base-hover transition-colors"
                              onClick={() => void loadPage(false)}
                            >
                              Retry
                            </button>
                          </Show>
                        </div>
                      </div>
                    )
                  }

                  const left = row.items[0]
                  const right = row.items[1]

                  return (
                    <div class="py-1.5">
                      <div class="grid grid-cols-2 gap-3 items-start">
                        <ExperienceCard
                          item={left}
                          expanded={expandedCards().has(left.id)}
                          similarity={experienceSimilarity(left)}
                          searching={props.isSearching}
                          selecting={selecting()}
                          selected={selected().has(left.id)}
                          detail={experienceDetails()[left.id]}
                          expandedSections={expandedSections()}
                          onToggle={() => toggleCard(left.id)}
                          onToggleSection={(key) => toggleSection(key)}
                          onDelete={(e) => deleteExperience(left.id, e)}
                        />
                        <Show when={right} fallback={<div class="min-h-0" />}>
                          {(item) => (
                            <ExperienceCard
                              item={item()}
                              expanded={expandedCards().has(item().id)}
                              similarity={experienceSimilarity(item())}
                              searching={props.isSearching}
                              selecting={selecting()}
                              selected={selected().has(item().id)}
                              detail={experienceDetails()[item().id]}
                              expandedSections={expandedSections()}
                              onToggle={() => toggleCard(item().id)}
                              onToggleSection={(key) => toggleSection(key)}
                              onDelete={(e) => deleteExperience(item().id, e)}
                            />
                          )}
                        </Show>
                      </div>
                    </div>
                  )
                }}
              </VList>
            </Show>
          </Show>
        </Show>
      </Panel.Body>
    </>
  )
}

function RewardDimensions(props: { rewards: RewardsInfo }) {
  const valueTone = (value: number) => {
    if (value > 0) return "text-[rgba(34,126,102,0.96)] dark:text-[rgba(126,213,188,0.92)]"
    if (value < 0) return "text-[rgba(145,79,57,0.96)] dark:text-[rgba(236,176,156,0.9)]"
    return "text-text-weaker"
  }
  const discrete = createMemo(() => {
    const entries: Array<{ short: string; full: string; value: number }> = []
    for (const dim of DISCRETE_DIMENSIONS) {
      const val = props.rewards[dim.key]
      if (val !== undefined && typeof val === "number") entries.push({ short: dim.short, full: dim.full, value: val })
    }
    return entries
  })

  return (
    <Show when={discrete().length > 0}>
      <div class="flex w-full items-center gap-2">
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <For each={discrete()}>
            {(dim) => (
              <div
                class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base/48 px-2 py-1 ring-1 ring-inset ring-border-base/35"
                title={`${dim.full}: ${dim.value}`}
              >
                <span class="text-[9px] font-medium uppercase tracking-[0.12em] text-text-weaker">{dim.short}</span>
                <span class={`text-[10px] font-semibold leading-none ${valueTone(dim.value)}`}>
                  {dim.value > 0 ? "+1" : dim.value < 0 ? "−1" : "·0"}
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function ExperienceCard(props: {
  item: ExperienceItem
  expanded: boolean
  similarity: number | undefined
  searching: boolean
  selecting: boolean
  selected: boolean
  detail: ExperienceDetailInfo | undefined
  expandedSections: Set<string>
  onToggle: () => void
  onToggleSection: (key: string) => void
  onDelete: (e: MouseEvent) => void
}) {
  const reward = () => props.item.reward
  const rewards = () => props.item.rewards
  const qValue = () => props.item.qValue
  const qValues = () => props.item.qValues
  const qVisits = () => props.item.qVisits
  const turnsRemaining = () => props.item.turnsRemaining
  const sessionID = () => props.item.sessionID
  const scopeID = () => props.item.scopeID
  const sourceProviderID = () => props.item.sourceProviderID ?? props.detail?.sourceProviderID ?? undefined
  const sourceModelID = () => props.item.sourceModelID ?? props.detail?.sourceModelID ?? undefined
  const sourceModel = () => {
    const providerID = sourceProviderID()
    const modelID = sourceModelID()
    if (providerID && modelID) return `${providerID}/${modelID}`
    return modelID ?? providerID
  }
  const updated = () => props.item.updatedAt
  const searchScore = () => experienceScore(props.item)
  const [copied, setCopied] = createSignal(false)

  function copyExperience(e: MouseEvent) {
    e.stopPropagation()
    const r = rewards()
    const lines: string[] = [
      `Intent: ${props.item.intent}`,
      `Reward: ${reward()?.toFixed(2) ?? "N/A"}  Q: ${qValue().toFixed(2)}  Visits: ${qVisits()}`,
    ]
    if (r) {
      const dims = [
        r.outcome !== undefined ? `outcome=${r.outcome}` : null,
        r.intent !== undefined ? `intent=${r.intent}` : null,
        r.execution !== undefined ? `execution=${r.execution}` : null,
        r.orchestration !== undefined ? `orchestration=${r.orchestration}` : null,
        r.expression !== undefined ? `expression=${r.expression}` : null,
        r.confidence !== undefined ? `confidence=${r.confidence.toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join("  ")
      if (dims) lines.push(`Dimensions: ${dims}`)
      if (r.reason) lines.push(`Reason: ${r.reason}`)
    }
    if (sourceModel()) lines.push(`Model: ${sourceModel()}`)
    if (scopeID()) lines.push(`Scope: ${scopeID()}`)
    if (sessionID()) lines.push(`Session: ${sessionID()}`)
    const detail = props.detail
    if (detail?.script) lines.push("", "--- Script ---", detail.script)
    if (detail?.raw) lines.push("", "--- Raw ---", detail.raw)
    navigator.clipboard.writeText(lines.join("\n"))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      classList={{
        [`${engramCardBaseClass} cursor-pointer`]: true,
        [engramCardExpandedClass]: props.expanded && !props.selecting,
        [engramCardHoverClass]: !props.expanded && !props.selecting,
        "bg-surface-interactive-base/12 ring-1 ring-inset ring-text-interactive-base/28 shadow-[inset_0_1px_0_rgba(214,204,190,0.08)]":
          props.selecting && props.selected,
        "hover:bg-surface-raised-base/98": props.selecting && !props.selected,
      }}
      onClick={props.onToggle}
    >
      <div class="flex flex-col gap-3 p-4">
        <div class="flex items-start gap-2">
          <Show when={props.selecting}>
            <div class="pt-0.5">
              <SelectionCheckbox selected={props.selected} />
            </div>
          </Show>
          <div class="min-w-0 flex-1">
            <span
              classList={{
                "block text-13-medium text-text-strong leading-snug [overflow-wrap:anywhere]": true,
                "line-clamp-2": !props.expanded || props.selecting,
              }}
            >
              {props.item.intent}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-1.5 self-start">
            <Show when={props.searching && props.similarity !== undefined}>
              <span class="rounded-full bg-surface-interactive-base/10 px-2.5 py-1 text-[10px] font-medium text-text-interactive-base ring-1 ring-inset ring-text-interactive-base/12">
                {Math.round((props.similarity ?? 0) * 100)}%
              </span>
            </Show>
            <Show when={props.expanded && !props.selecting}>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base/5 text-icon-weak ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base/72 hover:text-text-interactive-base"
                onClick={copyExperience}
                title="Copy all content"
              >
                <Show when={copied()} fallback={<Icon name="copy" size="small" />}>
                  <Icon name="check" size="small" class="text-icon-success-base" />
                </Show>
              </button>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base/5 text-icon-weak ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base/72 hover:text-text-diff-delete-base"
                onClick={props.onDelete}
              >
                <Icon name="x" size="small" />
              </button>
            </Show>
          </div>
        </div>

        <Show when={!props.selecting}>
          <div class="flex flex-col gap-2">
            <div class={`flex items-center gap-1.5 flex-wrap px-3 py-2.5 ${engramInsetClass}`}>
              <Show when={reward() !== null}>
                <span
                  classList={{
                    "rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset": true,
                    "bg-icon-success-base/14 text-icon-success-base ring-icon-success-base/12": reward()! >= 0.5,
                    "bg-icon-warning-base/14 text-icon-warning-base ring-icon-warning-base/12":
                      reward()! >= 0 && reward()! < 0.5,
                    "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-text-diff-delete-base/12":
                      reward()! < 0,
                  }}
                >
                  R {reward()!.toFixed(2)}
                </span>
              </Show>
              <span class="rounded-full bg-text-interactive-base/10 px-2.5 py-1 text-[10px] font-medium text-text-interactive-base ring-1 ring-inset ring-text-interactive-base/12">
                Q {qValue().toFixed(2)}
              </span>
              <span class="rounded-full bg-surface-inset-base/58 px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                {qVisits()} visits
              </span>
              <Show when={turnsRemaining() !== null && turnsRemaining()! > 0}>
                <span class="rounded-full bg-icon-warning-base/14 px-2.5 py-1 text-[10px] font-medium text-icon-warning-base ring-1 ring-inset ring-icon-warning-base/12">
                  {turnsRemaining()} remaining
                </span>
              </Show>
              <Show when={rewards()?.confidence !== undefined}>
                <span class="rounded-full bg-surface-inset-base/58 px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                  C {rewards()!.confidence!.toFixed(2)}
                </span>
              </Show>
              <Show when={props.searching && searchScore() !== undefined}>
                <span class="rounded-full bg-surface-inset-base/58 px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                  S {searchScore()!.toFixed(2)}
                </span>
              </Show>
            </div>
            <Show when={rewards()}>
              <RewardDimensions rewards={rewards()} />
            </Show>
            <Show when={qValues()}>
              <QValueDimensions qValues={qValues()!} />
            </Show>
            <Show when={rewards()?.reason}>
              <p
                classList={{
                  "rounded-[0.9rem] bg-surface-inset-base/36 px-3 py-2 text-[11px] italic leading-snug text-text-weak/80 ring-1 ring-inset ring-border-base/25 [overflow-wrap:anywhere]": true,
                  "line-clamp-2": !props.expanded,
                }}
              >
                {rewards()!.reason}
              </p>
            </Show>
          </div>

          <Show when={props.expanded}>
            <div
              class={`mt-1 flex flex-col gap-2.5 border-t border-border-base/28 pt-3`}
              onClick={(e) => e.stopPropagation()}
            >
              <div class={`grid gap-2 sm:grid-cols-3 ${engramInsetClass} px-3.5 py-3`}>
                <Show when={sourceModel()}>
                  <div class="min-w-0">
                    <div class={engramMetaLabelClass}>Model</div>
                    <div class="mt-1 truncate text-11-regular text-text-weak">{sourceModel()}</div>
                  </div>
                </Show>
                <Show when={scopeID()}>
                  <div class="min-w-0">
                    <div class={engramMetaLabelClass}>Scope</div>
                    <div class="mt-1 truncate text-11-regular text-text-weak">{scopeID()}</div>
                  </div>
                </Show>
                <Show when={sessionID()}>
                  <div class="min-w-0">
                    <div class={engramMetaLabelClass}>Session</div>
                    <div class="mt-1 truncate text-11-regular text-text-weak">{sessionID()}</div>
                  </div>
                </Show>
              </div>

              <Show when={props.detail} fallback={<Spinner class="size-3.5 my-1 text-icon-weak" />}>
                {(detail) => (
                  <>
                    <Show when={detail().script}>
                      <CollapsibleSection
                        label="Script"
                        expanded={props.expandedSections.has(`${props.item.id}-script`)}
                        onToggle={() => props.onToggleSection(`${props.item.id}-script`)}
                      >
                        <Markdown
                          text={detail().script!}
                          class="text-11-regular text-text-weak leading-relaxed max-h-64 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_pre]:text-11-regular [&_pre]:rounded-lg [&_pre]:p-2 [&_p]:my-0.5"
                        />
                      </CollapsibleSection>
                    </Show>
                    <Show when={detail().raw}>
                      <CollapsibleSection
                        label="Raw"
                        expanded={props.expandedSections.has(`${props.item.id}-raw`)}
                        onToggle={() => props.onToggleSection(`${props.item.id}-raw`)}
                      >
                        <Markdown
                          text={detail().raw!}
                          class="text-11-regular text-text-weak leading-relaxed max-h-64 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_pre]:text-11-regular [&_pre]:rounded-lg [&_pre]:p-2 [&_p]:my-0.5"
                        />
                      </CollapsibleSection>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Show>

          <div
            classList={{
              "mt-0.5 flex items-center justify-between border-t border-border-base/28 pt-2.5": props.expanded,
              "mt-0.5 flex items-center justify-between": !props.expanded,
            }}
          >
            <span class="text-11-regular text-text-weaker">
              <Show when={props.expanded} fallback={relativeTime(updated() ?? props.item.createdAt)}>
                {absoluteDate(props.item.createdAt)}
                <Show when={updated() && updated() !== props.item.createdAt}>
                  {" · updated "}
                  {absoluteDate(updated()!)}
                </Show>
              </Show>
            </span>
            <span
              classList={{
                "flex size-6 items-center justify-center rounded-full bg-surface-inset-base/36 text-icon-weak ring-1 ring-inset ring-border-base/35 transition-all": true,
                "rotate-180 bg-surface-inset-base/5": props.expanded,
              }}
            >
              <Icon name="chevron-down" size="small" />
            </span>
          </div>
        </Show>

        <Show when={props.selecting}>
          <div class="mt-0.5 flex items-center justify-between border-t border-border-base/22 pt-2.5">
            <span class="text-11-regular text-text-weaker">{relativeTime(updated() ?? props.item.createdAt)}</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

function QValueDimensions(props: { qValues: RewardsInfo }) {
  const dims = createMemo(() => {
    const entries: Array<{ short: string; full: string; value: number }> = []
    for (const dim of DISCRETE_DIMENSIONS) {
      const val = props.qValues[dim.key]
      if (val !== undefined && typeof val === "number") entries.push({ short: dim.short, full: dim.full, value: val })
    }
    return entries
  })

  const hasNonZero = createMemo(() => dims().some((dimension) => Math.abs(dimension.value) > 0.001))

  return (
    <Show when={dims().length > 0 && hasNonZero()}>
      <div class="flex w-full items-center gap-2">
        <span class="shrink-0 text-[9px] font-medium uppercase tracking-[0.12em] text-text-weaker">Q</span>
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <For each={dims()}>
            {(dim) => (
              <div
                class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base/48 px-2 py-1 ring-1 ring-inset ring-border-base/35"
                title={`${dim.full} Q: ${dim.value.toFixed(4)}`}
              >
                <span class="text-[9px] font-medium uppercase tracking-[0.12em] text-text-weaker">{dim.short}</span>
                <span
                  classList={{
                    "text-[10px] font-semibold leading-none tabular-nums": true,
                    "text-[rgba(34,126,102,0.96)] dark:text-[rgba(126,213,188,0.92)]": dim.value > 0.05,
                    "text-text-weaker": dim.value >= -0.05 && dim.value <= 0.05,
                    "text-[rgba(145,79,57,0.96)] dark:text-[rgba(236,176,156,0.9)]": dim.value < -0.05,
                  }}
                >
                  {dim.value >= 0 ? "+" : ""}
                  {dim.value.toFixed(2)}
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function CollapsibleSection(props: { label: string; expanded: boolean; onToggle: () => void; children: any }) {
  return (
    <div class={`overflow-hidden ${engramInsetClass}`}>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base/52 hover:text-text-base"
        onClick={props.onToggle}
      >
        <span class={engramMetaLabelClass}>{props.label}</span>
        <span class="text-12-medium text-text-weak">Content</span>
        <span
          classList={{
            "ml-auto flex size-5 items-center justify-center rounded-full bg-surface-raised-base/75 text-icon-weak ring-1 ring-inset ring-border-base/35 transition-all": true,
            "rotate-90": props.expanded,
          }}
        >
          <Icon name="chevron-right" size="small" />
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="border-t border-border-base/22 px-3.5 pb-3 pt-2.5">{props.children}</div>
      </Show>
    </div>
  )
}
