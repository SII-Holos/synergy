import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Show } from "solid-js"

interface VerifiedBadgeProps {
  verified: boolean
  official?: boolean
}

export function VerifiedBadge(props: VerifiedBadgeProps) {
  return (
    <Show when={props.verified}>
      <span
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11-medium bg-surface-success-weak text-text-on-success-base"
        role="status"
        aria-label={props.official ? "Official plugin — verified" : "Verified plugin"}
      >
        <Icon name={props.official ? "badge-check" : "check-circle"} size="small" class="text-icon-success-base" />
        {props.official ? "Official" : "Verified"}
      </span>
    </Show>
  )
}
