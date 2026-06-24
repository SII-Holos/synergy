import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { TrustTier } from "./schema"

interface TrustTierExplanationProps {
  tier: TrustTier
}

interface TierInfo {
  label: string
  icon: string
  description: string
  model: string
  implications: string[]
  containerClass: string
  iconClass: string
}

const TIER_CONFIG: Record<TrustTier, TierInfo> = {
  declarative: {
    label: "Declarative",
    icon: "scroll-text",
    description: "No JavaScript execution — this plugin is a pure manifest that contributes static declarations.",
    model: "Manifest-only. Contributes UI, themes, icons, routes, and settings via declarative configuration.",
    implications: [
      "Cannot execute any code in the app",
      "Cannot access the filesystem or network",
      "Cannot invoke tools or spawn processes",
      "Safest tier — no runtime risk",
    ],
    containerClass: "border-border-success bg-surface-success-soft",
    iconClass: "text-icon-success-base",
  },
  "trusted-import": {
    label: "Trusted Import",
    icon: "shield-check",
    description: "Runs in the application origin with declared permissions — full access within its permission scope.",
    model: "JavaScript bundle loaded in the app's origin. Has access to plugin APIs and tool bridges as declared.",
    implications: [
      "Can access declared permissions (tools, data, network, UI)",
      "Runs in the same origin as the application",
      "May invoke shell commands or access files if granted",
      "Trust is based on source verification and user approval",
    ],
    containerClass: "border-border-warning bg-surface-warning-soft",
    iconClass: "text-icon-warning-base",
  },
  sandbox: {
    label: "Sandbox",
    icon: "boxes",
    description: "Runs in an isolated iframe — cannot access the application origin directly.",
    model:
      "JavaScript bundle executed in a sandboxed iframe with a separate origin. Communication via postMessage bridge.",
    implications: [
      "Cannot access the application DOM or memory",
      "Cannot invoke tools directly — uses restricted bridge",
      "Network access is controlled by the sandbox origin policy",
      "Strongest isolation — safe for third-party plugins",
    ],
    containerClass: "border-border-base bg-surface-base",
    iconClass: "text-icon-weak",
  },
}

export function TrustTierExplanation(props: TrustTierExplanationProps) {
  const info = TIER_CONFIG[props.tier]

  return (
    <div
      class={`trust-tier-explanation rounded-lg border p-4 ${info.containerClass}`}
      role="note"
      aria-label={`Trust tier: ${info.label}`}
    >
      {/* Header */}
      <div class="flex items-center gap-2 mb-2">
        <div class="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-base">
          <Icon name={info.icon as Parameters<typeof Icon>[0]["name"]} size="small" class={info.iconClass} />
        </div>
        <p class="text-14-medium text-text-strong">{info.label} execution</p>
      </div>

      {/* Description */}
      <p class="text-13-regular text-text-base">{info.description}</p>

      {/* Execution model */}
      <div class="mt-3 rounded-md bg-surface-base px-3 py-2">
        <p class="text-12-medium text-text-weak uppercase tracking-wider mb-1">Execution model</p>
        <p class="text-13-regular text-text-base">{info.model}</p>
      </div>

      {/* Security implications */}
      <div class="mt-3">
        <p class="text-12-medium text-text-weak uppercase tracking-wider mb-1.5">Security implications</p>
        <ul class="flex flex-col gap-1">
          {info.implications.map((imp) => (
            <li class="flex items-start gap-2 text-13-regular text-text-base">
              <span class="mt-1.5 block size-1 shrink-0 rounded-full bg-icon-weak" />
              {imp}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
