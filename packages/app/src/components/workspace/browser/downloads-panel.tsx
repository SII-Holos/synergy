import { For, Show, createMemo } from "solid-js"
import { useBrowser, type DownloadEntry } from "./browser-store"

const STATE_META: Record<DownloadEntry["state"], { label: string; color: string; bg: string }> = {
  in_progress: { label: "Downloading", color: "text-text-on-info-base", bg: "bg-surface-info-weak" },
  completed: { label: "Complete", color: "text-text-on-success-base", bg: "bg-surface-success-weak" },
  cancelled: { label: "Cancelled", color: "text-text-weaker", bg: "bg-surface-inset-base" },
  interrupted: { label: "Interrupted", color: "text-text-on-warning-base", bg: "bg-surface-warning-weak" },
  blocked: { label: "Blocked", color: "text-text-on-critical-base", bg: "bg-surface-critical-weak" },
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${BYTE_UNITS[i]}`
}

function truncateUrl(url: string, max = 60): string {
  if (url.length <= max) return url
  return url.slice(0, max - 3) + "..."
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function DownloadsPanel() {
  const { pageId: currentPageId, downloads } = useBrowser()

  const entries = createMemo((): DownloadEntry[] => {
    const pageId = currentPageId()
    if (!pageId) return []
    return downloads[pageId] ?? []
  })

  return (
    <div class="flex flex-col h-full">
      <Show
        when={entries().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-subtle">No downloads</div>
        }
      >
        <div class="flex-1 overflow-y-auto font-mono">
          <div class="sticky top-0 z-10 flex gap-2 px-3 py-1.5 bg-surface-raised-base border-b border-border-weak-base text-11-medium text-text-weak uppercase tracking-wider">
            <span class="w-20 shrink-0">State</span>
            <span class="w-32 shrink-0">File</span>
            <span class="w-16 shrink-0">Size</span>
            <span class="flex-1">URL</span>
            <span class="w-16 shrink-0 text-right">Time</span>
          </div>
          <For each={entries()}>
            {(entry) => {
              const meta = STATE_META[entry.state] ?? STATE_META.in_progress

              return (
                <div class="flex gap-2 px-3 py-1.5 border-b border-border-weaker-base text-12-regular leading-relaxed hover:bg-surface-inset-base/40">
                  <span class="w-20 shrink-0">
                    <span class={`inline-flex items-center px-1.5 rounded text-10-medium ${meta.color} ${meta.bg}`}>
                      {meta.label}
                    </span>
                  </span>
                  <span
                    class="w-32 shrink-0 text-text-strong truncate"
                    title={entry.warning ?? `${entry.fileName} (${entry.mimeType})`}
                  >
                    {entry.fileName || "—"}
                  </span>
                  <span class="w-16 shrink-0 text-text-weaker tabular-nums">
                    <Show
                      when={entry.state === "in_progress" && entry.totalBytes > 0}
                      fallback={formatBytes(entry.receivedBytes)}
                    >
                      {formatBytes(entry.receivedBytes)} / {formatBytes(entry.totalBytes)}
                    </Show>
                  </span>
                  <span class="flex-1 text-text-strong truncate" title={entry.url}>
                    {truncateUrl(entry.url)}
                  </span>
                  <span class="w-16 shrink-0 text-text-weaker tabular-nums text-right">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
