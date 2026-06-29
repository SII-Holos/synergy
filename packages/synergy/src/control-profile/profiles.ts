import { Config } from "../config/config"
import { Log } from "../util/log"
import {
  capabilityNonBypassable,
  capabilityRisk,
  PROFILE_CAPABILITIES,
} from "@ericsanchezok/synergy-plugin/permissions"
import { PROFILE_IDS } from "./ids"
import type { ProfileSandbox } from "./types"
import type {
  ControlProfile,
  ProfileApproval,
  ProfileId,
  ProfileIdInput,
  ResolutionContext,
  ResolvedProfile,
} from "./types"

function rule(permission: string, action: "allow" | "deny" | "ask", nonBypassable = false) {
  return { permission, pattern: "*", action, ...(nonBypassable ? { nonBypassable: true } : {}) }
}

function rulesFor(actions: {
  low: "allow" | "deny" | "ask"
  medium: "allow" | "deny" | "ask"
  high: "allow" | "deny" | "ask"
}) {
  return PROFILE_CAPABILITIES.map((permission) => {
    if (permission === "shell_hardline") return rule(permission, "deny", true)
    if (permission === "protected_op") return rule(permission, "ask", true)
    const risk = capabilityRisk(permission)
    if (risk === "high") return rule(permission, actions.high, capabilityNonBypassable(permission))
    if (risk === "low") return rule(permission, actions.low, capabilityNonBypassable(permission))
    return rule(permission, actions.medium)
  })
}

function guardedRules() {
  return PROFILE_CAPABILITIES.map((permission) => {
    if (permission === "shell_hardline") return rule(permission, "deny", true)
    if (permission === "protected_op") return rule(permission, "ask", true)
    if (capabilityRisk(permission) === "high") return rule(permission, "ask", capabilityNonBypassable(permission))
    if (permission === "file_read" || permission === "shell_read") return rule(permission, "allow")
    if (
      permission === "file_write" ||
      permission === "network_request" ||
      permission === "network_read" ||
      permission === "session_state" ||
      permission === "browser_interact" ||
      permission === "browser_inspect"
    )
      return rule(permission, "allow")
    return rule(permission, "ask")
  })
}

function autonomousRules() {
  return PROFILE_CAPABILITIES.map((permission) => {
    if (permission === "shell_hardline") return rule(permission, "deny", true)
    if (permission === "file_read" || permission === "shell_read") return rule(permission, "allow")
    if (permission === "file_write") return rule(permission, "allow")
    if (permission === "file_external_read") return rule(permission, "allow")
    if (permission === "file_external_write") return rule(permission, "deny", true)
    if (permission === "network_request") return rule(permission, "allow")
    if (permission === "browser_interact") return rule(permission, "allow")
    if (permission === "browser_inspect") return rule(permission, "allow")
    if (permission === "protected_op") return rule(permission, "ask", true)
    if (permission === "mcp_invoke") return rule(permission, "allow")
    if (permission === "mcp_spawn") return rule(permission, "allow")
    if (permission === "secrets") return rule(permission, "deny", true)
    if (permission === "prompt_transform") return rule(permission, "deny", true)
    if (permission === "compaction_transform") return rule(permission, "deny", true)
    if (permission === "permission_hook") return rule(permission, "deny", true)
    if (permission === "tool_execution_hook") return rule(permission, "allow")
    if (permission === "event_hook") return rule(permission, "allow")
    if (permission === "identity_act") return rule(permission, "allow")
    if (permission === "communication_email") return rule(permission, "allow")
    if (permission === "channel_outbound") return rule(permission, "allow")
    if (permission === "platform_control") return rule(permission, "allow")
    if (permission === "shell_destructive") return rule(permission, "deny")
    if (permission === "browser_eval_trusted") return rule(permission, "deny", true)
    return rule(permission, "allow")
  })
}

function workspaceFs(workspace: string) {
  return {
    readRoots: [workspace],
    writeRoots: [workspace],
    protectedPaths: [],
  }
}

function autonomousFs(workspace: string) {
  return {
    readRoots: ["/"],
    writeRoots: [workspace],
    protectedPaths: [],
  }
}

function autonomousPolicy(workspace: string) {
  return {
    filesystem: autonomousFs(workspace),
    network: { mode: "restricted" as const },
    sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
  }
}

function workspacePolicy(workspace: string) {
  return {
    filesystem: workspaceFs(workspace),
    network: { mode: "restricted" as const },
    sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
  }
}

function fullAccessPolicy() {
  return {
    filesystem: {
      readRoots: ["/"],
      writeRoots: ["/"],
      protectedPaths: [],
    },
    network: { mode: "enabled" as const },
    sandbox: { mode: "none" as const, fallback: "allow" as const },
  }
}

function approval(mode: ProfileApproval["mode"]): ProfileApproval {
  switch (mode) {
    case "guarded":
      return { mode, lowRisk: "allow", mediumRisk: "ask", highRisk: "ask" }
    case "autonomous":
      return { mode, lowRisk: "allow", mediumRisk: "allow", highRisk: "deny" }
    case "full_access":
      return { mode, lowRisk: "allow", mediumRisk: "allow", highRisk: "allow" }
  }
}

function summary(
  id: ProfileId,
  profile: Omit<ControlProfile, "ruleset" | "filesystem" | "network">,
  deniedCapabilities: string[],
  workspace: string,
) {
  return {
    profileId: id,
    sandbox: profile.sandbox,
    label: profile.label,
    brief: profile.description,
    approval: profile.approval,
    deniedCapabilities,
    workspaceRoot: workspace,
  }
}

export function normalizeProfileId(id: string | undefined): ProfileId {
  if (!id) return "guarded"
  if ((PROFILE_IDS as readonly string[]).includes(id)) return id as ProfileId
  return "guarded"
}

const LOG = Log.create({ service: "control-profile" })

export async function resolveEffectiveSandbox(profileId: ProfileId): Promise<ProfileSandbox> {
  const defaults: Record<ProfileId, ProfileSandbox> = {
    guarded: { mode: "workspace_write", fallback: "warn" },
    autonomous: { mode: "workspace_write", fallback: "warn" },
    full_access: { mode: "none", fallback: "allow" },
  }
  const profile = { ...defaults[profileId] }

  let sandboxCfg: any = null
  try {
    const cfg = await Config.current()
    sandboxCfg = cfg.sandbox
  } catch {
    LOG.debug("no config context available for sandbox resolution, using profile defaults", { profile: profileId })
  }

  if (!sandboxCfg) {
    LOG.debug("no sandbox config found, using profile defaults", { profile: profileId, defaults: profile })
    return profile
  }

  LOG.debug("sandbox config loaded", {
    profile: profileId,
    enabled: sandboxCfg.enabled,
    fallbackPolicy: sandboxCfg.fallbackPolicy,
    backend: sandboxCfg.backend,
    hasWindowsConfig: Boolean(sandboxCfg.windows),
    hasNetworkConfig: Boolean(sandboxCfg.network),
    hasMacosConfig: Boolean(sandboxCfg.macos),
    hasLinuxConfig: Boolean(sandboxCfg.linux),
  })

  if (sandboxCfg.enabled === false && profile.mode !== "none") {
    LOG.warn("sandbox.enabled=false in config overrides profile sandbox. Sandbox is disabled.", {
      profile: profileId,
      profileMode: profile.mode,
    })
    return { mode: "none", fallback: "allow" }
  }

  if (sandboxCfg.fallbackPolicy) {
    profile.fallback = sandboxCfg.fallbackPolicy
    LOG.info("sandbox fallback policy overridden by config", {
      profile: profileId,
      fallbackPolicy: sandboxCfg.fallbackPolicy,
    })
  }

  if (sandboxCfg.backend && sandboxCfg.backend !== "auto") {
    profile.backend = sandboxCfg.backend
    LOG.info("sandbox backend overridden by config", {
      profile: profileId,
      backend: sandboxCfg.backend,
    })
  }

  if (sandboxCfg.windows?.level) {
    profile.windowsLevel = sandboxCfg.windows.level
    LOG.info("sandbox windows level overridden by config", {
      profile: profileId,
      windowsLevel: sandboxCfg.windows.level,
    })
  }

  LOG.debug("resolved effective sandbox", { profile: profileId, effective: profile })
  return profile
}

export async function buildProfile(idInput: ProfileIdInput | string, ctx: ResolutionContext): Promise<ResolvedProfile> {
  const id = normalizeProfileId(idInput)
  const { workspace, interactionMode } = ctx
  const effectiveSandbox = await resolveEffectiveSandbox(id)

  switch (id) {
    case "guarded": {
      const policy = workspacePolicy(workspace)
      const profile = {
        valid: true,
        label: "Guarded",
        description:
          "Auto-allow safe local edits and network lookups. Ask before shell, external, identity, platform, or extension actions.",
        ruleset: guardedRules(),
        ...policy,
        sandbox: effectiveSandbox,
        approval: approval("guarded"),
      }
      return { ...profile, summary: summary(id, profile, [], workspace) }
    }

    case "autonomous": {
      const policy = autonomousPolicy(workspace)
      const profile = {
        valid: true,
        label: "Autonomous",
        description:
          "Unattended development with full tool access. Network, external reads, and extensions are available. Only destructive shell commands are blocked with recovery guidance.",
        ruleset: autonomousRules(),
        ...policy,
        sandbox: effectiveSandbox,
        approval: approval("autonomous"),
      }
      return {
        ...profile,
        summary: summary(id, profile, ["shell_hardline", "shell_destructive"], workspace),
      }
    }

    case "full_access": {
      if (interactionMode === "unattended") {
        return {
          valid: false,
          reason: "full_access profile is forbidden in unattended mode",
          label: "Full Access",
          description: "Unrestricted local access. Disabled for unattended sessions.",
          ruleset: [],
          filesystem: { readRoots: [], writeRoots: [], protectedPaths: [] },
          network: { mode: "disabled" },
          sandbox: { mode: "read_only", fallback: "deny" },
          approval: approval("full_access"),
        }
      }
      const policy = fullAccessPolicy()
      const profile = {
        valid: true,
        label: "Full Access",
        description: "Allow all tool requests without workspace, shell, or network approval prompts.",
        ruleset: rulesFor({ low: "allow", medium: "allow", high: "allow" }),
        ...policy,
        sandbox: effectiveSandbox,
        approval: approval("full_access"),
      }
      return { ...profile, summary: summary(id, profile, [], workspace) }
    }
  }
}

export async function getProfileLabel(id: string): Promise<string> {
  const profile = await buildProfile(normalizeProfileId(id), { workspace: "/", workspaceType: "main" })
  return profile.label
}
