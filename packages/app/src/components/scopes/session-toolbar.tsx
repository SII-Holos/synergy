import { createSignal, Show, For, onCleanup } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

interface SessionToolbarProps {
  search: string
  onSearch: (value: string) => void
  filter: "all" | "pinned"
  onFilterChange: (filter: "all" | "pinned") => void
  pageSize: number
  onPageSizeChange: (size: number) => void
}

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const

const FILTER_LABELS: Record<SessionToolbarProps["filter"], string> = {
  all: "All",
  pinned: "Pinned",
}

export function SessionToolbar(props: SessionToolbarProps) {
  const [pageSizeOpen, setPageSizeOpen] = createSignal(false)

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (!target.closest("[data-page-size-dropdown]")) {
      setPageSizeOpen(false)
    }
  }

  function togglePageSize() {
    const next = !pageSizeOpen()
    setPageSizeOpen(next)
    if (next) {
      document.addEventListener("click", handleClickOutside, { once: true })
    }
  }

  onCleanup(() => {
    document.removeEventListener("click", handleClickOutside)
  })

  return (
    <div class="flex items-center gap-2 px-6 py-2 border-b border-border-weaker-base/40">
      {/* Search */}
      <div class="flex items-center gap-2.5 rounded-xl bg-surface-inset-base/60 px-3.5 py-2 flex-1 max-w-sm transition-colors focus-within:ring-1 focus-within:ring-border-interactive-base/50">
        <Icon name="search" size="small" class="text-icon-weak shrink-0" />
        <input
          type="text"
          placeholder="Search sessions..."
          class="flex-1 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
          value={props.search}
          onInput={(e) => props.onSearch(e.currentTarget.value)}
        />
        <Show when={props.search}>
          <button
            type="button"
            class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base transition-colors"
            onClick={() => props.onSearch("")}
          >
            <Icon name="x" size="small" />
          </button>
        </Show>
      </div>

      {/* Filter Chips */}
      <div class="flex items-center gap-1">
        <For each={["all", "pinned"] as const}>
          {(filter) => (
            <button
              type="button"
              classList={{
                "px-2.5 py-1 rounded-lg text-12-medium transition-colors": true,
                "bg-surface-raised-base-hover text-text-strong": props.filter === filter,
                "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": props.filter !== filter,
              }}
              onClick={() => props.onFilterChange(filter)}
            >
              {FILTER_LABELS[filter]}
            </button>
          )}
        </For>
      </div>

      <span class="flex-1" />

      {/* Page Size Selector */}
      <div class="relative" data-page-size-dropdown>
        <button
          type="button"
          class="px-2.5 py-1 rounded-lg text-11-medium text-text-weak bg-surface-inset-base/60 hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
          onClick={togglePageSize}
        >
          {props.pageSize} / page
        </button>
        <Show when={pageSizeOpen()}>
          <div class="absolute right-0 top-full mt-1 z-50 min-w-[5.5rem] rounded-lg border border-border-base/50 bg-surface-raised-base shadow-lg py-1">
            <For each={PAGE_SIZE_OPTIONS}>
              {(size) => (
                <button
                  type="button"
                  classList={{
                    "w-full flex items-center gap-2 px-2.5 py-1.5 text-11-medium transition-colors": true,
                    "text-text-strong": props.pageSize === size,
                    "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": props.pageSize !== size,
                  }}
                  onClick={() => {
                    props.onPageSizeChange(size)
                    setPageSizeOpen(false)
                  }}
                >
                  <span class="w-3 flex items-center justify-center">
                    <Show when={props.pageSize === size}>
                      <Icon name="check" size="small" />
                    </Show>
                  </span>
                  {size}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
