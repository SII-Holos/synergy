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
      "Auto-allow reads, safe local edits, and network lookups. Ask before shell, external writes, identity, platform, or extension actions.",
  },
  autonomous: {
    id: "settings.controlProfile.autonomous.description",
    message: "Keep working unattended. Medium-risk work is allowed; high-risk asks are denied instead of prompting.",
  },
  full_access: {
    id: "settings.controlProfile.fullAccess.description",
    message: "Allow all local tool requests without approval prompts.",
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
