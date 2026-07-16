import type { ControlProfileId } from "@/context/input"
import type { PermissionModeVisual } from "./types"

export const P = {
  modeGuarded: { id: "session.permission.mode.guarded", message: "Guarded" },
  modeGuardedShort: { id: "session.permission.mode.guarded.short", message: "Guarded" },
  modeGuardedDesc: {
    id: "session.permission.mode.guarded.description",
    message:
      "Auto-approve reads, safe edits, and network lookups. Ask before shell, external writes, identity, platform, or extension actions.",
  },
  modeAutonomous: { id: "session.permission.mode.autonomous", message: "Autonomous" },
  modeAutonomousShort: { id: "session.permission.mode.autonomous.short", message: "Auto" },
  modeAutonomousDesc: {
    id: "session.permission.mode.autonomous.description",
    message: "Keep working unattended. Medium-risk work is allowed; high-risk asks are denied instead of prompting.",
  },
  modeFullAccess: { id: "session.permission.mode.fullAccess", message: "Full Access" },
  modeFullAccessShort: { id: "session.permission.mode.fullAccess.short", message: "Full" },
  modeFullAccessDesc: {
    id: "session.permission.mode.fullAccess.description",
    message: "Allow all tool requests without approval prompts or workspace sandboxing.",
  },
  sessionRunning: { id: "session.permission.sessionRunning", message: "Session is running" },
  stopBeforeChange: {
    id: "session.permission.stopBeforeChange",
    message: "Stop the session before changing its permission mode.",
  },
  permissionModeTitle: { id: "session.permission.title", message: "Permission mode" },
  permissionModeAriaLabel: { id: "session.permission.ariaLabel", message: "{mode} permission mode" },
}

export const PERMISSION_MODES: PermissionModeVisual[] = [
  {
    id: "guarded",
    label: "Guarded",
    shortLabel: "Guarded",
    description:
      "Auto-approve reads, safe edits, and network lookups. Ask before shell, external writes, identity, platform, or extension actions.",
    icon: "permission.guarded",
    iconClass: "text-icon-success-base",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    shortLabel: "Auto",
    description:
      "Keep working unattended. Medium-risk work is allowed; high-risk asks are denied instead of prompting.",
    icon: "permission.autonomous",
    iconClass: "text-icon-interactive-base",
  },
  {
    id: "full_access",
    label: "Full Access",
    shortLabel: "Full",
    description: "Allow all tool requests without approval prompts or workspace sandboxing.",
    icon: "permission.fullAccess",
    iconClass: "text-icon-warning-base",
  },
]

export function permissionModeVisual(id: ControlProfileId | string | undefined): PermissionModeVisual {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[0]
}
