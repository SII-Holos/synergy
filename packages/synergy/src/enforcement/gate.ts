import { PathClassifier } from "./classify"
import { ShellSafety } from "./shell-safety"
import { ControlProfileCompiler } from "../control-profile/compiler"
import type { ProfileIdInput, ProfileRule, ProfileSandbox } from "../control-profile/types"

export interface Capability {
  class: string
  nonBypassable: boolean
  opaque?: boolean
  paths?: string[]
}

export interface ClassifyResult {
  capabilities: Capability[]
}

export interface AuditRecord {
  tool: string
  capabilities: Capability[]
  timestamp: number
}

export interface Envelope {
  decision: "allow" | "ask" | "deny"
  profileId: string
  opaque: boolean
  canAutoApprove(): boolean
  capabilities: Capability[]
  /** Populated when decision is "deny" — explains why and whether retrying would help */
  refusal?: {
    reason: string
    permanent: boolean
    matchedPermission: string
  }
}

export interface GateOptions {
  activeWorkspace: string
  workspaceType: string
  profileId?: ProfileIdInput
  interactionMode?: "attended" | "unattended"
  registeredMcpTools?: Set<string>
  registeredPluginTools?: Set<string>
  originalCheckout?: string
}

const DESTRUCTIVE_PATTERNS = ["rm -rf", "sudo ", "dd "]

const NETWORK_PATTERNS = ["curl ", "wget ", "nc ", "netcat", "http://", "https://"]

const SAFE_PSEUDO_PATHS = new Set(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])

const EXTERNAL_NETWORK_TOOLS = new Set(["webfetch", "websearch", "arxiv_search", "arxiv_download"])

const AGORA_NETWORK_TOOLS = new Set(["agora_read", "agora_search"])

const AGORA_STATEFUL_TOOLS = new Set([
  "agora_post",
  "agora_comment",
  "agora_submit",
  "agora_sync",
  "agora_join",
  "agora_accept",
])

const INSPIRE_STATEFUL_TOOLS = new Set([
  "inspire_login",
  "inspire_submit",
  "inspire_submit_hpc",
  "inspire_stop",
  "inspire_image_push",
  "inspire_notebook",
  "inspire_inference",
])

const PLATFORM_CONTROL_TOOLS = new Set([
  "runtime_reload",
  "session_control",
  "profile_update",
  "agenda_schedule",
  "agenda_watch",
  "agenda_update",
  "agenda_cancel",
  "agenda_trigger",
])

function isDestructive(command: string): boolean {
  const lower = command.toLowerCase()
  return DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p))
}

function extractAbsolutePaths(command: string): string[] {
  const paths: string[] = []
  const pathPattern = /(?:\s|"|'|>|<|^|\|)(\/[^\s"'|;&]+)/g
  let match: RegExpExecArray | null
  while ((match = pathPattern.exec(command)) !== null) {
    const candidate = match[1]
    if (candidate.includes("/") && !SAFE_PSEUDO_PATHS.has(candidate)) paths.push(candidate)
  }
  return paths
}

function uniqueCapability(caps: Capability[], cap: Capability) {
  const existing = caps.find((item) => item.class === cap.class && item.nonBypassable === cap.nonBypassable)
  if (existing) {
    if (cap.paths?.length) existing.paths = [...new Set([...(existing.paths ?? []), ...cap.paths])]
    return
  }
  caps.push(cap)
}

function classifyPathCapability(
  caps: Capability[],
  pathInput: string,
  options: { activeWorkspace: string; originalCheckout?: string; write?: boolean },
) {
  const result = PathClassifier.classifyPath(pathInput, {
    workspace: options.activeWorkspace,
    originalCheckout: options.originalCheckout,
  })
  if (result.boundary === "inside") {
    uniqueCapability(caps, {
      class: options.write ? "file_write" : "file_read",
      nonBypassable: false,
      paths: [pathInput],
    })
  } else {
    uniqueCapability(caps, { class: "file_external", nonBypassable: true, paths: [pathInput] })
  }
}

function extractShellPathArguments(command: string, cwd: string): string[] {
  const paths: string[] = []
  const commandPattern = /(?:^|[;&|]\s*)(cd|rm|cp|mv|mkdir|touch|chmod|chown)\s+([^;&|]+)/g
  let match: RegExpExecArray | null
  while ((match = commandPattern.exec(command)) !== null) {
    const [, name, rawArgs] = match
    for (const raw of rawArgs.trim().split(/\s+/)) {
      if (!raw || raw.startsWith("-") || (name === "chmod" && raw.startsWith("+"))) continue
      paths.push(raw.startsWith("/") ? raw : `${cwd}/${raw}`)
    }
  }
  return paths
}

function hasNetworkActivity(command: string): boolean {
  const lower = command.toLowerCase()
  return NETWORK_PATTERNS.some((p) => lower.includes(p))
}

function matchRule(cap: Capability, rules: ProfileRule[], unmatchedAction: ProfileRule["action"]): ProfileRule {
  for (const rule of rules) {
    if (rule.permission === cap.class) return rule
  }
  return { permission: cap.class, pattern: "*", action: unmatchedAction }
}

export namespace EnforcementGate {
  export function create(options: GateOptions) {
    const {
      activeWorkspace,
      workspaceType,
      profileId: rawProfileId = "guarded",
      interactionMode = "attended",
      registeredMcpTools = new Set<string>(),
      registeredPluginTools = new Set<string>(),
      originalCheckout,
    } = options
    const profileId = ControlProfileCompiler.normalize(rawProfileId)

    const resolved = ControlProfileCompiler.resolve(profileId, {
      workspace: activeWorkspace,
      workspaceType,
      interactionMode,
    })

    if (!resolved.valid) {
      throw new Error(resolved.reason ?? "Invalid profile for this context")
    }

    const auditRecords: AuditRecord[] = []
    const pendingCapabilities = new Set<string>()

    function classify(toolName: string, args: Record<string, any>): ClassifyResult {
      const caps: Capability[] = []

      // MCP tools: mcp__server__tool
      if (toolName.startsWith("mcp__")) {
        const opaque = !registeredMcpTools.has(toolName)
        caps.push({ class: "mcp_invoke", nonBypassable: true, opaque })
        return { capabilities: caps }
      }

      // Plugin tools: plugin__plugin__action
      if (toolName.startsWith("plugin__")) {
        const opaque = !registeredPluginTools.has(toolName)
        caps.push({ class: "plugin_invoke", nonBypassable: true, opaque })
        return { capabilities: caps }
      }

      // File read operations
      if (
        toolName === "read" ||
        toolName === "glob" ||
        toolName === "grep" ||
        toolName === "view_file" ||
        toolName === "scan_files" ||
        toolName === "parse_code"
      ) {
        const filePath = args.filePath ?? args.path ?? args.pattern ?? ""
        if (filePath) {
          classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout })
        }
        return { capabilities: caps }
      }

      // File write operations
      if (toolName === "write" || toolName === "edit" || toolName === "revise_file" || toolName === "save_file") {
        const filePath = args.filePath ?? args.path ?? ""
        if (filePath) {
          classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout, write: true })
        }
        return { capabilities: caps }
      }

      // Document / attachment tools
      if (toolName === "scan_document" || toolName === "look_at" || toolName === "attach") {
        const raw = args.filePath ?? args.file_path ?? ""
        const filePath = Array.isArray(raw) ? (raw[0] ?? "") : raw
        if (filePath) {
          classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout })
        }
        return { capabilities: caps }
      }

      // Agora is external collaboration I/O. Join/accept also touch local
      // directories, so they keep the file path classification in addition to
      // network/platform capabilities.
      if (AGORA_NETWORK_TOOLS.has(toolName) || AGORA_STATEFUL_TOOLS.has(toolName)) {
        caps.push({ class: "network_request", nonBypassable: true })
        if (AGORA_STATEFUL_TOOLS.has(toolName)) {
          caps.push({ class: "platform_control", nonBypassable: true })
        }
        if (toolName === "agora_join" || toolName === "agora_accept") {
          const dir = args.directory ?? ""
          if (dir) {
            classifyPathCapability(caps, dir, { activeWorkspace, originalCheckout, write: true })
          }
        }
        return { capabilities: caps }
      }

      // Shell operations
      if (toolName === "bash") {
        const command: string = args.command ?? ""
        caps.push({ class: ShellSafety.capability(command), nonBypassable: false })

        if (isDestructive(command)) {
          caps.push({ class: "shell_destructive", nonBypassable: true })
        }

        const cwd = args.workdir ?? activeWorkspace
        if (args.workdir) {
          classifyPathCapability(caps, args.workdir, { activeWorkspace, originalCheckout })
        }

        const pathCandidates = [...extractAbsolutePaths(command), ...extractShellPathArguments(command, cwd)]
        for (const candidate of pathCandidates) {
          const result = PathClassifier.classifyPath(candidate, { workspace: activeWorkspace, originalCheckout })
          if (result.boundary === "outside") {
            uniqueCapability(caps, { class: "file_external", nonBypassable: true, paths: [candidate] })
          }
        }

        // Check for network activity
        if (hasNetworkActivity(command)) {
          caps.push({ class: "network_request", nonBypassable: true })
        }

        return { capabilities: caps }
      }

      // Network and external lookup operations
      if (EXTERNAL_NETWORK_TOOLS.has(toolName)) {
        caps.push({ class: "network_request", nonBypassable: true })
        return { capabilities: caps }
      }

      // Email read/write both cross the user's communication boundary.
      if (toolName === "email_read" || toolName === "email_send") {
        caps.push({ class: "communication_email", nonBypassable: true })
        return { capabilities: caps }
      }

      // SII Inspire tools call external compute infrastructure. Stateful tools
      // additionally control platform resources and must stay non-bypassable.
      if (toolName.startsWith("inspire_")) {
        caps.push({ class: "network_request", nonBypassable: true })
        if (INSPIRE_STATEFUL_TOOLS.has(toolName)) {
          caps.push({ class: "platform_control", nonBypassable: true })
        }
        return { capabilities: caps }
      }

      if (PLATFORM_CONTROL_TOOLS.has(toolName)) {
        caps.push({ class: "platform_control", nonBypassable: true })
        return { capabilities: caps }
      }

      // session_send: user role can trigger another agent as the user; assistant
      // role is still an outbound channel operation and remains profile-gated.
      if (toolName === "session_send") {
        const role = args.role ?? ""
        if (role === "user") {
          caps.push({ class: "identity_act", nonBypassable: true })
        } else {
          caps.push({ class: "channel_outbound", nonBypassable: true })
        }
        return { capabilities: caps }
      }

      // Default: unknown tool, no capabilities
      return { capabilities: caps }
    }

    function evaluate(toolName: string, args: Record<string, any>): Envelope {
      const { capabilities } = classify(toolName, args)

      let decision: "allow" | "ask" | "deny" = "allow"
      const rules = resolved.ruleset

      let deniedCapClass: string | undefined
      for (const cap of capabilities) {
        const rule = matchRule(cap, rules, resolved.approval.highRisk)

        if (rule.action === "deny") {
          decision = "deny"
          deniedCapClass = cap.class
          break // deny is final
        }

        if (rule.action === "ask") {
          decision = "ask"
          continue // Keep checking — a later deny overrides
        }
        // rule.action === "allow" — profile explicitly allows this capability.
        // NonBypassable/opaque affect explicit asks and metadata, not an
        // already-allowed profile decision.
        // Allow stands unless overridden
      }

      // Populate refusal info for deny decisions
      let refusal: Envelope["refusal"]
      if (decision === "deny") {
        refusal = {
          reason: `Profile "${profileId}" denies capability "${deniedCapClass ?? "unknown"}"`,
          permanent: true,
          matchedPermission: deniedCapClass ?? "unknown",
        }
      }

      const opaque = capabilities.some((c) => c.opaque === true)

      // Track pending capabilities
      for (const cap of capabilities) {
        pendingCapabilities.add(cap.class)
      }

      // Audit
      auditRecords.push({
        tool: toolName,
        capabilities,
        timestamp: Date.now(),
      })

      return {
        decision,
        profileId,
        opaque,
        capabilities,
        refusal,
        canAutoApprove() {
          return !capabilities.some((c) => c.nonBypassable || c.opaque)
        },
      }
    }

    return {
      classify,
      evaluate,
      getSandbox(): ProfileSandbox {
        return resolved.sandbox
      },
      getWorkspace(): string {
        return activeWorkspace
      },
      getProfileInfo() {
        return {
          profileId,
          sandbox: resolved.sandbox,
          ruleset: resolved.ruleset,
          approval: resolved.approval,
          summary: resolved.summary,
        }
      },
      clearAudit() {
        auditRecords.length = 0
      },
      getAuditRecords() {
        return auditRecords
      },
      hasPendingCapability(className: string) {
        return pendingCapabilities.has(className)
      },
      resolveCapability(className: string) {
        pendingCapabilities.delete(className)
      },
    }
  }
}
