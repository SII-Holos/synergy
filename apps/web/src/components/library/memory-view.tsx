import { Dynamic } from "solid-js/web"
import { createEffect, createMemo, createSignal, on, onCleanup, For, Show } from "solid-js"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { createLibraryCollection } from "./library-collection"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteLibraryItemsConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel, capturePanelFocusReturn } from "@/components/app-panel"
import { useLocale } from "@/context/locale"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { MemoryInfo, MemorySearchResult } from "@ericsanchezok/synergy-sdk/client"
import {
  type MemoryCategory,
  type MemoryRecallMode,
  type MemorySortKey,
  MEMORY_CATEGORIES,
  getCategoryLabel,
  getRecallModeLabel,
  getMemorySortLabel,
  libraryActionButtonClass,
  libraryCardBaseClass,
  libraryCardExpandedClass,
  libraryCardHoverClass,
  libraryInsetClass,
  libraryMetaLabelClass,
  SelectionBar,
  SelectionCheckbox,
} from "./shared"

type MemorySearchItem = MemorySearchResult & Pick<MemoryInfo, "updatedAt">
type MemoryItem = MemoryInfo | MemorySearchItem

function memorySimilarity(item: MemoryItem): number | undefined {
  return "similarity" in item ? item.similarity : undefined
}

export function MemoryView(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  scopeID?: string
  isSearching: boolean
  setSearchError: (v: boolean) => void
  refetchStats: () => void
}) {
  const { _ } = useLingui()
  const confirm = useConfirm()
  const dialog = useDialog()
  let detailDialog: string | undefined
  onCleanup(() => {
    if (detailDialog) dialog.close(detailDialog)
  })
  const [sort, setSort] = createSignal<MemorySortKey>("newest")
  const [categoryFilter, setCategoryFilter] = createSignal<Set<MemoryCategory>>(new Set())
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set())
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [deleting, setDeleting] = createSignal(false)

  const collection = createLibraryCollection<MemoryItem>(
    () => JSON.stringify([props.search, props.scopeID]),
    async (key, signal) => {
      const [query, scopeID] = JSON.parse(key) as [string, string | undefined]
      const result = query
        ? await props.sdk.client.library.search({ query, topK: 50, scopeID }, { signal, throwOnError: true })
        : await props.sdk.client.library.list({ scopeID }, { signal, throwOnError: true })
      return result.data ?? []
    },
  )
  const memories = collection.items
  const refetch = collection.refresh
  createEffect(
    on(
      () => [props.search, props.scopeID, categoryFilter()],
      () => {
        exitSelection()
        if (detailDialog) dialog.close(detailDialog)
      },
    ),
  )

  const filtered = createMemo(() => {
    const cats = categoryFilter()
    const list = memories() ?? []
    if (cats.size === 0) return list
    return list.filter((m) => {
      const cat = m.category as MemoryCategory | undefined
      return cat ? cats.has(cat) : true
    })
  })

  const sorted = createMemo(() => {
    const list = [...filtered()]
    const key = sort()
    switch (key) {
      case "newest":
        return list.sort((a, b) => b.updatedAt - a.updatedAt)
      case "oldest":
        return list.sort((a, b) => a.updatedAt - b.updatedAt)
      case "relevance":
        return list.sort((a, b) => (memorySimilarity(b) ?? 0) - (memorySimilarity(a) ?? 0))
    }
    return list
  })

  const availableSorts = createMemo<MemorySortKey[]>(() => {
    const base: MemorySortKey[] = ["newest", "oldest"]
    if (props.isSearching) base.push("relevance")
    return base
  })

  function toggleCard(id: string) {
    if (selecting()) {
      toggleSelect(id)
      return
    }
    const item = memories().find((entry) => entry.id === id)
    if (!item) return
    const restoreFocus = capturePanelFocusReturn()
    setExpandedCards(new Set([id]))
    detailDialog = dialog.show(
      () => (
        <Dialog
          size="wide"
          class="app-panel-detail-dialog library-detail-dialog"
          title={_({ id: "app.library.nav.memories", message: "Memories" })}
        >
          <MemoryCard
            item={item}
            detailPresentation
            expanded={expandedCards().has(id)}
            similarity={memorySimilarity(item)}
            searching={props.isSearching}
            selecting={false}
            selected={false}
            onToggle={() => dialog.close(detailDialog)}
            onDelete={(event) => deleteMemory(id, event)}
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

  function selectAll() {
    const ids = sorted().map((m) => m.id)
    setSelected(new Set(ids))
  }

  function deleteSelected() {
    const ids = [...selected()]
    if (ids.length === 0) return
    confirm.show({
      ...deleteLibraryItemsConfirm("memory", ids.length),
      onConfirm: () => performDeleteSelected(ids),
    })
  }

  async function performDeleteSelected(ids: string[]) {
    setDeleting(true)
    try {
      await Promise.all(ids.map((id) => props.sdk.client.library.remove({ id }, { throwOnError: true })))
      setExpandedCards((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      collection.discard((item) => ids.includes(item.id))
      exitSelection()
      await refetch()
      props.refetchStats()
    } finally {
      setDeleting(false)
    }
  }

  function exitSelection() {
    setSelecting(false)
    setSelected(new Set<string>())
  }

  function deleteMemory(id: string, e: MouseEvent) {
    e.stopPropagation()
    confirm.show({
      ...deleteLibraryItemsConfirm("memory", 1),
      onConfirm: () => performDeleteMemory(id),
      onConfirmed: () => {
        if (detailDialog) dialog.close(detailDialog)
      },
    })
  }

  async function performDeleteMemory(id: string) {
    await props.sdk.client.library.remove({ id }, { throwOnError: true })
    collection.discard((item) => item.id === id)
    setExpandedCards((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await refetch()
    props.refetchStats()
  }

  const categoryCounts = createMemo(() => {
    const counts = new Map<string, number>()
    for (const m of memories() ?? []) {
      const cat = m.category
      if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return counts
  })

  const filterLabel = createMemo(() => {
    const count = categoryFilter().size
    if (count === 0) return _({ id: "app.library.memory.allCategories", message: "All categories" })
    if (count === 1) return getCategoryLabel(_, [...categoryFilter()][0])
    return _({
      id: "app.library.memory.categoriesCount",
      message: "{count} categories",
      values: { count: String(count) },
    })
  })

  return (
    <div class="library-list-pane" data-panel-list>
      <Show
        when={!selecting()}
        fallback={
          <SelectionBar
            count={selected().size}
            total={sorted().length}
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
              multiple
              value={[...categoryFilter()]}
              ariaLabel={_({ id: "app.library.memory.filter.aria", message: "Filter memories by category" })}
              triggerLabel={filterLabel()}
              placement="bottom-start"
              surfaceClass="library-filter-menu"
              options={MEMORY_CATEGORIES.filter((cat) => (categoryCounts().get(cat) ?? 0) > 0).map((cat) => ({
                value: cat,
                label: getCategoryLabel(_, cat),
                count: categoryCounts().get(cat) ?? 0,
              }))}
              onChange={(values) => setCategoryFilter(new Set(values as MemoryCategory[]))}
              leading={(close) => (
                <button
                  type="button"
                  class="menu-field-item"
                  classList={{ "is-active": categoryFilter().size === 0 }}
                  onClick={() => {
                    setCategoryFilter(new Set<MemoryCategory>())
                    close()
                  }}
                >
                  <span class="menu-field-item-label">
                    {_({ id: "app.library.memory.allCategories", message: "All categories" })}
                  </span>
                  <span class="menu-field-count">{memories()?.length ?? 0}</span>
                  <span class="menu-field-check" aria-hidden="true">
                    <Show when={categoryFilter().size === 0}>
                      <Icon name={getSemanticIcon("state.success")} size="small" />
                    </Show>
                  </span>
                </button>
              )}
            />
            <Show when={categoryFilter().size > 0}>
              <button type="button" class={libraryActionButtonClass} onClick={() => setCategoryFilter(new Set())}>
                {_({ id: "app.library.clearFilters", message: "Clear filters" })}
              </button>
            </Show>
            <span class="library-toolbar-summary">
              {_({
                id: "app.library.memory.count",
                message: "{count} memories",
                values: { count: String(sorted().length) },
              })}
            </span>
          </div>
          <div class="library-toolbar-right">
            <Show when={sorted().length > 0}>
              <button type="button" class={libraryActionButtonClass} onClick={() => setSelecting(true)}>
                <Icon name={getSemanticIcon("notes.select")} size="small" class="opacity-70" />
                <span>{_({ id: "app.library.select", message: "Select" })}</span>
              </button>
            </Show>
            <MenuField
              value={sort()}
              ariaLabel={_({ id: "app.library.memory.sort.aria", message: "Sort memories" })}
              triggerClass={`menu-field-trigger ${libraryActionButtonClass}`}
              placement="bottom-end"
              options={availableSorts().map((key) => ({ value: key, label: getMemorySortLabel(_, key) }))}
              onChange={(value) => setSort(value as MemorySortKey)}
            />
          </div>
        </div>
      </Show>

      <Show when={collection.error()}>
        <div class="library-home-notice" role="alert">
          <span>{_({ id: "app.library.memory.loadFailed", message: "Unable to load memories." })}</span>
          <button type="button" disabled={collection.loading()} onClick={() => void refetch()}>
            {_({ id: "app.library.stats.retry", message: "Retry" })}
          </button>
        </div>
      </Show>
      <Show when={collection.loading() && !memories().length}>
        <AppPanel.Loading />
      </Show>

      <Show when={(!collection.loading() || memories().length > 0) && (!collection.error() || memories().length > 0)}>
        <Show
          when={sorted().length > 0}
          fallback={
            <AppPanel.Empty
              icon={getSemanticIcon("memory.main")}
              title={
                props.isSearching || categoryFilter().size > 0
                  ? _({ id: "app.library.memory.empty.filter", message: "No memories match the filter" })
                  : _({ id: "app.library.memory.empty.none", message: "No memories yet" })
              }
              action={
                categoryFilter().size > 0 ? (
                  <button type="button" class={libraryActionButtonClass} onClick={() => setCategoryFilter(new Set())}>
                    {_({ id: "app.library.clearFilters", message: "Clear filters" })}
                  </button>
                ) : undefined
              }
              description={_({
                id: "app.library.memory.empty.hint",
                message:
                  "Memories are created when sessions compact. They capture knowledge the agent learns over time.",
              })}
            />
          }
        >
          <div class="library-result-list">
            <For each={sorted()}>
              {(item) => (
                <MemoryCard
                  item={item}
                  expanded={false}
                  similarity={memorySimilarity(item)}
                  searching={props.isSearching}
                  selecting={selecting()}
                  selected={selected().has(item.id)}
                  onToggle={() => toggleCard(item.id)}
                  onDelete={(event) => deleteMemory(item.id, event)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export function MemoryCard(props: {
  item: MemoryItem
  detailPresentation?: boolean
  expanded: boolean
  similarity: number | undefined
  searching: boolean
  selecting: boolean
  selected: boolean
  onToggle: () => void
  onDelete?: (e: MouseEvent) => void
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const updated = () => props.item.updatedAt
  const category = () => props.item.category as MemoryCategory | undefined
  const recallMode = () => props.item.recallMode as MemoryRecallMode | undefined

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
          {/* item.title is user/agent content — pass through */}
          <Dynamic
            data-panel-focus-entry={props.detailPresentation ? undefined : true}
            component={props.detailPresentation ? "h2" : "button"}
            type={props.detailPresentation ? undefined : "button"}
            class="library-card-toggle flex items-start gap-2 text-left app-panel-row-title text-text-strong flex-1 min-w-0 leading-snug"
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
              {props.expanded && !props.selecting ? (
                props.item.title
              ) : (
                <span class="line-clamp-2">{props.item.title}</span>
              )}
            </span>
          </Dynamic>
          <div class="library-memory-meta app-panel-caption text-text-weak">
            <Show when={category()}>
              <span class="app-panel-caption text-text-weak">{getCategoryLabel(_, category()!) ?? category()}</span>
            </Show>
            <Show when={recallMode()}>
              <span class="app-panel-caption text-text-weak">
                {getRecallModeLabel(_, recallMode()!) ?? recallMode()}
              </span>
            </Show>
            <Show when={props.searching && props.similarity !== undefined}>
              <span class="app-panel-caption text-text-weak">
                {_({
                  id: "app.library.memory.similarityPercent",
                  message: "{pct}%",
                  values: { pct: String(Math.round(props.similarity! * 100)) },
                })}
              </span>
            </Show>
            <Show when={props.expanded && !props.selecting && props.onDelete}>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base"
                onClick={props.onDelete}
                aria-label={_({ id: "app.library.memory.delete", message: "Delete memory" })}
              >
                <Icon name={getSemanticIcon("action.remove")} size="small" />
              </button>
            </Show>
          </div>
        </div>

        <Show when={!props.selecting}>
          <Show
            when={props.expanded}
            fallback={
              // item.content is user/agent content — pass through
              <div class="app-panel-copy leading-relaxed text-text-weak/90 line-clamp-2">{props.item.content}</div>
            }
          >
            <div class={`px-3.5 py-3 ${libraryInsetClass}`}>
              <Markdown
                text={props.item.content}
                class="library-detail-markdown [&_h1]:app-panel-control [&_h2]:app-panel-control [&_h3]:app-panel-caption font-medium [&_pre]:app-panel-caption [&_code]:app-panel-caption [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_pre]:my-1.5 [&_pre]:rounded-xl [&_pre]:bg-surface-raised-base/78 [&_pre]:p-2.5"
              />
            </div>
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
                    id: "app.library.memory.updated",
                    message: "· updated {date}",
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
                    ? _({ id: "app.library.memory.collapse", message: "Collapse memory" })
                    : _({ id: "app.library.memory.expand", message: "View memory" })
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
