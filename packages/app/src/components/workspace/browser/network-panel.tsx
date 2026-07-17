import { For, Show, createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useBrowser, type NetworkEntry } from "./browser-store"
import { networkPanel as P } from "@/locales/messages"

const METHOD_COLOR_CLASSES: Record<string, string> = {
  GET: "text-chart-series-3",
  POST: "text-chart-series-5",
  PUT: "text-chart-series-4",
  PATCH: "text-chart-series-4",
  DELETE: "text-chart-series-7",
}

function statusLabel(status: number | undefined): string {
  if (status == null) return "---"
  return String(status)
}

function statusColorClass(status: number | undefined): string {
  if (status == null) return "text-text-weaker"
  if (status < 200) return "text-text-subtle"
  if (status < 300) return "text-text-on-success-base"
  if (status < 400) return "text-text-on-info-base"
  if (status < 500) return "text-text-on-warning-base"
  return "text-text-on-critical-base"
}

function truncateUrl(url: string, max = 80): string {
  if (url.length <= max) return url
  return url.slice(0, max - 3) + "..."
}

export function NetworkPanel() {
  const { pageId: currentPageId, networkRequests } = useBrowser()
  const lingui = useLingui()

  const requests = createMemo((): NetworkEntry[] => {
    const pageId = currentPageId()
    if (!pageId) return []
    return networkRequests[pageId] ?? []
  })

  return (
    <div class="flex flex-col h-full">
      <Show
        when={requests().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-subtle">
            {lingui._({ id: P.empty.id, message: P.empty.message })}
          </div>
        }
      >
        <div class="flex-1 overflow-y-auto font-mono">
          <div class="sticky top-0 z-10 flex gap-2 px-3 py-1.5 bg-surface-raised-base border-b border-border-weak-base text-11-medium text-text-weak uppercase tracking-wider">
            <span class="w-12 shrink-0">{lingui._({ id: P.statusCol.id, message: P.statusCol.message })}</span>
            <span class="w-14 shrink-0">{lingui._({ id: P.methodCol.id, message: P.methodCol.message })}</span>
            <span class="w-28 shrink-0">{lingui._({ id: P.typeCol.id, message: P.typeCol.message })}</span>
            <span class="flex-1">{lingui._({ id: P.urlCol.id, message: P.urlCol.message })}</span>
          </div>
          <For each={requests()}>
            {(req) => (
              <div class="flex gap-2 px-3 py-1 border-b border-border-weaker-base text-12-regular leading-relaxed hover:bg-surface-inset-base/40">
                <span class={`w-12 shrink-0 tabular-nums ${statusColorClass(req.status)}`}>
                  {statusLabel(req.status)}
                </span>
                <span class={`w-14 shrink-0 ${METHOD_COLOR_CLASSES[req.method] ?? "text-text-base"}`}>
                  {req.method}
                </span>
                <span class="w-28 shrink-0 text-text-weaker truncate">{req.type || "---"}</span>
                <span class="flex-1 text-text-strong truncate" title={req.url}>
                  {truncateUrl(req.url)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
