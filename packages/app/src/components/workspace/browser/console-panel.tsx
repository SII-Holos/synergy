import { For, Show, createEffect, on } from "solid-js"
import { BrowserStore, type ConsoleEntry } from "./browser-store"

const LEVEL_COLORS: Record<string, string> = {
  log: "text-text-subtle bg-surface-base",
  info: "text-blue-400 bg-blue-500/10",
  warn: "text-amber-400 bg-amber-500/10",
  error: "text-red-400 bg-red-500/10",
  debug: "text-purple-400 bg-purple-500/10",
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ConsolePanel() {
  let scrollEl: HTMLDivElement | undefined

  // Auto-scroll to bottom when entries change
  createEffect(
    on(
      () => {
        const tabId = BrowserStore.activeTabId()
        if (!tabId) return 0
        return BrowserStore.tabConsole()[tabId]?.length ?? 0
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
    const tabId = BrowserStore.activeTabId()
    if (!tabId) return []
    return BrowserStore.tabConsole()[tabId] ?? []
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
              const colorClass = LEVEL_COLORS[level] ?? LEVEL_COLORS.log

              return (
                <div class="flex gap-2 px-3 py-1 border-b border-border-weaker-base text-12-regular leading-relaxed hover:bg-surface-inset-base/40">
                  <span
                    class={`shrink-0 inline-flex items-center justify-center h-5 px-1.5 rounded text-10-medium uppercase ${colorClass}`}
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
