import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { AP } from "@/app-i18n"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsDialog } from "@/components/settings"
import { resolveModelReadiness, type ModelReadiness } from "@/components/provider/model-readiness"

/** App-wide strip shown while no model is usable. Reads the global provider snapshot, so it clears as soon as Settings connects a provider. */
type UnavailableReadiness = Exclude<ModelReadiness, { state: "ready" }>

export function ModelUnavailableBanner() {
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const { _ } = useLingui()

  const blocking = createMemo<UnavailableReadiness | undefined>(() => {
    const state = resolveModelReadiness(globalSync.data.provider)
    return state.state === "ready" ? undefined : state
  })

  function body(state: UnavailableReadiness) {
    if (state.state === "not-configured")
      return _(AP.appModelUnavailableNotConfigured.id, { cmd: _(AP.appModelConfigCmd.id) })
    if (state.state === "needs-attention") return _(AP.appModelUnavailableNeedsAttention.id)
    return _(AP.appModelUnavailableRestricted.id)
  }

  function actionLabel(state: UnavailableReadiness) {
    return state.state === "not-configured" ? _(AP.appModelUnavailableConnect.id) : _(AP.appModelUnavailableReview.id)
  }

  function openProviders(state: UnavailableReadiness) {
    const focus = state.state === "not-configured" || state.providerIDs.length !== 1 ? undefined : state.providerIDs[0]
    dialog.show(() => <SettingsDialog initialTab="providers" providerFocusID={focus} />)
  }

  return (
    <Show when={blocking()}>
      {(state) => (
        <div
          role="status"
          aria-live="polite"
          data-component="model-unavailable-banner"
          class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-surface-warning-weak px-3 py-1.5 text-12-medium text-text-on-warning-base"
        >
          <span class="flex items-center gap-2 text-center">
            <span aria-hidden="true">{"\u26A0"}</span>
            <span>{body(state())}</span>
          </span>
          <button
            type="button"
            onClick={() => openProviders(state())}
            class="rounded-md border border-border-warning-base/60 px-2.5 py-1 text-12-medium text-text-on-warning-base transition-colors hover:bg-surface-warning-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
          >
            {actionLabel(state())}
          </button>
        </div>
      )}
    </Show>
  )
}
