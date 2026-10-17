import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { AP } from "@/app-i18n"
import { SettingsDialog } from "@/components/settings"
import type { ModelReadiness } from "./model-readiness"

export type UnavailableModel = Exclude<ModelReadiness, { state: "ready" }>

export function ModelUnavailableNotice(props: { state: UnavailableModel; onConfigure?: () => void }) {
  const dialog = useDialog()
  const { _ } = useLingui()
  const body = () => {
    if (props.state.state === "not-configured") return _(AP.appModelUnavailableNotConfigured)
    if (props.state.state === "needs-attention") return _(AP.appModelUnavailableNeedsAttention)
    return _(AP.appModelUnavailableRestricted)
  }

  return (
    <div data-component="model-unavailable-notice" class="flex flex-col items-start gap-3 p-4">
      <p role="status" aria-live="polite" class="text-13-regular text-text-weak leading-relaxed">
        {body()}
      </p>
      <Button
        variant="secondary"
        class="model-selector-popover-footer-action"
        onClick={() => {
          const state = props.state
          const focus =
            state.state === "not-configured" || state.providerIDs.length !== 1 ? undefined : state.providerIDs[0]
          props.onConfigure?.()
          dialog.show(() => <SettingsDialog initialTab="providers" providerFocusID={focus} />)
        }}
      >
        {props.state.state === "not-configured" ? _(AP.appModelUnavailableConnect) : _(AP.appModelUnavailableReview)}
      </Button>
    </div>
  )
}
