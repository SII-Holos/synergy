import { PathClassifier } from "./classify"
import { ControlProfileCompiler } from "../control-profile/compiler"
import type { ProfileId, ProfileRule } from "../control-profile/types"

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
      if (toolName === "read" || toolName === "glob" || toolName === "grep") {
        const filePath = args.filePath ?? args.path ?? args.pattern ?? ""
        if (filePath) {
          const result = PathClassifier.classifyPath(filePath, { workspace: activeWorkspace })
          if (result.boundary === "inside") {
            caps.push({ class: "file_read", nonBypassable: false })
          } else {
            caps.push({ class: "file_external", nonBypassable: true })
          }
        }
        return { capabilities: caps }
      }

      // File write operations
      if (toolName === "write" || toolName === "edit") {
        const filePath = args.filePath ?? args.path ?? ""
        if (filePath) {
          const result = PathClassifier.classifyPath(filePath, { workspace: activeWorkspace })
          if (result.boundary === "inside") {
            caps.push({ class: "file_write", nonBypassable: false })
          } else {
            caps.push({ class: "file_external", nonBypassable: true })
          }
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

        // Check for external absolute paths in command
        const extPaths = extractAbsolutePaths(command)
        for (const extPath of extPaths) {
          const result = PathClassifier.classify(extPath, { workspace: activeWorkspace })
          if (result.boundary === "outside") {
            caps.push({ class: "file_external", nonBypassable: true })
            break // Only add file_external once
          }
        }

        // Check for network activity
        if (hasNetworkActivity(command)) {
          caps.push({ class: "network_request", nonBypassable: true })
        }

        return { capabilities: caps }
      }

      // Network operations
      if (toolName === "web_fetch" || toolName === "fetch") {
        caps.push({ class: "network_request", nonBypassable: true })
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
