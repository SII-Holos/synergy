import type { ResolvedProfile } from "@/control-profile/types"

export function buildPermissionContext(profile: ResolvedProfile, workspaceRoot: string): string {
  const denied = profile.ruleset.filter((rule) => rule.action === "deny")
  const deniedText = denied.length
    ? denied.map((rule) => `- ${rule.permission}`).join("\n")
    : "- No capability class is permanently denied by this profile."

  return [
    `<permission_profile id="${profile.summary?.profileId ?? profile.label}" mode="${profile.approval.mode}">`,
    ``,
    `Current permission mode: ${profile.label}`,
    profile.description,
    ``,
    `Approval behavior:`,
    `- Low-risk requests: ${profile.approval.lowRisk}`,
    `- Medium-risk requests: ${profile.approval.mediumRisk}`,
    `- High-risk requests: ${profile.approval.highRisk}`,
    `- Ordinary read operations, including non-protected external reads, are low risk. Revertible local edits, non-destructive shell commands, and network calls are medium risk. Protected paths, external writes, secrets, destructive shell commands, identity-affecting actions, and outbound communication are high risk.`,
    `- Allowed shell actions run directly. Sandbox failures are not used as a substitute for approval decisions.`,
    `- Profiles ask the user through the permission dock only for actions their rules mark as ask. Autonomous mode denies high-risk asks instead of prompting.`,
    ``,
    `Workspace boundary: ${workspaceRoot}`,
    `Sandbox mode: ${profile.sandbox.mode}`,
    `Network mode: ${profile.network.mode}`,
    ``,
    `Denied capabilities:`,
    deniedText,
    ``,
    `If a tool returns a policy or sandbox denial, treat it as a stable system boundary. Do not retry the same operation with different shell syntax, a different CWD, or equivalent paths. Use a workspace-safe alternative, continue with other useful work, or stop and wait for the user if the denied action is essential.`,
    `</permission_profile>`,
  ].join("\n")
}
