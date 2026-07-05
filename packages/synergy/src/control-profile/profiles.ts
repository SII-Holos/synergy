import { Config } from "../config/config"
import { Log } from "../util/log"
import {
  SYNERGY_PROFILE_CAPABILITIES,
  capabilityNonBypassable,
  capabilityRisk,
} from "@ericsanchezok/synergy-util/capability"
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

function capabilityRule(permission: string, action: "allow" | "deny" | "ask") {
  return rule(permission, action, capabilityNonBypassable(permission))
}

function rulesFor(actions: {
  low: "allow" | "deny" | "ask"
  medium: "allow" | "deny" | "ask"
  high: "allow" | "deny" | "ask"
}) {
  return SYNERGY_PROFILE_CAPABILITIES.map((permission) => {
    const risk = capabilityRisk(permission)
    if (risk === "high") return capabilityRule(permission, actions.high)
    if (risk === "low") return capabilityRule(permission, actions.low)
    return capabilityRule(permission, actions.medium)
  })
}

const GUARDED_MEDIUM_ALLOWED = new Set(["file_write", "network_request", "session_state", "browser_interact"])

const AUTONOMOUS_MEDIUM_ALLOWED = new Set(["shell_remote_publish"])

const AUTONOMOUS_DENIED = new Set([
  "shell_hardline",
  "shell_remote_write",
  "shell_destructive",
  "file_external_write",
  "secrets",
  "prompt_transform",
  "compaction_transform",
  "permission_hook",
  "browser_eval_trusted",
])

const AUTONOMOUS_HIGH_ALLOWED = new Set(["identity_act", "communication_email", "channel_outbound", "platform_control"])

function guardedRules() {
  return SYNERGY_PROFILE_CAPABILITIES.map((permission) => {
    if (permission === "shell_hardline") return capabilityRule(permission, "deny")
    if (permission === "protected_op") return capabilityRule(permission, "ask")
    const risk = capabilityRisk(permission)
    if (risk === "low") return capabilityRule(permission, "allow")
    if (risk === "high") return capabilityRule(permission, "ask")
    if (GUARDED_MEDIUM_ALLOWED.has(permission)) return capabilityRule(permission, "allow")
    return capabilityRule(permission, "ask")
  })
}

function autonomousRules() {
  const guarded = new Map(guardedRules().map((item) => [item.permission, item]))
  return SYNERGY_PROFILE_CAPABILITIES.map((permission) => {
    if (AUTONOMOUS_MEDIUM_ALLOWED.has(permission)) return capabilityRule(permission, "allow")
    if (AUTONOMOUS_DENIED.has(permission)) return capabilityRule(permission, "deny")
    if (permission === "protected_op") return capabilityRule(permission, "ask")
    const guardedRule = guarded.get(permission)
    if (guardedRule?.action === "allow") return guardedRule
    const risk = capabilityRisk(permission)
    if (risk === "medium") return capabilityRule(permission, "allow")
    if (risk === "high" && AUTONOMOUS_HIGH_ALLOWED.has(permission)) return capabilityRule(permission, "allow")
    return capabilityRule(permission, "ask")
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

function summary(id: ProfileId, profile: Omit<ControlProfile, "filesystem" | "network">, workspace: string) {
  return {
    profileId: id,
    sandbox: profile.sandbox,
    label: profile.label,
    brief: profile.description,
    approval: profile.approval,
    deniedCapabilities: profile.ruleset.filter((item) => item.action === "deny").map((item) => item.permission),
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
  const { workspace } = ctx
  const effectiveSandbox = await resolveEffectiveSandbox(id)

  switch (id) {
    case "guarded": {
      const policy = workspacePolicy(workspace)
      const profile = {
        valid: true,
        label: "Guarded",
        description:
          "Auto-allow ordinary reads, safe local edits, and network lookups. Ask before shell, external writes, identity, or platform actions.",
        ruleset: guardedRules(),
        ...policy,
        sandbox: effectiveSandbox,
        approval: approval("guarded"),
      }
      return { ...profile, summary: summary(id, profile, workspace) }
    }

    case "autonomous": {
      const policy = autonomousPolicy(workspace)
      const profile = {
        valid: true,
        label: "Autonomous",
        description:
          "Unattended development: ordinary safe work is auto-approved, while high-risk operations are auto-denied instead of prompting.",
        ruleset: autonomousRules(),
        ...policy,
        sandbox: effectiveSandbox,
        approval: approval("autonomous"),
      }
      return {
        ...profile,
        summary: summary(id, profile, workspace),
      }
    }

    case "full_access": {
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
      return { ...profile, summary: summary(id, profile, workspace) }
    }
  }
}

export async function getProfileLabel(id: string): Promise<string> {
  const profile = await buildProfile(normalizeProfileId(id), { workspace: "/", workspaceType: "main" })
  return profile.label
}
