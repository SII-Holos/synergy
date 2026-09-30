import { Button } from "@ericsanchezok/synergy-ui/button"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useBrowser, type DownloadEntry } from "./browser-store"
import { downloadsPanel as P } from "@/locales/messages"

const STATE_META: Record<
  DownloadEntry["state"],
  { label: { id: string; message: string }; color: string; bg: string }
> = {
  awaiting_approval: {
    label: { id: "browser.downloads.waiting", message: "Waiting" },
    color: "text-text-on-warning-base",
    bg: "bg-surface-warning-weak",
  },
  in_progress: {
    label: P.stateDownloading,
    color: "text-text-on-info-base",
    bg: "bg-surface-info-weak",
  },
  completed: {
    label: P.stateComplete,
    color: "text-text-on-success-base",
    bg: "bg-surface-success-weak",
  },
  cancelled: {
    label: P.stateCancelled,
    color: "text-text-weaker",
    bg: "bg-surface-inset-base",
  },
  interrupted: {
    label: P.stateInterrupted,
    color: "text-text-on-warning-base",
    bg: "bg-surface-warning-weak",
  },
  blocked: {
    label: P.stateBlocked,
    color: "text-text-on-critical-base",
    bg: "bg-surface-critical-weak",
  },
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${BYTE_UNITS[i]}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function DownloadsPanel(props: { onArtifact(id: string, operation: "save" | "open" | "draft"): Promise<void> }) {
  const [busy, setBusy] = createSignal("")
  const [error, setError] = createSignal("")
  const artifact = async (id: string, operation: "save" | "open" | "draft") => {
    if (busy()) return
    setBusy(id)
    setError("")
    try {
      await props.onArtifact(id, operation)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy("")
    }
  }
  const { pageId: currentPageId, downloads, send } = useBrowser()
  const lingui = useLingui()

  const entries = createMemo((): DownloadEntry[] => {
    return [
      ...new Map(
        Object.values(downloads)
          .flat()
          .map((entry) => [entry.id, entry]),
      ).values(),
    ].sort((a, b) => b.timestamp - a.timestamp)
  })

  return (
    <div class="flex h-full flex-col overflow-auto p-4">
      <Show when={error()}>
        <p role="alert" class="mb-3 text-12 text-text-on-critical-base">
          {error()}
        </p>
      </Show>
      <Show
        when={entries().length}
        fallback={
          <div class="flex flex-1 items-center justify-center text-13 text-text-weak">
            {lingui._({ id: P.empty.id, message: P.empty.message })}
          </div>
        }
      >
        <div class="divide-y divide-border-weak-base">
          <For each={entries()}>
            {(entry) => (
              <div class="flex flex-col gap-2 py-3">
                <div class="flex items-start gap-2">
                  <span class="min-w-0 flex-1 break-all text-14-medium text-text-strong">{entry.fileName}</span>
                  <span
                    class={`shrink-0 rounded px-2 py-1 text-11 ${STATE_META[entry.state].color} ${STATE_META[entry.state].bg}`}
                  >
                    {lingui._(STATE_META[entry.state].label)}
                  </span>
                </div>
                <p class="truncate text-12 text-text-weak" title={entry.url}>
                  {entry.url}
                </p>
                <div class="flex flex-wrap items-center gap-2 text-12 text-text-weak">
                  <span>
                    {formatBytes(entry.receivedBytes)}
                    <Show when={entry.state === "in_progress" && entry.totalBytes}>
                      {" "}
                      / {formatBytes(entry.totalBytes)}
                    </Show>{" "}
                    · {formatTime(entry.timestamp)}
                  </span>
                  <Show when={entry.state === "awaiting_approval"}>
                    <Button
                      size="small"
                      onClick={() =>
                        send({ type: "download.accept", id: entry.id, pageId: entry.pageId ?? currentPageId() })
                      }
                    >
                      {lingui._({ id: "browser.downloads.accept", message: "Download" })}
                    </Button>
                  </Show>
                  <Show when={entry.state === "awaiting_approval" || entry.state === "in_progress"}>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() =>
                        send({ type: "download.cancel", id: entry.id, pageId: entry.pageId ?? currentPageId() })
                      }
                    >
                      {lingui._({ id: "browser.downloads.cancel", message: "Cancel" })}
                    </Button>
                  </Show>
                  <Show when={entry.state === "completed"}>
                    <Button size="small" disabled={Boolean(busy())} onClick={() => void artifact(entry.id, "save")}>
                      {lingui._({ id: "browser.downloads.save", message: "Save as…" })}
                    </Button>
                    <Button size="small" disabled={Boolean(busy())} onClick={() => void artifact(entry.id, "open")}>
                      {lingui._({ id: "browser.downloads.open", message: "Save and open" })}
                    </Button>
                    <Button size="small" disabled={Boolean(busy())} onClick={() => void artifact(entry.id, "draft")}>
                      {lingui._({ id: "browser.downloads.draft", message: "Add to draft" })}
                    </Button>
                  </Show>
                </div>
                <Show when={entry.warning}>
                  <p class="text-12 text-text-weak">{entry.warning}</p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
