import type { ControlProfileId } from "@/context/input"
import type { PermissionModeVisual } from "./types"

export const PERMISSION_MODES: PermissionModeVisual[] = [
  {
    id: "guarded",
    label: "Guarded",
    shortLabel: "Guarded",
    description:
      "Auto-approve reads, safe edits, and network lookups. Ask before shell, external writes, identity, platform, or extension actions.",
    icon: "shield-check",
    iconClass: "text-icon-success-base",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    shortLabel: "Auto",
    description:
      "Keep working unattended. Medium-risk work is allowed; high-risk asks are denied instead of prompting.",
    icon: "orbit",
    iconClass: "text-icon-interactive-base",
  },
  {
    id: "full_access",
    label: "Full Access",
    shortLabel: "Full",
    description: "Allow all tool requests without approval prompts or workspace sandboxing.",
    icon: "shield-alert",
    iconClass: "text-icon-warning-base",
  },
]

export function permissionModeVisual(id: ControlProfileId | string | undefined): PermissionModeVisual {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[0]
}
