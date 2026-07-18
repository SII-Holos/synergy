import type { ToolTriggerProps } from "./trigger"

export function withSubtitleClickHandler(trigger: ToolTriggerProps, onSubtitleClick?: () => void): ToolTriggerProps {
  if (!onSubtitleClick || trigger.onSubtitleClick) return trigger
  return { ...trigger, onSubtitleClick }
}
