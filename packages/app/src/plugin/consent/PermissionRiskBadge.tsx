import { pluginRisk } from "@/locales/messages"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"

interface PermissionRiskBadgeProps {
  risk: "low" | "medium" | "high"
}

const RISK_CONFIG = {
  low: {
    icon: "state.success" as const,
    containerClass: "bg-surface-success-weak text-text-on-success-base",
    iconClass: "text-icon-success-base",
  },
  medium: {
    icon: "state.warning" as const,
    containerClass: "bg-surface-warning-weak text-text-on-warning-base",
    iconClass: "text-icon-warning-base",
  },
  high: {
    icon: "state.error" as const,
    containerClass: "bg-surface-critical-weak text-text-on-critical-base",
    iconClass: "text-icon-critical-base",
  },
} as const

export function PermissionRiskBadge(props: PermissionRiskBadgeProps) {
  const { _ } = useLingui()
  const config = RISK_CONFIG[props.risk]

  return (
    <span
      class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11-medium ${config.containerClass}`}
      role="status"
      aria-label={_(
        props.risk === "low"
          ? pluginRisk.ariaLow
          : props.risk === "medium"
            ? pluginRisk.ariaMedium
            : pluginRisk.ariaHigh,
      )}
    >
      <Icon name={getSemanticIcon(config.icon)} size="small" class={config.iconClass} />
      {_(props.risk === "low" ? pluginRisk.low : props.risk === "medium" ? pluginRisk.medium : pluginRisk.high)}
    </span>
  )
}
