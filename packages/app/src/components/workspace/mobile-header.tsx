import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export interface WorkspaceMobileHeaderProps {
  onClose: () => void
}

export function WorkspaceMobileHeader(props: WorkspaceMobileHeaderProps) {
  return (
    <div class="md:hidden flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60">
      <span class="text-14-medium text-text-strong">Workspace</span>
      <button
        type="button"
        class="flex items-center justify-center size-8 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
        aria-label="Close workspace"
        onClick={props.onClose}
      >
        <Icon name={getSemanticIcon("action.close")} size="normal" />
      </button>
    </div>
  )
}
