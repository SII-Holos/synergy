import { For, Show, createMemo } from "solid-js"
import { useBrowser, type AccessibilityElement } from "./browser-store"

function flatten(elements: AccessibilityElement[], depth = 0): Array<AccessibilityElement & { depth: number }> {
  const rows: Array<AccessibilityElement & { depth: number }> = []
  for (const el of elements) {
    rows.push({ ...el, depth })
    rows.push(...flatten(el.children ?? [], depth + 1))
  }
  return rows
}

export function ElementsPanel() {
  const { pageId: currentPageId, elements } = useBrowser()
  const rows = createMemo(() => {
    const pageId = currentPageId()
    if (!pageId) return []
    return flatten(elements[pageId] ?? [])
  })

  return (
    <div class="flex h-full flex-col">
      <Show
        when={rows().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-subtle">
            Request a snapshot to inspect elements
          </div>
        }
      >
        <div class="flex-1 overflow-y-auto font-mono">
          <For each={rows()}>
            {(row) => (
              <div class="flex gap-2 border-b border-border-weaker-base px-3 py-1 text-12 hover:bg-surface-inset-base/40">
                <span class="w-12 shrink-0 text-text-weaker" style={{ "padding-left": `${row.depth * 10}px` }}>
                  {row.ref}
                </span>
                <span class="w-24 shrink-0 text-text-weak">{row.role}</span>
                <span class="min-w-0 flex-1 truncate text-text-strong">{row.name || row.value || "—"}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
