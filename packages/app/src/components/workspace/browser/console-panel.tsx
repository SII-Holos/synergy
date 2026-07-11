import { For, Show, createEffect, on } from "solid-js"
import { useBrowser, type ConsoleEntry } from "./browser-store"

const LEVEL_CLASSES: Record<string, string> = {
  log: "text-text-subtle bg-surface-base",
  info: "text-text-on-info-base bg-surface-info-weak",
  warn: "text-text-on-warning-base bg-surface-warning-weak",
  error: "text-text-on-critical-base bg-surface-critical-weak",
  debug: "text-text-interactive-base bg-surface-interactive-weak",
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ConsolePanel() {
  let scrollEl: HTMLDivElement | undefined
  const { pageId: currentPageId, consoleEntries } = useBrowser()

  // Auto-scroll to bottom when entries change
  createEffect(
    on(
      () => {
        const pageId = currentPageId()
        if (!pageId) return 0
        return consoleEntries[pageId]?.length ?? 0
      },
      () => {
        if (!scrollEl) return
        requestAnimationFrame(() => {
          scrollEl!.scrollTop = scrollEl!.scrollHeight
        })
      },
    ),
  )

  const entries = (): ConsoleEntry[] => {
    const pageId = currentPageId()
    if (!pageId) return []
    return consoleEntries[pageId] ?? []
  }

  return (
    <div class="flex flex-col h-full">
      <Show
        when={entries().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-subtle">No console entries</div>
        }
      >
        <div ref={scrollEl} class="flex-1 overflow-y-auto font-mono">
          <For each={entries()}>
            {(entry) => {
              const level = entry.level
              const levelClasses = LEVEL_CLASSES[level] ?? LEVEL_CLASSES.log

              return (
                <div class="flex gap-2 px-3 py-1 border-b border-border-weaker-base text-12-regular leading-relaxed hover:bg-surface-inset-base/40">
                  <span
                    class={`shrink-0 inline-flex items-center justify-center h-5 px-1.5 rounded text-10-medium uppercase ${levelClasses}`}
                  >
                    {level}
                  </span>
                  <span class="shrink-0 text-text-weaker tabular-nums">{formatTime(entry.timestamp)}</span>
                  <span class="text-text-strong whitespace-pre-wrap break-all">{entry.text}</span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
