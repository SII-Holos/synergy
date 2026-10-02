import { experiencePreview } from "./experience-preview"
import { Dynamic } from "solid-js/web"
import { createEffect, createMemo, createSignal, createResource, For, onCleanup, Show } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { createLibraryCollection } from "./library-collection"
import { A } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createExperienceDetails } from "./experience-details"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { VList, type VListHandle } from "virtua/solid"
import { useLingui } from "@lingui/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteLibraryItemsConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel, capturePanelFocusReturn } from "@/components/app-panel"
import { useLocale } from "@/context/locale"
import { relativeTime, absoluteDate } from "@/utils/time"
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
  getExperienceSortLabel,
  getDimensionFullLabel,
  libraryActionButtonClass,
  libraryCardBaseClass,
  libraryCardExpandedClass,
  libraryCardHoverClass,
  libraryInsetClass,
  libraryMetaLabelClass,
  SelectionBar,
  SelectionCheckbox,
} from "./shared"
import { library as L } from "@/locales/messages"
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
  refetchStats: () => void
  currentScopeID: string | undefined
  currentSessionID: string | undefined
  scopeLabel?: (id: string) => string | undefined
}) {
  const { _ } = useLingui()
  const confirm = useConfirm()
  const dialog = useDialog()
  let detailDialog: string | undefined
  onCleanup(() => {
    if (detailDialog) dialog.close(detailDialog)
  })
  const [sort, setSort] = createSignal<ExperienceSortKey>("newest")
  const [filter, setFilter] = createSignal<ExperienceFilter>("all")
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set())
  const details = createExperienceDetails(async (id, signal) => {
    const result = await props.sdk.client.library.experience.get({ id }, { throwOnError: true, signal })
    if (!result.data) throw new Error("Missing experience detail")
    return result.data
  })
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

  const searchCollection = createLibraryCollection<ExperienceSearchItem>(
    () => JSON.stringify([props.search, effectiveFilter(), props.currentScopeID]),
    async (key, signal) => {
      const [query, filter, scopeID] = JSON.parse(key) as [string, ExperienceFilter, string | undefined]
      if (!query) return []
      const result = await props.sdk.client.library.experience.search(
        { query, topK: 50, body_scopeID: filter === "scope" ? scopeID : undefined },
        { signal, throwOnError: true },
      )
      return result.data ?? []
    },
  )
  const searchResults = searchCollection.items
  const refetchSearch = searchCollection.refresh

  let listHandle: VListHandle | undefined
  let pageRequestID = 0
  let pageIdentity = ""
  let pageController: AbortController | undefined
  onCleanup(() => {
    pageRequestID++
    pageController?.abort()
  })

  createEffect(() => {
    if (!props.isSearching && sort() === "relevance") {
      setSort("newest")
    }
  })

  createEffect(() => {
    props.search
    props.currentScopeID
    if (detailDialog) dialog.close(detailDialog)
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
    for (let index = 0; index < items.length; index += 1) {
      const left = items[index]
      next.push({
        kind: "items",
        items: [left, undefined],
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
    if (pageError()) return _({ id: "app.library.experience.loadFailed", message: "Failed to load more experiences" })
    if (loadingMore()) return _({ id: "app.library.experience.loadingMore", message: "Loading more experiences..." })
    if (hasMore())
      return _({
        id: "app.library.experience.showingOf",
        message: "Showing {shown} of {total} experiences",
        values: { shown: String(pagedItems().length), total: String(total()) },
      })
    if (pagedItems().length > 0)
      return _({
        id: "app.library.experience.showingAll",
        message: "Showing all {total} experiences",
        values: { total: String(total()) },
      })
    return ""
  })
  const filterLabel = createMemo(() => {
    switch (effectiveFilter()) {
      case "scope":
        return _({ id: "app.library.experience.filter.currentScope", message: "Current scope" })
      case "session":
        return _({ id: "app.library.experience.filter.currentSession", message: "Current session" })
      default:
        return _({ id: "app.library.experience.filter.all", message: "All experiences" })
    }
  })

  const loading = createMemo(() => (props.isSearching ? searchCollection.loading() : initialLoading()))
  const empty = createMemo(() => !loading() && displayedItems().length === 0)

  async function loadPage(reset: boolean) {
    if (props.isSearching) return
    if (!reset && (initialLoading() || loadingMore() || !hasMore())) return

    const requestID = ++pageRequestID
    const identity = JSON.stringify([effectiveFilter(), serverSort(), props.currentScopeID, props.currentSessionID])
    const changed = identity !== pageIdentity
    pageIdentity = identity
    pageController?.abort()
    pageController = new AbortController()
    const offset = reset ? 0 : pagedItems().length

    if (reset) {
      setInitialLoading(true)
      setLoadingMore(false)
      setPageError(false)
      setHasMore(false)
      if (changed) {
        setTotal(0)
        setPagedItems([])
      }
    } else {
      setLoadingMore(true)
      setPageError(false)
    }

    try {
      const result = await props.sdk.client.library.experience.page(
        {
          filter: effectiveFilter(),
          sort: serverSort(),
          scopeID: props.currentScopeID,
          sessionID: effectiveFilter() === "session" ? props.currentSessionID : undefined,
          limit: PAGE_SIZE,
          offset,
        },
        { throwOnError: true, signal: pageController.signal },
      )
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
    const item = displayedItems().find((entry) => entry.id === id)
    if (!item) return
    const restoreFocus = capturePanelFocusReturn()
    setExpandedCards(new Set([id]))
    void details.load(id)
    setExpandedSections((previous) => new Set([...previous, `${id}-script`]))
    detailDialog = dialog.show(
      () => (
        <Dialog
          size="wide"
          class="app-panel-detail-dialog library-detail-dialog"
          title={_({ id: "app.library.nav.experiences", message: "Experiences" })}
        >
          <ExperienceCard
            item={item}
            sdk={props.sdk}
            sourceScopeName={props.scopeLabel?.(item.scopeID)}
            detailPresentation
            expanded={expandedCards().has(id)}
            similarity={experienceSimilarity(item)}
            searching={props.isSearching}
            selecting={false}
            selected={false}
            detail={details.read(id)?.data}
            detailError={!!details.read(id)?.error}
            onRetry={() => void details.load(id)}
            expandedSections={expandedSections()}
            onToggle={() => dialog.close(detailDialog)}
            onToggleSection={toggleSection}
            onDelete={(event) => deleteExperience(id, event)}
          />
        </Dialog>
      ),
      () => {
        detailDialog = undefined
        setExpandedCards(new Set<string>())
        restoreFocus()
      },
    )
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

  function deleteSelected() {
    const ids = [...selected()]
    if (ids.length === 0) return
    confirm.show({
      ...deleteLibraryItemsConfirm("experience", ids.length),
      onConfirm: () => performDeleteSelected(ids),
    })
  }

  async function performDeleteSelected(ids: string[]) {
    setDeleting(true)
    try {
      await Promise.all(ids.map((id) => props.sdk.client.library.experience.remove({ id }, { throwOnError: true })))
      setExpandedCards((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      setPagedItems((items) => items.filter((item) => !ids.includes(item.id)))
      searchCollection.discard((item) => ids.includes(item.id))
      exitSelection()
      await refreshList()
      props.refetchStats()
    } finally {
      setDeleting(false)
    }
  }

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function deleteExperience(id: string, e: MouseEvent) {
    e.stopPropagation()
    confirm.show({
      ...deleteLibraryItemsConfirm("experience", 1),
      onConfirm: () => performDeleteExperience(id),
      onConfirmed: () => {
        if (detailDialog) dialog.close(detailDialog)
      },
    })
  }

  async function performDeleteExperience(id: string) {
    await props.sdk.client.library.experience.remove({ id }, { throwOnError: true })
    setPagedItems((items) => items.filter((item) => item.id !== id))
    searchCollection.discard((item) => item.id === id)
    setExpandedCards((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await refreshList()
    props.refetchStats()
  }

  return (
    <div class="library-list-pane" data-panel-list>
      <div class="shrink-0">
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
          <div class="library-list-toolbar">
            <div class="library-toolbar-left">
              <MenuField
                value={effectiveFilter()}
                ariaLabel={_({ id: "app.library.experience.filter.aria", message: "Filter experiences" })}
                triggerLabel={filterLabel()}
                placement="bottom-start"
                surfaceClass="library-filter-menu"
                options={[
                  {
                    value: "all",
                    label: _({ id: "app.library.experience.filter.all", message: "All experiences" }),
                    count: total() || displayedItems().length,
                  },
                  ...(scopeAvailable()
                    ? [
                        {
                          value: "scope",
                          label: _({
                            id: "app.library.experience.filter.currentScope",
                            message: "Current scope",
                          }),
                        },
                      ]
                    : []),
                  ...(sessionAvailable()
                    ? [
                        {
                          value: "session",
                          label: _({
                            id: "app.library.experience.filter.currentSession",
                            message: "Current session",
                          }),
                        },
                      ]
                    : []),
                ]}
                onChange={(value) => setFilter(value as ExperienceFilter)}
              />
              <Show when={effectiveFilter() !== "all"}>
                <button type="button" class={libraryActionButtonClass} onClick={() => setFilter("all")}>
                  {_({ id: "app.library.clearFilters", message: "Clear filters" })}
                </button>
              </Show>
              <span class="library-toolbar-summary">
                <Show when={props.isSearching} fallback={statusText() || `${total()} experiences`}>
                  {_({
                    id: "app.library.experience.search.results",
                    message: "{count} results",
                    values: { count: String(displayedItems().length) },
                  })}
                </Show>
              </span>
            </div>
            <div class="library-toolbar-right">
              <Show when={displayedItems().length > 0}>
                <button type="button" class={libraryActionButtonClass} onClick={() => setSelecting(true)}>
                  <Icon name={getSemanticIcon("notes.select")} size="small" class="opacity-70" />
                  <span>{_({ id: "app.library.experience.select", message: "Select" })}</span>
                </button>
              </Show>
              <MenuField
                value={sort()}
                ariaLabel={_({ id: "app.library.experience.sort.aria", message: "Sort experiences" })}
                triggerClass={libraryActionButtonClass}
                placement="bottom-end"
                options={availableSorts().map((key) => ({ value: key, label: getExperienceSortLabel(_, key) }))}
                onChange={(value) => setSort(value as ExperienceSortKey)}
              />
            </div>
          </div>
        </Show>
      </div>

      <Show when={props.isSearching && searchCollection.error()}>
        <div class="library-home-notice" role="alert">
          <span>{_(L.loadError)}</span>
          <button type="button" disabled={searchCollection.loading()} onClick={() => void refetchSearch()}>
            {_(L.retry)}
          </button>
        </div>
      </Show>
      <div class="flex-1 min-h-0 overflow-hidden">
        <Show when={loading() && displayedItems().length === 0}>
          <AppPanel.Loading />
        </Show>

        <Show
          when={
            (!loading() || displayedItems().length > 0) &&
            !(props.isSearching && searchCollection.error() && !displayedItems().length)
          }
        >
          <Show
            when={!pageError() || displayedItems().length > 0 || props.isSearching}
            fallback={
              <AppPanel.Empty
                icon={getSemanticIcon("state.error")}
                title={_(L.loadError)}
                description={_(L.loadHint)}
              />
            }
          >
            <Show
              when={!empty()}
              fallback={
                <AppPanel.Empty
                  icon={getSemanticIcon("experience.main")}
                  title={_(L.noExperiences)}
                  description={_(L.noExperiencesHint)}
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
                        <div class="flex items-center gap-2 app-panel-caption text-text-weaker">
                          <Show when={loadingMore() || initialLoading()}>
                            <Spinner class="size-3.5" />
                          </Show>
                          <span>{statusText()}</span>
                          <Show when={pageError() && !loadingMore()}>
                            <button
                              type="button"
                              class="px-1.5 py-0.5 rounded-md text-text-base hover:bg-surface-raised-base-hover transition-colors"
                              onClick={() => void loadPage(false)}
                            >
                              {_(L.retry)}
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
                      <div class="library-result-list">
                        <ExperienceCard
                          item={left}
                          expanded={false}
                          similarity={experienceSimilarity(left)}
                          searching={props.isSearching}
                          selecting={selecting()}
                          selected={selected().has(left.id)}
                          detail={details.read(left.id)?.data}
                          detailError={!!details.read(left.id)?.error}
                          onRetry={() => void details.load(left.id)}
                          expandedSections={expandedSections()}
                          onToggle={() => toggleCard(left.id)}
                          onToggleSection={(key) => toggleSection(key)}
                          onDelete={(e) => deleteExperience(left.id, e)}
                        />
                        <Show when={right}>
                          {(item) => (
                            <ExperienceCard
                              item={item()}
                              expanded={false}
                              similarity={experienceSimilarity(item())}
                              searching={props.isSearching}
                              selecting={selecting()}
                              selected={selected().has(item().id)}
                              detail={details.read(item().id)?.data}
                              detailError={!!details.read(item().id)?.error}
                              onRetry={() => void details.load(item().id)}
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
      </div>
    </div>
  )
}
function RewardDimensions(props: { rewards: RewardsInfo }) {
  const valueTone = (value: number) => {
    if (value > 0) return "text-text-on-success-base"
    if (value < 0) return "text-text-on-critical-base"
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
                class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base px-2 py-1 ring-1 ring-inset ring-border-base/35"
                title={`${dim.full}: ${dim.value}`}
              >
                <span class="app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {dim.short}
                </span>
                <span class={`app-panel-caption font-semibold leading-none ${valueTone(dim.value)}`}>
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

export function ExperienceCard(props: {
  item: ExperienceItem
  detailPresentation?: boolean
  sdk?: ReturnType<typeof useGlobalSDK>
  sourceScopeName?: string
  expanded: boolean
  similarity: number | undefined
  searching: boolean
  selecting: boolean
  selected: boolean
  detail: ExperienceDetailInfo | undefined
  detailError: boolean
  onRetry: () => void
  expandedSections: Set<string>
  onToggle: () => void
  onToggleSection: (key: string) => void
  onDelete?: (e: MouseEvent) => void
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const reward = () => props.item.reward
  const rewards = () => props.item.rewards
  const qValue = () => props.item.qValue
  const qValues = () => props.item.qValues
  const qVisits = () => props.item.qVisits
  const turnsRemaining = () => props.item.turnsRemaining
  const sessionID = () => props.item.sessionID
  const scopeID = () => props.item.scopeID
  const [sourceSession, { refetch: retrySource }] = createResource(
    () =>
      props.detailPresentation && props.sdk && sessionID() && scopeID()
        ? { sessionID: sessionID()!, scopeID: scopeID()! }
        : undefined,
    async (key) => {
      try {
        const result = await props.sdk!.client.session.get(key, { throwOnError: true })
        return { title: result.data?.title, unavailable: !result.data }
      } catch {
        return { title: undefined, unavailable: true }
      }
    },
  )
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
  const experienceCopyText = createMemo(() => {
    const r = rewards()
    const lines: string[] = [
      `${_({ id: "app.library.experience.copy.intent", message: "Intent" })}: ${props.item.intent}`,
      `${_({ id: "app.library.experience.copy.reward", message: "Reward" })}: ${reward()?.toFixed(2) ?? _({ id: "app.library.experience.notRecorded", message: "Not recorded" })}  Q: ${qValue().toFixed(2)}  ${_({ id: "app.library.experience.visits", message: "{visits} visits", values: { visits: String(qVisits()) } })}`,
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
      if (dims) lines.push(`${_({ id: "app.library.experience.copy.dimensions", message: "Dimensions" })}: ${dims}`)
      if (r.reason) lines.push(`${_({ id: "app.library.experience.copy.reason", message: "Reason" })}: ${r.reason}`)
    }
    if (sourceModel()) lines.push(`${_({ id: "app.library.experience.model", message: "Model" })}: ${sourceModel()}`)
    if (scopeID()) lines.push(`${_({ id: "app.library.experience.scope", message: "Scope" })}: ${scopeID()}`)
    if (sessionID()) lines.push(`${_({ id: "app.library.experience.session", message: "Session" })}: ${sessionID()}`)
    const detail = props.detail
    if (detail?.script) lines.push("", _({ id: "app.library.experience.script", message: "Script" }), detail.script)
    if (detail?.raw) lines.push("", _({ id: "app.library.experience.raw", message: "Raw" }), detail.raw)
    return lines.join("\n")
  })
  const copyExperience = createCopyController({
    text: experienceCopyText,
    copyLabel: _({
      id: "app.library.experience.copyLabel",
      message: "Copy all content",
    }),
    failureDescription: _({
      id: "app.library.experience.copyFailed",
      message: "Unable to copy the experience.",
    }),
  })

  function handleCopyExperience(e: MouseEvent) {
    e.stopPropagation()
    void copyExperience.copy()
  }

  const preview = createMemo(() => experiencePreview(props.item.intent))

  return (
    <div
      data-panel-item={props.item.id}
      classList={{
        [libraryCardBaseClass]: true,
        [libraryCardExpandedClass]: props.expanded && !props.selecting,
        [libraryCardHoverClass]: !props.expanded && !props.selecting,
        "workbench-selected-surface ring-1 ring-inset ring-border-base/32": props.selecting && props.selected,
        "hover:bg-surface-raised-base/98": props.selecting && !props.selected,
      }}
    >
      <div class="flex flex-col gap-3 p-4">
        <div class="flex items-start gap-2">
          <Dynamic
            data-panel-focus-entry={props.detailPresentation ? undefined : true}
            component={props.detailPresentation ? "h2" : "button"}
            type={props.detailPresentation ? undefined : "button"}
            class="library-card-toggle flex items-start gap-2 min-w-0 flex-1 text-left"
            aria-expanded={undefined}
            aria-pressed={props.selecting ? props.selected : undefined}
            aria-haspopup={!props.detailPresentation && !props.selecting ? "dialog" : undefined}
            onClick={props.detailPresentation ? undefined : props.onToggle}
          >
            <Show when={props.selecting}>
              <span class="shrink-0 pt-0.5" aria-hidden="true">
                <SelectionCheckbox selected={props.selected} />
              </span>
            </Show>
            <span class="min-w-0 flex-1">
              <span
                classList={{
                  "block app-panel-row-title text-text-strong leading-snug [overflow-wrap:anywhere]": true,
                  "line-clamp-2": !props.expanded || props.selecting,
                }}
              >
                {(props.detailPresentation
                  ? _({ id: "app.library.experience.contentTitle", message: "Experience" })
                  : preview().title) ||
                  (props.item.rewardStatus === "encoding_failed"
                    ? _({ id: "app.library.experience.encodingFailedTitle", message: "Experience encoding failed" })
                    : _({ id: "app.library.experience.missingIntent", message: "Intent not recorded" }))}
              </span>
              <Show when={!props.detailPresentation && preview().summary}>
                <span class="library-experience-summary mt-1 block app-panel-copy text-text-weak line-clamp-2">
                  {preview().summary}
                </span>
              </Show>
              <span class="mt-1 block app-panel-caption text-text-weak">
                {props.item.rewardStatus === "encoding_failed"
                  ? _({ id: "app.library.experience.status.failed", message: "Encoding failed" })
                  : props.item.rewardStatus === "pending"
                    ? _({ id: "app.library.experience.status.pending", message: "Pending evaluation" })
                    : _({ id: "app.library.experience.status.evaluated", message: "Evaluated" })}
              </span>
            </span>
          </Dynamic>
          <div class="flex shrink-0 items-center gap-1.5 self-start">
            <Show when={props.searching && props.similarity !== undefined}>
              <span class="rounded-full bg-surface-inset-base px-2.5 py-1 app-panel-caption font-medium text-text-base ring-1 ring-inset ring-border-base/35">
                {Math.round((props.similarity ?? 0) * 100)}%
              </span>
            </Show>
            <Show when={props.expanded && !props.selecting}>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base-hover hover:text-icon-base"
                onClick={handleCopyExperience}
                title={copyExperience.tooltip()}
                aria-label={copyExperience.tooltip()}
                data-copy-state={copyExperience.state()}
                disabled={copyExperience.disabled()}
              >
                <Show when={copyExperience.copied()} fallback={<Icon name={copyExperience.icon()} size="small" />}>
                  <Icon name={getSemanticIcon("state.success")} size="small" class="text-text-on-success-base" />
                </Show>
              </button>
              <Show when={props.onDelete}>
                <button
                  type="button"
                  class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base"
                  aria-label={_({ id: "app.library.experience.delete", message: "Delete experience" })}
                  onClick={props.onDelete}
                >
                  <Icon name={getSemanticIcon("action.remove")} size="small" />
                </button>
              </Show>
            </Show>
          </div>
        </div>

        <Show when={!props.selecting}>
          <Show when={props.item.rewardStatus === "encoding_failed"}>
            <p class="app-panel-caption text-text-weak">
              {_({
                id: "app.library.experience.encodingFailedHint",
                message: "This turn could not be encoded. Open the source session to inspect the original content.",
              })}
            </p>
          </Show>

          <Show when={props.detailPresentation && props.item.intent}>
            <Markdown text={props.item.intent} class="library-detail-markdown" />
          </Show>
          <Show when={props.expanded}>
            <section class="library-experience-source">
              <h3 class="app-panel-section-title">{_({ id: "app.library.experience.source", message: "Source" })}</h3>
              <p class="app-panel-caption text-text-weak">
                {props.sourceScopeName ||
                  (scopeID() === "home"
                    ? _({ id: "app.sidebar.section.home", message: "Home" })
                    : _({ id: "app.library.experience.scopeNameUnavailable", message: "Scope name unavailable" }))}
              </p>
              <Show when={scopeID() && sessionID()}>
                <A
                  class="library-source-link app-panel-control text-text-interactive-base"
                  href={`/${base64Encode(scopeID())}/session/${sessionID()}`}
                >
                  {sourceSession.latest?.title ||
                    _({ id: "app.library.experience.openSession", message: "Open source session" })}
                </A>
              </Show>
              <Show when={sourceSession.latest?.unavailable}>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.library.experience.sourceUnavailable",
                    message: "Source session information is unavailable.",
                  })}{" "}
                  <button type="button" class="library-plain-action" onClick={() => void retrySource()}>
                    {_(L.retry)}
                  </button>
                </p>
              </Show>
            </section>
            <Show when={props.detailError}>
              <div role="alert" class="flex items-center justify-between gap-3 app-panel-caption text-text-weak">
                <span>
                  {_({
                    id: "app.library.experience.detailFailed",
                    message: "Unable to load details. This card is still available.",
                  })}
                </span>
                <button
                  type="button"
                  class="library-action"
                  onClick={(event) => {
                    const trigger = event.currentTarget
                    const surface = trigger.closest<HTMLElement>('[role="dialog"]')
                    props.onRetry()
                    queueMicrotask(() => {
                      if (!trigger.isConnected && document.activeElement === document.body) surface?.focus()
                    })
                  }}
                >
                  {_(L.retry)}
                </button>
              </div>
            </Show>
            <details class="library-experience-technical">
              <summary class="app-panel-control text-text-weak">
                {_({ id: "app.library.experience.technicalDetails", message: "Technical details" })}
              </summary>
              <div
                class={`mt-1 flex flex-col gap-2.5 border-t border-border-base/28 pt-3`}
                onClick={(e) => e.stopPropagation()}
              >
                <Show
                  when={props.detail}
                  fallback={
                    <Show when={!props.detailError}>
                      <Spinner class="size-3.5 my-1 text-icon-weak-base" />
                    </Show>
                  }
                >
                  {(detail) => (
                    <>
                      <Show when={detail().script}>
                        <CollapsibleSection
                          label={_({ id: "app.library.experience.script", message: "Script" })}
                          expanded={props.expandedSections.has(`${props.item.id}-script`)}
                          onToggle={() => props.onToggleSection(`${props.item.id}-script`)}
                        >
                          <Markdown
                            text={detail().script!}
                            class={
                              props.detailPresentation
                                ? "library-detail-markdown"
                                : "app-panel-caption text-text-weak leading-relaxed max-h-64 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_pre]:app-panel-caption [&_pre]:rounded-lg [&_pre]:p-2 [&_p]:my-0.5"
                            }
                          />
                        </CollapsibleSection>
                      </Show>
                      <Show when={detail().raw}>
                        <CollapsibleSection
                          label={_({ id: "app.library.experience.raw", message: "Raw" })}
                          expanded={props.expandedSections.has(`${props.item.id}-raw`)}
                          onToggle={() => props.onToggleSection(`${props.item.id}-raw`)}
                        >
                          <Markdown
                            text={detail().raw!}
                            class={
                              props.detailPresentation
                                ? "library-detail-markdown"
                                : "app-panel-caption text-text-weak leading-relaxed max-h-64 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_pre]:app-panel-caption [&_pre]:rounded-lg [&_pre]:p-2 [&_p]:my-0.5"
                            }
                          />
                        </CollapsibleSection>
                      </Show>
                    </>
                  )}
                </Show>
                <dl class={`grid gap-3 sm:grid-cols-3 ${libraryInsetClass} px-3.5 py-3`}>
                  <div class="min-w-0">
                    <dt class={libraryMetaLabelClass}>{_({ id: "app.library.experience.model", message: "Model" })}</dt>
                    <dd class="mt-1 app-panel-caption text-text-base [overflow-wrap:anywhere]">
                      {sourceModel() ?? _({ id: "app.library.experience.notRecorded", message: "Not recorded" })}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class={libraryMetaLabelClass}>{_({ id: "app.library.experience.scope", message: "Scope" })}</dt>
                    <dd class="mt-1 app-panel-caption text-text-base [overflow-wrap:anywhere]">
                      {scopeID() || _({ id: "app.library.experience.notRecorded", message: "Not recorded" })}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class={libraryMetaLabelClass}>
                      {_({ id: "app.library.experience.session", message: "Session" })}
                    </dt>
                    <dd class="mt-1 app-panel-caption text-text-base [overflow-wrap:anywhere]">
                      {sessionID() || _({ id: "app.library.experience.notRecorded", message: "Not recorded" })}
                    </dd>
                  </div>
                </dl>
              </div>
            </details>
          </Show>

          <Show when={props.expanded && props.item.rewardStatus !== "encoding_failed"}>
            <details class="library-experience-metrics">
              <summary class="app-panel-caption font-medium text-text-weak cursor-pointer">
                {_({ id: "app.library.experience.metrics", message: "Evaluation details" })}
              </summary>
              <div class="mt-3 flex flex-col gap-2">
                <div class={`flex items-center gap-1.5 flex-wrap px-3 py-2.5 ${libraryInsetClass}`}>
                  <Show when={reward() !== null}>
                    <span
                      classList={{
                        "rounded-full px-2.5 py-1 app-panel-caption font-medium ring-1 ring-inset": true,
                        "bg-surface-success-weak text-text-on-success-base ring-border-success-base": reward()! >= 0.5,
                        "bg-surface-warning-weak text-text-on-warning-base ring-icon-warning-base/12":
                          reward()! >= 0 && reward()! < 0.5,
                        "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-text-diff-delete-base/12":
                          reward()! < 0,
                      }}
                    >
                      {_({ id: "app.library.experience.stat.reward", message: "R" })} {reward()!.toFixed(2)}
                    </span>
                  </Show>
                  <span class="rounded-full bg-surface-inset-base px-2.5 py-1 app-panel-caption font-medium text-text-base ring-1 ring-inset ring-border-base/35">
                    {_({ id: "app.library.experience.stat.qValue", message: "Q" })} {qValue().toFixed(2)}
                  </span>
                  <span class="rounded-full bg-surface-inset-base px-2.5 py-1 app-panel-caption font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                    {_({
                      id: "app.library.experience.visits",
                      message: "{visits} visits",
                      values: { visits: String(qVisits()) },
                    })}
                  </span>
                  <Show when={turnsRemaining() !== null && turnsRemaining()! > 0}>
                    <span class="rounded-full bg-surface-warning-weak px-2.5 py-1 app-panel-caption font-medium text-text-on-warning-base ring-1 ring-inset ring-icon-warning-base/12">
                      {_({
                        id: "app.library.experience.remaining",
                        message: "{remaining} remaining",
                        values: { remaining: String(turnsRemaining()!) },
                      })}
                    </span>
                  </Show>
                  <Show when={rewards()?.confidence !== undefined}>
                    <span class="rounded-full bg-surface-inset-base px-2.5 py-1 app-panel-caption font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                      {_({ id: "app.library.experience.stat.confidence", message: "C" })}{" "}
                      {rewards()!.confidence!.toFixed(2)}
                    </span>
                  </Show>
                  <Show when={props.searching && searchScore() !== undefined}>
                    <span class="rounded-full bg-surface-inset-base px-2.5 py-1 app-panel-caption font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                      {_({ id: "app.library.experience.stat.score", message: "S" })} {searchScore()!.toFixed(2)}
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
                      "rounded-[0.9rem] bg-surface-inset-base px-3 py-2 app-panel-caption italic leading-snug text-text-weak/80 ring-1 ring-inset ring-border-base/25 [overflow-wrap:anywhere]": true,
                      "line-clamp-2": !props.expanded,
                    }}
                  >
                    {rewards()!.reason}
                  </p>
                </Show>
              </div>
            </details>
          </Show>

          <div
            classList={{
              "mt-0.5 flex items-center justify-between border-t border-border-base/28 pt-2.5": props.expanded,
              "mt-0.5 flex items-center justify-between": !props.expanded,
            }}
          >
            <span class="app-panel-caption text-text-weaker">
              <Show when={props.expanded} fallback={relativeTime(fmt, updated() ?? props.item.createdAt)}>
                {absoluteDate(fmt, props.item.createdAt)}
                <Show when={updated() && updated() !== props.item.createdAt}>
                  {_({
                    id: "app.library.experience.updated",
                    message: " · Updated {date}",
                    values: { date: absoluteDate(fmt, updated()!) },
                  })}
                </Show>
              </Show>
            </span>
            <Show when={!props.detailPresentation}>
              <button
                type="button"
                aria-label={
                  props.expanded
                    ? _({ id: "app.library.experience.collapse", message: "Collapse experience" })
                    : _({ id: "app.library.experience.expand", message: "View experience" })
                }
                aria-haspopup="dialog"
                onClick={props.onToggle}
                classList={{
                  "flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all": true,
                  "rotate-180 bg-surface-raised-base-hover": props.expanded,
                }}
              >
                <Icon name={getSemanticIcon("action.view")} size="small" />
              </button>
            </Show>
          </div>
        </Show>

        <Show when={props.selecting}>
          <div class="mt-0.5 flex items-center justify-between border-t border-border-base/22 pt-2.5">
            <span class="app-panel-caption text-text-weaker">
              {relativeTime(fmt, updated() ?? props.item.createdAt)}
            </span>
          </div>
        </Show>
      </div>
    </div>
  )
}

function QValueDimensions(props: { qValues: RewardsInfo }) {
  const { _ } = useLingui()
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
        <span class="shrink-0 app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
          {_({ id: "app.library.experience.stat.qValue", message: "Q" })}
        </span>
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <For each={dims()}>
            {(dim) => (
              <div
                class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base px-2 py-1 ring-1 ring-inset ring-border-base/35"
                title={`${dim.full} Q: ${dim.value.toFixed(4)}`}
              >
                <span class="app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {dim.short}
                </span>
                <span
                  classList={{
                    "app-panel-caption font-semibold leading-none tabular-nums": true,
                    "text-text-on-success-base": dim.value > 0.05,
                    "text-text-weaker": dim.value >= -0.05 && dim.value <= 0.05,
                    "text-text-on-critical-base": dim.value < -0.05,
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
  const { _ } = useLingui()
  return (
    <div class={`overflow-hidden ${libraryInsetClass}`}>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left app-panel-caption font-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
        onClick={props.onToggle}
      >
        <span class={libraryMetaLabelClass}>{props.label}</span>
        <span class="app-panel-caption font-medium text-text-weak">
          {_({ id: "app.library.experience.section.content", message: "Content" })}
        </span>
        <span
          classList={{
            "ml-auto flex size-5 items-center justify-center rounded-full bg-surface-raised-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all": true,
            "rotate-90": props.expanded,
          }}
        >
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="border-t border-border-base/22 px-3.5 pb-3 pt-2.5">{props.children}</div>
      </Show>
    </div>
  )
}
