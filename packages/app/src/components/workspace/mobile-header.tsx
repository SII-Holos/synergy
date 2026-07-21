import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { workspace as W } from "@/locales/messages"

export interface WorkspaceMobileHeaderProps {
  onClose: () => void
}

export function WorkspaceMobileHeader(props: WorkspaceMobileHeaderProps) {
  const lingui = useLingui()

  return (
    <div class="md:hidden flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60">
      <span class="text-14-medium text-text-strong">
        {lingui._({ id: W.mobileHeader.id, message: W.mobileHeader.message })}
      </span>
      <button
        type="button"
        class="flex items-center justify-center size-8 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
        aria-label={lingui._({ id: W.closeWorkspace.id, message: W.closeWorkspace.message })}
        onClick={props.onClose}
      >
        <Icon name={getSemanticIcon("action.close")} size="normal" />
      </button>
    </div>
  )
}
