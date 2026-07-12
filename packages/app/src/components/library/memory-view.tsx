import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteLibraryItemsConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel } from "@/components/app-panel"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { MemoryInfo, MemorySearchResult } from "@ericsanchezok/synergy-sdk/client"
import {
  type MemoryCategory,
  type MemoryRecallMode,
  type MemorySortKey,
  MEMORY_CATEGORIES,
  categoryLabels,
  categoryColors,
  recallModeLabels,
  recallModeColors,
  memorySortLabels,
  libraryActionButtonClass,
  libraryCardBaseClass,
  libraryCardExpandedClass,
  libraryCardHoverClass,
  libraryInsetClass,
  libraryMenuClass,
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
  isSearching: boolean
  setSearchError: (v: boolean) => void
  refetchStats: () => void
}) {
  const confirm = useConfirm()
  const [sort, setSort] = createSignal<MemorySortKey>("newest")
  const [sortOpen, setSortOpen] = createSignal(false)
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [categoryFilter, setCategoryFilter] = createSignal<Set<MemoryCategory>>(new Set())
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set())
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [deleting, setDeleting] = createSignal(false)

  const [memories, { refetch }] = createResource<MemoryItem[], string>(
    () => props.search,
    async (query) => {
      if (query) {
        try {
          const result = await props.sdk.client.library.search({ query, topK: 50 })
          return (result.data ?? []) as MemorySearchItem[]
        } catch {
          props.setSearchError(true)
          return []
        }
      }
      const result = await props.sdk.client.library.list()
      return result.data ?? []
    },
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

  const leftColumn = createMemo(() => sorted().filter((_, i) => i % 2 === 0))
  const rightColumn = createMemo(() => sorted().filter((_, i) => i % 2 === 1))

  const availableSorts = createMemo<MemorySortKey[]>(() => {
    const base: MemorySortKey[] = ["newest", "oldest"]
    if (props.isSearching) base.push("relevance")
    return base
  })

  function toggleCategory(cat: MemoryCategory) {
    setCategoryFilter((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  function toggleCard(id: string) {
    if (selecting()) {
      toggleSelect(id)
      return
    }
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
      await Promise.all(ids.map((id) => props.sdk.client.library.remove({ id })))
      setExpandedCards((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      exitSelection()
      refetch()
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
    })
  }

  async function performDeleteMemory(id: string) {
    await props.sdk.client.library.remove({ id })
    setExpandedCards((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    refetch()
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
    if (count === 0) return "All categories"
    if (count === 1) return categoryLabels[[...categoryFilter()][0]]
    return `${count} categories`
  })

  return (
    <div class="library-list-pane">
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
            <Popover open={filterOpen()} onOpenChange={setFilterOpen} placement="bottom-start" gutter={6}>
              <Popover.Trigger as="button" class="library-control-pill">
                <span>{filterLabel()}</span>
                <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="opacity-60" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content class={`library-filter-menu ${libraryMenuClass}`}>
                  <button
                    type="button"
                    classList={{
                      "library-menu-item": true,
                      "is-active": categoryFilter().size === 0,
                    }}
                    onClick={() => {
                      setCategoryFilter(new Set<MemoryCategory>())
                      setFilterOpen(false)
                    }}
                  >
                    <span>All categories</span>
                    <span class="library-menu-count">{memories()?.length ?? 0}</span>
                  </button>
                  <For each={MEMORY_CATEGORIES}>
                    {(cat) => {
                      const count = () => categoryCounts().get(cat) ?? 0
                      return (
                        <Show when={count() > 0}>
                          <button
                            type="button"
                            classList={{
                              "library-menu-item": true,
                              "is-active": categoryFilter().has(cat),
                            }}
                            onClick={() => toggleCategory(cat)}
                          >
                            <span>{categoryLabels[cat]}</span>
                            <span class="library-menu-count">{count()}</span>
                          </button>
                        </Show>
                      )
                    }}
                  </For>
                </Popover.Content>
              </Popover.Portal>
            </Popover>
            <span class="library-toolbar-summary">{sorted().length} memories</span>
          </div>
          <div class="library-toolbar-right">
            <Show when={sorted().length > 0}>
              <button type="button" class={libraryActionButtonClass} onClick={() => setSelecting(true)}>
                <Icon name={getSemanticIcon("notes.select")} size="small" class="opacity-70" />
                <span>Select</span>
              </button>
            </Show>
            <Popover open={sortOpen()} onOpenChange={setSortOpen} placement="bottom-end" gutter={6}>
              <Popover.Trigger as="button" class={libraryActionButtonClass}>
                <span>{memorySortLabels[sort()]}</span>
                <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="opacity-60" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content class={libraryMenuClass}>
                  <For each={availableSorts()}>
                    {(key) => (
                      <button
                        type="button"
                        classList={{
                          "w-full rounded-[0.8rem] px-3 py-2 text-left text-12-medium transition-colors": true,
                          "workbench-selected-surface text-text-strong": sort() === key,
                          "text-text-base hover:bg-surface-inset-base": sort() !== key,
                        }}
                        onClick={() => {
                          setSort(key)
                          setSortOpen(false)
                        }}
                      >
                        {memorySortLabels[key]}
                      </button>
                    )}
                  </For>
                </Popover.Content>
              </Popover.Portal>
            </Popover>
          </div>
        </div>
      </Show>

      <Show when={memories.loading}>
        <AppPanel.Loading />
      </Show>

      <Show when={!memories.loading}>
        <Show
          when={sorted().length > 0}
          fallback={
            <AppPanel.Empty
              icon={getSemanticIcon("memory.main")}
              title={categoryFilter().size > 0 ? "No memories match the filter" : "No memories yet"}
              description="Memories are created when sessions compact. They capture knowledge the agent learns over time."
            />
          }
        >
          <div class="library-card-grid">
            <div class="min-w-0 flex flex-col gap-3">
              <For each={leftColumn()}>
                {(item) => (
                  <MemoryCard
                    item={item}
                    expanded={expandedCards().has(item.id)}
                    similarity={memorySimilarity(item)}
                    searching={props.isSearching}
                    selecting={selecting()}
                    selected={selected().has(item.id)}
                    onToggle={() => toggleCard(item.id)}
                    onDelete={(e) => deleteMemory(item.id, e)}
                  />
                )}
              </For>
            </div>
            <div class="min-w-0 flex flex-col gap-3">
              <For each={rightColumn()}>
                {(item) => (
                  <MemoryCard
                    item={item}
                    expanded={expandedCards().has(item.id)}
                    similarity={memorySimilarity(item)}
                    searching={props.isSearching}
                    selecting={selecting()}
                    selected={selected().has(item.id)}
                    onToggle={() => toggleCard(item.id)}
                    onDelete={(e) => deleteMemory(item.id, e)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function MemoryCard(props: {
  item: MemoryItem
  expanded: boolean
  similarity: number | undefined
  searching: boolean
  selecting: boolean
  selected: boolean
  onToggle: () => void
  onDelete: (e: MouseEvent) => void
}) {
  const updated = () => props.item.updatedAt
  const category = () => props.item.category as MemoryCategory | undefined
  const recallMode = () => props.item.recallMode as MemoryRecallMode | undefined

  return (
    <div
      classList={{
        [`${libraryCardBaseClass} cursor-pointer`]: true,
        [libraryCardExpandedClass]: props.expanded && !props.selecting,
        [libraryCardHoverClass]: !props.expanded && !props.selecting,
        "workbench-selected-surface ring-1 ring-inset ring-border-base/32": props.selecting && props.selected,
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
          <span class="text-13-medium text-text-strong flex-1 min-w-0 leading-snug">
            {props.expanded && !props.selecting ? (
              props.item.title
            ) : (
              <span class="line-clamp-2">{props.item.title}</span>
            )}
          </span>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Show when={category()}>
              <span
                class={`rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ring-border-base/10 ${categoryColors[category()!] ?? "bg-surface-inset-base text-text-weak"}`}
              >
                {categoryLabels[category()!] ?? category()}
              </span>
            </Show>
            <Show when={recallMode()}>
              <span
                class={`rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ring-border-base/10 ${recallModeColors[recallMode()!] ?? "bg-surface-inset-base text-text-weaker"}`}
              >
                {recallModeLabels[recallMode()!] ?? recallMode()}
              </span>
            </Show>
            <Show when={props.searching && props.similarity !== undefined}>
              <span class="rounded-full bg-surface-inset-base px-2.5 py-1 text-[10px] font-medium text-text-base ring-1 ring-inset ring-border-base/35">
                {Math.round(props.similarity! * 100)}%
              </span>
            </Show>
            <Show when={props.expanded && !props.selecting}>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base"
                onClick={props.onDelete}
              >
                <Icon name={getSemanticIcon("action.close")} size="small" />
              </button>
            </Show>
          </div>
        </div>

        <Show when={!props.selecting}>
          <Show
            when={props.expanded}
            fallback={
              <div class="text-12-regular leading-relaxed text-text-weak/90 line-clamp-3">{props.item.content}</div>
            }
          >
            <div class={`px-3.5 py-3 ${libraryInsetClass}`}>
              <Markdown
                text={props.item.content}
                class="text-12-regular leading-relaxed text-text-weak/90 [&_h1]:text-13-medium [&_h2]:text-13-medium [&_h3]:text-12-medium [&_pre]:text-11-regular [&_code]:text-11-regular [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_pre]:my-1.5 [&_pre]:rounded-xl [&_pre]:bg-surface-raised-base/78 [&_pre]:p-2.5"
              />
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
                "flex size-6 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak-base ring-1 ring-inset ring-border-base/35 transition-all": true,
                "rotate-180 bg-surface-raised-base-hover": props.expanded,
              }}
            >
              <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
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
