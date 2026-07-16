import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"

interface PermissionRiskBadgeProps {
  risk: "low" | "medium" | "high"
}

const RISK_CONFIG = {
  low: {
    labelId: "app.plugin.risk.low",
    labelMessage: "Low",
    ariaId: "app.plugin.risk.ariaLabel.low",
    ariaMessage: "Risk level: Low",
    icon: "state.success" as const,
    containerClass: "bg-surface-success-weak text-text-on-success-base",
    iconClass: "text-icon-success-base",
  },
  medium: {
    labelId: "app.plugin.risk.medium",
    labelMessage: "Medium",
    ariaId: "app.plugin.risk.ariaLabel.medium",
    ariaMessage: "Risk level: Medium",
    icon: "state.warning" as const,
    containerClass: "bg-surface-warning-weak text-text-on-warning-base",
    iconClass: "text-icon-warning-base",
  },
  high: {
    labelId: "app.plugin.risk.high",
    labelMessage: "High",
    ariaId: "app.plugin.risk.ariaLabel.high",
    ariaMessage: "Risk level: High",
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
      aria-label={_({ id: config.ariaId, message: config.ariaMessage })}
    >
      <Icon name={getSemanticIcon(config.icon)} size="small" class={config.iconClass} />
      {_({ id: config.labelId, message: config.labelMessage })}
    </span>
  )
}
