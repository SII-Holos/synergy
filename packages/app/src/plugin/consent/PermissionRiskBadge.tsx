import { Icon } from "@ericsanchezok/synergy-ui/icon"

interface PermissionRiskBadgeProps {
  risk: "low" | "medium" | "high"
}

const RISK_CONFIG = {
  low: {
    label: "Low",
    icon: "shield-check" as const,
    containerClass: "bg-surface-success-soft text-text-success",
    iconClass: "text-icon-success-base",
  },
  medium: {
    label: "Medium",
    icon: "shield-check" as const,
    containerClass: "bg-surface-warning-soft text-text-warning",
    iconClass: "text-icon-warning-base",
  },
  high: {
    label: "High",
    icon: "alert-triangle" as const,
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
      <Icon name={config.icon} size="small" class={config.iconClass} />
      {config.label}
    </span>
  )
}
