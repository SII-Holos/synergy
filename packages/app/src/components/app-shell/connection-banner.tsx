import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"

const PROLONGED_THRESHOLD_MS = 30_000
const TICK_INTERVAL_MS = 5000

export function ConnectionBanner() {
  const globalSDK = useGlobalSDK()

  // Drive reactive updates while disconnected so the banner can transition
  // from "Reconnecting…" to the prolonged state after the threshold.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (globalSDK.connected()) return
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)
    onCleanup(() => clearInterval(id))
  })

  const visible = createMemo(() => !globalSDK.connected() && globalSDK.disconnectedAt() !== undefined)

  const prolonged = createMemo(() => {
    const at = globalSDK.disconnectedAt()
    if (!at) return false
    return now() - at >= PROLONGED_THRESHOLD_MS
  })

  return (
    <Show when={visible()}>
      <div class="pointer-events-none fixed left-1/2 top-2 z-[70] -translate-x-1/2">
        <div
          role="status"
          aria-live="polite"
          classList={{
            "flex items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-12-medium shadow-sm backdrop-blur transition-colors": true,
            "border-border-warning-base/40 bg-surface-warning-soft/95 text-text-warning": !prolonged(),
            "border-border-critical-base/40 bg-surface-critical-soft/95 text-text-critical": prolonged(),
          }}
        >
          <div
            classList={{
              "size-1.5 rounded-full animate-[statusPulse_1.5s_ease-in-out_infinite]": true,
              "bg-icon-warning-base": !prolonged(),
              "bg-icon-critical-base": prolonged(),
            }}
          />
          <span>{prolonged() ? "Connection lost — check your network" : "Reconnecting…"}</span>
        </div>
      </div>
    </Show>
  )
}
