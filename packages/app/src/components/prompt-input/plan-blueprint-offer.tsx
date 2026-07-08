import { createSignal } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { PlanBlueprintOffer } from "./plan-blueprint-offer-model"
import "./plan-blueprint-offer.css"

export function PlanBlueprintOfferControl(props: {
  offer: PlanBlueprintOffer
  onEquip: () => Promise<void>
  onDismiss: () => void
  onMute: () => void
}) {
  const [equipping, setEquipping] = createSignal(false)

  const equip = async () => {
    if (equipping()) return
    setEquipping(true)
    try {
      await props.onEquip()
    } finally {
      setEquipping(false)
    }
  }

  return (
    <div class="plan-blueprint-offer statusbar-glass" role="status" aria-label="Blueprint ready to equip">
      <Icon name={getSemanticIcon("blueprint.main")} size="small" class="shrink-0 text-icon-base" />
      <span class="plan-blueprint-offer-title">{props.offer.title}</span>
      <Tooltip
        value="Equip this Blueprint in the current composer. Send when you are ready to start it."
        placement="top"
      >
        <button
          type="button"
          class="plan-blueprint-offer-action"
          disabled={equipping()}
          aria-label="Equip Blueprint"
          onClick={() => void equip()}
        >
          <Icon name={getSemanticIcon("prompt.blueprintEquip")} size="small" />
          <span class="text-12-medium">Equip</span>
        </button>
      </Tooltip>
      <Tooltip value="Do not show Blueprint equip offers again until Plan is turned on again." placement="top">
        <button type="button" class="plan-blueprint-offer-action" aria-label="Do not ask again" onClick={props.onMute}>
          <Icon name={getSemanticIcon("action.hide")} size="small" />
          <span class="text-12-medium">Don't ask</span>
        </button>
      </Tooltip>
      <Tooltip value="Dismiss this offer" placement="top">
        <button
          type="button"
          class="plan-blueprint-offer-icon-button"
          aria-label="Dismiss Blueprint offer"
          onClick={props.onDismiss}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
