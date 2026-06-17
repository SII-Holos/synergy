import { PathClassifier } from "./classify"
import { ControlProfileCompiler } from "../control-profile/compiler"
import type { ProfileId, ProfileRule, ProfileSandbox } from "../control-profile/types"

export interface Capability {
  class: string
  nonBypassable: boolean
  opaque?: boolean
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
}

export interface GateOptions {
  activeWorkspace: string
  workspaceType: string
  profileId?: ProfileId
  interactionMode?: "attended" | "unattended"
  registeredMcpTools?: Set<string>
  registeredPluginTools?: Set<string>
  originalCheckout?: string
}

const DESTRUCTIVE_PATTERNS = ["rm -rf", "sudo ", "dd "]

const NETWORK_PATTERNS = ["curl ", "wget ", "nc ", "netcat", "http://", "https://"]

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
    if (candidate.includes("/")) paths.push(candidate)
  }
  return paths
}

function uniqueCapability(caps: Capability[], cap: Capability) {
  if (caps.some((existing) => existing.class === cap.class && existing.nonBypassable === cap.nonBypassable)) return
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
    uniqueCapability(caps, { class: options.write ? "file_write" : "file_read", nonBypassable: false })
  } else {
    uniqueCapability(caps, { class: "file_external", nonBypassable: true })
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

function matchRule(cap: Capability, rules: ProfileRule[]): ProfileRule {
  for (const rule of rules) {
    if (rule.permission === cap.class) return rule
  }
  return { permission: cap.class, pattern: "*", action: "deny" }
}

export namespace EnforcementGate {
  export function create(options: GateOptions) {
    const {
      activeWorkspace,
      workspaceType,
      profileId: rawProfileId = "workspace",
      interactionMode = "attended",
      registeredMcpTools = new Set<string>(),
      registeredPluginTools = new Set<string>(),
      originalCheckout,
    } = options
    const profileId: string = rawProfileId

    const resolved = ControlProfileCompiler.resolve(profileId, {
      workspace: activeWorkspace,
      workspaceType,
      interactionMode,
    })

    if (!resolved.valid) {
      throw new Error(resolved.reason ?? "Invalid profile for this context")
    }

    let allowAll = false
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

      // Agora tools — directory path outside workspace
      if (toolName === "agora_join" || toolName === "agora_accept") {
        const dir = args.directory ?? ""
        if (dir) {
          classifyPathCapability(caps, dir, { activeWorkspace, originalCheckout, write: true })
        }
        return { capabilities: caps }
      }

      // Shell operations
      if (toolName === "bash") {
        const command: string = args.command ?? ""
        caps.push({ class: "shell", nonBypassable: false })

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
            uniqueCapability(caps, { class: "file_external", nonBypassable: true })
            break
          }
        }

        // Check for network activity
        if (hasNetworkActivity(command)) {
          caps.push({ class: "network_request", nonBypassable: true })
        }

        return { capabilities: caps }
      }

      // Network operations
      if (toolName === "web_fetch" || toolName === "fetch" || toolName === "websearch") {
        caps.push({ class: "network_request", nonBypassable: true })
        return { capabilities: caps }
      }

      // email_send — nonBypassable communication
      if (toolName === "email_send") {
        caps.push({ class: "communication_email", nonBypassable: true })
        return { capabilities: caps }
      }

      // session_send with role=user — identity act
      if (toolName === "session_send") {
        const role = args.role ?? ""
        if (role === "user") {
          caps.push({ class: "identity_act", nonBypassable: true })
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

      for (const cap of capabilities) {
        const rule = matchRule(cap, rules)

        if (rule.action === "deny") {
          decision = "deny"
          break // deny is final
        }

        if (rule.action === "ask") {
          decision = "ask"
          continue // Keep checking — a later deny overrides
        }
        // rule.action === "allow" — profile explicitly allows this capability.
        // NonBypassable/opaque only affect canAutoApprove() and allowAll bypass,
        // not the decision when the profile has an explicit allow rule.
        // Allow stands unless overridden
      }

      // allowAll can auto-approve only non-nonBypassable, non-opaque capabilities
      if (allowAll && decision === "ask") {
        const allSafe = capabilities.every((c) => !c.nonBypassable && !c.opaque)
        if (allSafe) decision = "allow"
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
      clearAudit() {
        auditRecords.length = 0
      },
      getAuditRecords() {
        return auditRecords
      },
      setAllowAll(flag: boolean) {
        allowAll = flag
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
