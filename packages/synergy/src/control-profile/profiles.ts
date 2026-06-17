import type { ControlProfile, ResolutionContext, ResolvedProfile } from "./types"

const NONBYPASSABLE_PERMS = [
  "file_external",
  "shell_destructive",
  "identity_act",
  "communication_email",
  "channel_outbound",
  "platform_control",
  "mcp_invoke",
  "plugin_invoke",
]

function nonBypassableRule(permission: string, action: "allow" | "deny" | "ask") {
  return {
    permission,
    pattern: "*",
    action,
    nonBypassable: true,
  }
}

function rule(permission: string, action: "allow" | "deny" | "ask") {
  return { permission, pattern: "*", action }
}

function workspaceFs(workspace: string) {
  return {
    readRoots: [workspace],
    writeRoots: [workspace],
    protectedPaths: [],
  }
}

function workspaceApply(workspace: string, extraRules: ReturnType<typeof rule>[]) {
  return [
    rule("file_read", "allow"),
    rule("file_write", "allow"),
    rule("shell", "ask"),
    rule("network_request", "ask"),
    ...NONBYPASSABLE_PERMS.map((p) => nonBypassableRule(p, "ask")),
    ...extraRules,
  ]
}

function reviewRules(): ReturnType<typeof rule>[] {
  return [
    rule("file_read", "allow"),
    rule("file_write", "deny"),
    rule("shell", "deny"),
    rule("shell_destructive", "deny"),
    rule("network_request", "deny"),
    ...["mcp_invoke", "plugin_invoke", "channel_outbound", "communication_email", "identity_act"].map((p) =>
      rule(p, "deny"),
    ),
    nonBypassableRule("file_external", "deny"),
    nonBypassableRule("platform_control", "deny"),
  ]
}

function workspacePolicy(workspace: string) {
  return {
    filesystem: workspaceFs(workspace),
    network: { mode: "restricted" as const },
    sandbox: { mode: "workspace_write" as const, fallback: "deny" as const },
  }
}

function reviewPolicy(workspace: string) {
  return {
    filesystem: {
      readRoots: [workspace],
      writeRoots: [],
      protectedPaths: [],
    },
    network: { mode: "disabled" as const },
    sandbox: { mode: "read_only" as const, fallback: "deny" as const },
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

function fullAccessRules(): ReturnType<typeof rule>[] {
  return [
    rule("file_read", "allow"),
    rule("file_write", "allow"),
    rule("shell", "allow"),
    rule("shell_destructive", "allow"),
    rule("network_request", "allow"),
    rule("file_external", "allow"),
    rule("mcp_invoke", "ask"),
    rule("plugin_invoke", "ask"),
    nonBypassableRule("identity_act", "ask"),
    nonBypassableRule("communication_email", "ask"),
    nonBypassableRule("channel_outbound", "ask"),
    nonBypassableRule("platform_control", "ask"),
  ]
}

const workspaceApprovalPolicy = {
  autoApprovePatterns: [],
  requireApprovalCategories: NONBYPASSABLE_PERMS,
  silentApproveNonBypassable: false,
}

const autoReviewApprovalPolicy = {
  autoApprovePatterns: ["file_read"],
  requireApprovalCategories: NONBYPASSABLE_PERMS,
  silentApproveNonBypassable: false,
}

const fullAccessApprovalPolicy = {
  autoApprovePatterns: ["file_read", "file_write", "file_external", "shell", "network_request"],
  requireApprovalCategories: ["identity_act", "communication_email", "channel_outbound", "platform_control"],
  silentApproveNonBypassable: false,
}

const reviewApprovalPolicy = {
  autoApprovePatterns: [],
  requireApprovalCategories: NONBYPASSABLE_PERMS,
  silentApproveNonBypassable: false,
}

export function buildProfile(id: string, ctx: ResolutionContext): ResolvedProfile {
  const { workspace, interactionMode } = ctx

  switch (id) {
    case "review": {
      const policy = reviewPolicy(workspace)
      return {
        valid: true,
        label: "审阅",
        ruleset: reviewRules(),
        ...policy,
        approvalPolicy: reviewApprovalPolicy,
        allowAllBlocked: true,
      }
    }

    case "workspace": {
      const policy = workspacePolicy(workspace)
      return {
        valid: true,
        label: "工作区",
        ruleset: workspaceApply(workspace, []),
        ...policy,
        approvalPolicy: workspaceApprovalPolicy,
      }
    }

    case "auto_review": {
      const policy = workspacePolicy(workspace)
      return {
        valid: true,
        label: "自动审查",
        ruleset: workspaceApply(workspace, []),
        ...policy,
        approvalPolicy: autoReviewApprovalPolicy,
      }
    }

    case "full_access": {
      if (interactionMode === "unattended") {
        return {
          valid: false,
          reason: "full_access profile is forbidden in unattended mode",
          label: "完全访问权限",
          ruleset: [],
          filesystem: { readRoots: [], writeRoots: [], protectedPaths: [] },
          network: { mode: "disabled" },
          sandbox: { mode: "read_only", fallback: "deny" },
          approvalPolicy: fullAccessApprovalPolicy,
          allowAllBlocked: false,
        }
      }
      const policy = fullAccessPolicy()
      return {
        valid: true,
        label: "完全访问权限",
        ruleset: fullAccessRules(),
        ...policy,
        approvalPolicy: fullAccessApprovalPolicy,
      }
    }

    default:
      throw new Error(`Unknown profile id: ${id}`)
  }
}

export function getProfileLabel(id: string): string {
  switch (id) {
    case "review":
      return "审阅"
    case "workspace":
      return "工作区"
    case "auto_review":
      return "自动审查"
    case "full_access":
      return "完全访问权限"
    default:
      throw new Error(`Unknown profile id: ${id}`)
  }
}
