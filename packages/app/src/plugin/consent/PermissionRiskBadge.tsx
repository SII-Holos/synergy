import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

interface PermissionRiskBadgeProps {
  risk: "low" | "medium" | "high"
}

const RISK_CONFIG = {
  low: {
    label: "Low",
    icon: "state.success" as const,
    containerClass: "bg-surface-success-soft text-text-success",
    iconClass: "text-icon-success-base",
  },
  medium: {
    label: "Medium",
    icon: "state.warning" as const,
    containerClass: "bg-surface-warning-soft text-text-warning",
    iconClass: "text-icon-warning-base",
  },
  high: {
    label: "High",
    icon: "state.error" as const,
    containerClass: "bg-surface-critical-soft text-text-critical",
    iconClass: "text-icon-critical-base",
  },
} as const

export function PermissionRiskBadge(props: PermissionRiskBadgeProps) {
  const config = RISK_CONFIG[props.risk]

  return (
    <span
      class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11-medium ${config.containerClass}`}
      role="status"
      aria-label={`Risk level: ${config.label}`}
    >
      <Icon name={getSemanticIcon(config.icon)} size="small" class={config.iconClass} />
      {config.label}
    </span>
  )
}
