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
    `- Safe read-only shell commands are low risk. Other shell commands, writes, network calls, and external paths require approval unless Full Access is active.`,
    `- Only Autonomous mode automatically denies high-risk actions. Manual and Guarded modes ask the user through the permission dock.`,
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
