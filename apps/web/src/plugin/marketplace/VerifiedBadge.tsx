import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"

interface VerifiedBadgeProps {
  verified: boolean
  official?: boolean
}

export function VerifiedBadge(props: VerifiedBadgeProps) {
  const { _ } = useLingui()
  return (
    <Show when={props.verified}>
      <span
        class="inline-flex items-center gap-1 app-panel-caption text-text-weak"
        role="status"
        aria-label={
          props.official
            ? _({ id: "app.plugin.verified.official.ariaLabel", message: "Official plugin — verified" })
            : _({ id: "app.plugin.verified.ariaLabel", message: "Verified plugin" })
        }
      >
        <Icon name={getSemanticIcon("plugin.sourceVerified")} size="small" class="text-icon-base" />
        {props.official
          ? _({ id: "app.plugin.verified.official", message: "Official" })
          : _({ id: "app.plugin.verified.label", message: "Verified" })}
      </span>
    </Show>
  )
}
