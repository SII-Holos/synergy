import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { useGlobalSDK } from "@/context/global-sdk"
import { Panel } from "@/components/panel"
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
  onRegisterRefetch: (fn: () => void) => void
  refetchStats: () => void
}) {
  const [sort, setSort] = createSignal<MemorySortKey>("newest")
  const [sortOpen, setSortOpen] = createSignal(false)
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
          const result = await props.sdk.client.engram.search({ query, topK: 50 })
          return (result.data ?? []) as MemorySearchItem[]
        } catch {
          props.setSearchError(true)
          return []
        }
      }
      const result = await props.sdk.client.engram.list()
      return result.data ?? []
    },
  )

  props.onRegisterRefetch(() => refetch())

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

  async function deleteSelected() {
    const ids = [...selected()]
    if (ids.length === 0) return
    setDeleting(true)
    try {
      await Promise.all(ids.map((id) => props.sdk.client.engram.remove({ id })))
      setExpandedCards((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      exitSelection()
      refetch()
      props.refetchStats()
    } catch {}
    setDeleting(false)
  }

  function exitSelection() {
    setSelecting(false)
    setSelected(new Set<string>())
  }

  async function deleteMemory(id: string, e: MouseEvent) {
    e.stopPropagation()
    try {
      await props.sdk.client.engram.remove({ id })
      setExpandedCards((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      refetch()
      props.refetchStats()
    } catch {}
  }

  const categoryCounts = createMemo(() => {
    const counts = new Map<string, number>()
    for (const m of memories() ?? []) {
      const cat = m.category
      if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    return counts
  })

  return (
    <>
      <Panel.SubHeader>
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
          <div class="flex items-center gap-1.5 flex-wrap">
            <For each={MEMORY_CATEGORIES}>
              {(cat) => {
                const count = () => categoryCounts().get(cat) ?? 0
                return (
                  <Show when={count() > 0}>
                    <Panel.FilterChip active={categoryFilter().has(cat)} onClick={() => toggleCategory(cat)}>
                      {categoryLabels[cat]}
                      <span class="ml-0.5">{count()}</span>
                    </Panel.FilterChip>
                  </Show>
                )
              }}
            </For>
            <Show when={categoryFilter().size > 0}>
              <button
                type="button"
                class="px-1.5 py-0.5 rounded-md text-11-regular text-text-weaker hover:text-text-weak transition-colors"
                onClick={() => setCategoryFilter(new Set())}
              >
                Clear
              </button>
            </Show>

            <div class="ml-auto flex items-center gap-1">
              <Show when={sorted().length > 0}>
                <button
                  type="button"
                  class="flex items-center gap-1 px-2 py-1 rounded-lg text-12-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
                  onClick={() => setSelecting(true)}
                >
                  <Icon name="square-check" size="small" class="opacity-70" />
                  <span>Select</span>
                </button>
              </Show>
              <Popover open={sortOpen()} onOpenChange={setSortOpen} placement="bottom-end" gutter={4}>
                <Popover.Trigger
                  as="button"
                  class="flex items-center gap-1 px-2 py-1 rounded-lg text-12-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
                >
                  <span>{memorySortLabels[sort()]}</span>
                  <Icon name="chevron-down" size="small" class="opacity-60" />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content class="min-w-36 rounded-xl border border-border-weak-base/40 bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden py-1.5">
                    <For each={availableSorts()}>
                      {(key) => (
                        <button
                          type="button"
                          classList={{
                            "w-full px-3 py-1.5 text-left text-13-regular transition-colors": true,
                            "text-text-interactive-base bg-surface-raised-base-hover": sort() === key,
                            "text-text-base hover:bg-surface-raised-base-hover": sort() !== key,
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
      </Panel.SubHeader>

      <Panel.Body>
        <Show when={memories.loading}>
          <Panel.Loading />
        </Show>

        <Show when={!memories.loading}>
          <Show
            when={sorted().length > 0}
            fallback={
              <Panel.Empty
                icon="brain"
                title={categoryFilter().size > 0 ? "No memories match the filter" : "No memories yet"}
                description="Memories are created when sessions compact. They capture knowledge the agent learns over time."
              />
            }
          >
            <div class="flex gap-3 items-start">
              <div class="flex-1 min-w-0 flex flex-col gap-3">
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
              <div class="flex-1 min-w-0 flex flex-col gap-3">
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
      </Panel.Body>
    </>
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
        "flex flex-col rounded-2xl bg-surface-raised-base border border-border-base/30 transition-all cursor-pointer overflow-hidden": true,
        "bg-surface-raised-base-hover shadow-md shadow-black/[0.08] border-border-base/50":
          props.expanded && !props.selecting,
        "hover:bg-surface-raised-base-hover hover:border-border-base/50": !props.expanded && !props.selecting,
        "bg-surface-interactive-base/15 ring-1 ring-text-interactive-base/40": props.selecting && props.selected,
        "hover:bg-surface-raised-base-hover/30": props.selecting && !props.selected,
      }}
      onClick={props.onToggle}
    >
      <div class="p-4 flex flex-col gap-2">
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
          <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
            <Show when={category()}>
              <span
                class={`px-1.5 py-0.5 rounded-md text-10-medium ${categoryColors[category()!] ?? "bg-surface-inset-base text-text-weak"}`}
              >
                {categoryLabels[category()!] ?? category()}
              </span>
            </Show>
            <Show when={recallMode()}>
              <span
                class={`px-1.5 py-0.5 rounded-md text-10-medium ${recallModeColors[recallMode()!] ?? "bg-surface-inset-base text-text-weaker"}`}
              >
                {recallModeLabels[recallMode()!] ?? recallMode()}
              </span>
            </Show>
            <Show when={props.searching && props.similarity !== undefined}>
              <span class="px-1.5 py-0.5 rounded-md bg-surface-interactive-base/10 text-10-medium text-text-interactive-base">
                {Math.round(props.similarity! * 100)}%
              </span>
            </Show>
            <Show when={props.expanded && !props.selecting}>
              <button
                type="button"
                class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-text-diff-delete-base hover:bg-surface-raised-base-active transition-colors"
                onClick={props.onDelete}
              >
                <Icon name="x" size="small" />
              </button>
            </Show>
          </div>
        </div>

        <Show when={!props.selecting}>
          <Show
            when={props.expanded}
            fallback={
              <div class="text-12-regular text-text-weak line-clamp-3 leading-relaxed">{props.item.content}</div>
            }
          >
            <Markdown
              text={props.item.content}
              class="text-12-regular text-text-weak leading-relaxed [&_h1]:text-13-medium [&_h2]:text-13-medium [&_h3]:text-12-medium [&_pre]:text-11-regular [&_code]:text-11-regular [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_pre]:my-1.5 [&_pre]:rounded-lg [&_pre]:p-2.5"
            />
          </Show>

          <div class="flex items-center justify-between mt-0.5">
            <span class="text-11-regular text-text-weak">
              <Show when={props.expanded} fallback={relativeTime(updated() ?? props.item.createdAt)}>
                {absoluteDate(props.item.createdAt)}
                <Show when={updated() && updated() !== props.item.createdAt}>
                  {" · updated "}
                  {absoluteDate(updated()!)}
                </Show>
              </Show>
            </span>
            <Icon
              name="chevron-down"
              size="small"
              class="text-icon-weak transition-transform"
              classList={{ "rotate-180": props.expanded }}
            />
          </div>
        </Show>

        <Show when={props.selecting}>
          <div class="flex items-center justify-between mt-0.5">
            <span class="text-11-regular text-text-weak">{relativeTime(updated() ?? props.item.createdAt)}</span>
          </div>
        </Show>
      </div>
    </div>
  )
}
