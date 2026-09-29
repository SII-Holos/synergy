import { createSignal, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { usePlatform } from "@/context/platform"
import type { BrowserPageActionResult } from "@ericsanchezok/synergy-browser-core"

const M = {
  title: { id: "browser.capture.title", message: "Screenshot and feedback" },
  viewport: { id: "browser.capture.viewport", message: "Visible page" },
  full: { id: "browser.capture.full", message: "Full page" },
  save: { id: "browser.capture.save", message: "Save image" },
  copy: { id: "browser.capture.copy", message: "Copy image" },
  copied: { id: "browser.capture.copied", message: "Image copied." },
  hint: {
    id: "browser.capture.hint",
    message: "Click the image to mark a location. Add feedback to your draft when ready.",
  },
  comment: { id: "browser.capture.comment", message: "Describe what you want to change or check…" },
  add: { id: "browser.capture.add", message: "Add to draft" },
  mark: { id: "browser.capture.mark", message: "Marked location" },
  reset: { id: "browser.capture.reset", message: "Remove mark" },
  loading: { id: "browser.capture.loading", message: "Capturing…" },
}
export type BrowserCapture = Extract<BrowserPageActionResult, { type: "capture" }>
export function BrowserResultDialog(props: {
  initial: BrowserCapture
  recapture(fullPage: boolean): Promise<BrowserCapture>
  attach(file: File, comment: string): Promise<void>
}) {
  const { _ } = useLingui(),
    dialog = useDialog(),
    platform = usePlatform()
  const [capture, setCapture] = createSignal(props.initial)
  const [point, setPoint] = createSignal<{ x: number; y: number }>()
  const [comment, setComment] = createSignal("")
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [notice, setNotice] = createSignal("")
  const filename = () => `screenshot-${new Date(capture().capturedAt).toISOString().replace(/[:.]/g, "-")}.png`
  async function run(action: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  const recapture = (full: boolean) =>
    void run(async () => {
      const value = await props.recapture(full)
      setCapture(value)
      setPoint(undefined)
    })
  return (
    <Dialog title={_(M.title)} size="wide">
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <div class="flex flex-wrap gap-2">
          <Button size="small" disabled={busy()} onClick={() => recapture(false)}>
            {_(M.viewport)}
          </Button>
          <Button size="small" disabled={busy()} onClick={() => recapture(true)}>
            {_(M.full)}
          </Button>
          <Show when={busy()}>
            <span role="status" class="text-12 text-text-weak">
              {_(M.loading)}
            </span>
          </Show>
        </div>
        <p class="truncate text-12 text-text-weak" title={capture().url}>
          {capture().title || capture().url}
        </p>
        <div class="max-h-[45vh] overflow-auto rounded-md border border-border-weak-base">
          <button
            type="button"
            class="relative block w-full"
            aria-label={_(M.mark)}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const x = event.detail === 0 ? 0.5 : (event.clientX - rect.left) / rect.width
              const y = event.detail === 0 ? 0.5 : (event.clientY - rect.top) / rect.height
              setPoint({
                x: Math.round(Math.max(0, Math.min(1, x)) * capture().width),
                y: Math.round(Math.max(0, Math.min(1, y)) * capture().height),
              })
            }}
          >
            <img src={capture().dataUrl} alt={capture().title} class="block h-auto w-full" />
            <Show when={point()}>
              {(p) => (
                <span
                  class="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-border-interactive-base bg-surface-interactive-base"
                  style={{ left: `${(p().x / capture().width) * 100}%`, top: `${(p().y / capture().height) * 100}%` }}
                />
              )}
            </Show>
          </button>
        </div>
        <div class="flex items-center justify-between gap-2">
          <p class="text-12 text-text-weak">{_(M.hint)}</p>
          <Show when={point()}>
            <Button size="small" variant="ghost" onClick={() => setPoint(undefined)}>
              {_(M.reset)}
            </Button>
          </Show>
        </div>
        <textarea
          class="min-h-20 rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-13"
          aria-label={_(M.comment)}
          placeholder={_(M.comment)}
          value={comment()}
          maxLength={20_000}
          onInput={(event) => setComment(event.currentTarget.value)}
        />
        <Show when={error()}>
          <p role="alert" class="text-12 text-text-on-critical-base">
            {error()}
          </p>
        </Show>
        <Show when={notice()}>
          <p role="status" class="text-12 text-text-weak">
            {notice()}
          </p>
        </Show>
        <div class="flex flex-wrap justify-end gap-2">
          <Button
            size="small"
            disabled={busy()}
            onClick={() =>
              void run(async () => {
                await platform.browserNative!.fileAction!({
                  operation: "copyImage",
                  filename: filename(),
                  mime: "image/png",
                  data: capture().dataUrl.split(",")[1]!,
                })
                setNotice(_(M.copied))
              })
            }
          >
            {_(M.copy)}
          </Button>
          <Button
            size="small"
            disabled={busy()}
            onClick={() =>
              void run(async () => {
                await platform.browserNative!.fileAction!({
                  operation: "save",
                  filename: filename(),
                  mime: "image/png",
                  data: capture().dataUrl.split(",")[1]!,
                })
              })
            }
          >
            {_(M.save)}
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={busy()}
            onClick={() =>
              void run(async () => {
                const image = capture(),
                  p = point()
                const blob = await (await fetch(image.dataUrl)).blob()
                const text = `Browser capture: ${image.url}\nCaptured: ${new Date(image.capturedAt).toISOString()}${p ? `\nMarked point in captured image: (${p.x}, ${p.y}) of ${image.width} × ${image.height}` : ""}${comment().trim() ? `\nFeedback: ${comment().trim()}` : ""}`
                await props.attach(new File([blob], filename(), { type: "image/png" }), text)
                dialog.close()
              })
            }
          >
            {_(M.add)}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
