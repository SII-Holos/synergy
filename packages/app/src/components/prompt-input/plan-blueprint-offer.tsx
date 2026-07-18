import { createSignal } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import type { PlanBlueprintOffer } from "@/context/plan-blueprint-offer"
import { PI } from "./prompt-input-i18n"
import "./plan-blueprint-offer.css"

export function PlanBlueprintOfferControl(props: {
  offer: PlanBlueprintOffer
  onEquip: () => Promise<void>
  onDismiss: () => void
  onMute: () => void
}) {
  const { i18n } = useLocale()
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
    <div class="plan-blueprint-offer statusbar-glass" role="status" aria-label={i18n._(PI.planOfferAria)}>
      <Icon name={getSemanticIcon("blueprint.main")} size="small" class="shrink-0 text-icon-base" />
      <span class="plan-blueprint-offer-title">{props.offer.title}</span>
      <Tooltip value={i18n._(PI.planOfferEquipTooltip)} placement="top">
        <button
          type="button"
          class="plan-blueprint-offer-action"
          disabled={equipping()}
          aria-label={i18n._(PI.planOfferEquipAria)}
          onClick={() => void equip()}
        >
          <Icon name={getSemanticIcon("prompt.blueprintEquip")} size="small" />
          <span class="text-12-medium">{i18n._(PI.planOfferEquip)}</span>
        </button>
      </Tooltip>
      <Tooltip value={i18n._(PI.planOfferMuteTooltip)} placement="top">
        <button
          type="button"
          class="plan-blueprint-offer-action"
          aria-label={i18n._(PI.planOfferMuteAria)}
          onClick={props.onMute}
        >
          <Icon name={getSemanticIcon("action.hide")} size="small" />
          <span class="text-12-medium">{i18n._(PI.planOfferMute)}</span>
        </button>
      </Tooltip>
      <Tooltip value={i18n._(PI.planOfferDismissTooltip)} placement="top">
        <button
          type="button"
          class="plan-blueprint-offer-icon-button"
          aria-label={i18n._(PI.planOfferDismissAria)}
          onClick={props.onDismiss}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
