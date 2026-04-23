import { For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

interface PaginationBarProps {
  total: number
  currentPage: number
  totalPages: number
  pageSize: number
  onPageChange: (page: number) => void
  loading?: boolean
}

export function getPageNumbers(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const pages: Set<number | "ellipsis"> = new Set()

  pages.add(1)
  pages.add(total)

  for (const p of [current - 1, current, current + 1]) {
    if (p >= 1 && p <= total) pages.add(p)
  }

  const sorted = [...pages].sort((a, b) => {
    if (a === "ellipsis" || b === "ellipsis") return 0
    return a - b
  })

  const result: Array<number | "ellipsis"> = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const prev = sorted[i - 1]
      const curr = sorted[i]
      if (prev !== "ellipsis" && curr !== "ellipsis" && curr - prev > 1) {
        result.push("ellipsis")
      }
    }
    result.push(sorted[i])
  }

  return result
}

export function PaginationBar(props: PaginationBarProps) {
  return (
    <div class="sticky bottom-0 bg-background-base/90 backdrop-blur-sm border-t border-border-weaker-base/60 px-6 py-2 flex items-center justify-between">
      <span class="text-11-regular text-text-weak">
        {props.total} session{props.total !== 1 ? "s" : ""}
      </span>

      <div class="flex items-center gap-1">
        <button
          class="px-2 py-1 text-11-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover rounded-md transition-colors disabled:opacity-40 disabled:cursor-default"
          disabled={props.currentPage <= 1 || props.loading}
          onClick={() => props.onPageChange(props.currentPage - 1)}
        >
          <Icon name="arrow-left" size="small" />
        </button>

        <For each={getPageNumbers(props.currentPage, props.totalPages)}>
          {(item) => (
            <Show when={item !== "ellipsis"} fallback={<span class="text-text-weak px-1">…</span>}>
              <button
                class={`min-w-[1.5rem] px-1.5 py-0.5 text-11-regular rounded-md transition-colors ${
                  item === props.currentPage
                    ? "bg-surface-raised-base-hover text-text-strong font-medium"
                    : "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover"
                }`}
                disabled={item === props.currentPage || props.loading}
                onClick={() => props.onPageChange(item as number)}
              >
                {item}
              </button>
            </Show>
          )}
        </For>

        <button
          class="px-2 py-1 text-11-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover rounded-md transition-colors disabled:opacity-40 disabled:cursor-default"
          disabled={props.currentPage >= props.totalPages || props.loading}
          onClick={() => props.onPageChange(props.currentPage + 1)}
        >
          <Icon name="arrow-right" size="small" />
        </button>
      </div>
    </div>
  )
}
