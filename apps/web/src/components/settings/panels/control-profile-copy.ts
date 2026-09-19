import type { MessageDescriptor } from "@lingui/core"

export type ControlProfileCopy = { id: string; label?: string; description?: string }
export type TranslateControlProfileDescriptor = (descriptor: MessageDescriptor) => string

const PROFILE_LABELS: Record<string, MessageDescriptor> = {
  guarded: { id: "settings.controlProfile.guarded.label", message: "Guarded" },
  autonomous: { id: "settings.controlProfile.autonomous.label", message: "Autonomous" },
  full_access: { id: "settings.controlProfile.fullAccess.label", message: "Full Access" },
}

const PROFILE_DESCRIPTIONS: Record<string, MessageDescriptor> = {
  guarded: {
    id: "settings.controlProfile.guarded.description",
    message:
      "Asks you before risky work: shell, external writes, identity, platform, or extension actions. Reads, safe local edits, and network lookups proceed automatically.",
  },
  autonomous: {
    id: "settings.controlProfile.autonomous.description",
    message:
      "Never asks. Medium-risk work is allowed and high-risk work is denied instead of prompting, so a run cannot stall waiting for you.",
  },
  full_access: {
    id: "settings.controlProfile.fullAccess.description",
    message: "Never asks and allows everything, with no permission checks and no workspace sandboxing.",
  },
}

export const fallbackControlProfiles: ControlProfileCopy[] = [
  { id: "guarded" },
  { id: "autonomous" },
  { id: "full_access" },
]

export function controlProfileLabel(profile: ControlProfileCopy, translate: TranslateControlProfileDescriptor): string {
  const descriptor = PROFILE_LABELS[profile.id]
  return descriptor ? translate(descriptor) : (profile.label ?? profile.id)
}

export function controlProfileDescription(
  profile: ControlProfileCopy,
  translate: TranslateControlProfileDescriptor,
): string {
  const descriptor = PROFILE_DESCRIPTIONS[profile.id]
  return descriptor ? translate(descriptor) : (profile.description ?? "")
}
