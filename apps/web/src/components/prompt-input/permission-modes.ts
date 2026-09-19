import type { ControlProfileId } from "@/context/input"
import type { PermissionModeVisual } from "./types"

export const P = {
  modeGuarded: { id: "session.permission.mode.guarded", message: "Guarded" },
  modeGuardedShort: { id: "session.permission.mode.guarded.short", message: "Guarded" },
  modeGuardedDesc: {
    id: "session.permission.mode.guarded.description",
    message:
      "Asks you before risky work: shell, external writes, identity, platform, or extension actions. Reads, safe edits, and network lookups proceed automatically.",
  },
  modeAutonomous: { id: "session.permission.mode.autonomous", message: "Autonomous" },
  modeAutonomousShort: { id: "session.permission.mode.autonomous.short", message: "Auto" },
  modeAutonomousDesc: {
    id: "session.permission.mode.autonomous.description",
    message:
      "Never asks. Medium-risk work is allowed and high-risk work is denied instead of prompting, so a run cannot stall waiting for you.",
  },
  modeFullAccess: { id: "session.permission.mode.fullAccess", message: "Full Access" },
  modeFullAccessShort: { id: "session.permission.mode.fullAccess.short", message: "Full" },
  modeFullAccessDesc: {
    id: "session.permission.mode.fullAccess.description",
    message: "Never asks and allows everything, with no permission checks and no workspace sandboxing.",
  },
}

export const PERMISSION_MODES: PermissionModeVisual[] = [
  {
    id: "guarded",
    label: P.modeGuarded,
    shortLabel: P.modeGuardedShort,
    description: P.modeGuardedDesc,
    icon: "permission.guarded",
    iconClass: "text-icon-success-base",
  },
  {
    id: "autonomous",
    label: P.modeAutonomous,
    shortLabel: P.modeAutonomousShort,
    description: P.modeAutonomousDesc,
    icon: "permission.autonomous",
    iconClass: "text-icon-interactive-base",
  },
  {
    id: "full_access",
    label: P.modeFullAccess,
    shortLabel: P.modeFullAccessShort,
    description: P.modeFullAccessDesc,
    icon: "permission.fullAccess",
    iconClass: "text-icon-warning-base",
  },
]

export function permissionModeVisual(id: ControlProfileId | string | undefined): PermissionModeVisual {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[0]
}
