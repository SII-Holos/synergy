export interface ApprovalCacheEntry {
  decision: "approved_for_session" | "denied"
  timestamp: number
}

export class ApprovalCache {
  private cache = new Map<string, ApprovalCacheEntry>()

  get(capabilityKey: string): "approved_for_session" | "denied" | null {
    const entry = this.cache.get(capabilityKey)
    if (!entry) return null
    return entry.decision
  }

  put(capabilityKey: string, decision: "approved_for_session" | "denied"): void {
    this.cache.set(capabilityKey, { decision, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

import { buildPermissionProfile, type SynergySandboxPermissionProfile } from "../sandbox/policy-engine"
import { Filesystem } from "../util/filesystem"

import { PathClassifier } from "./classify"
import { ShellSafety } from "./shell-safety"
import { ControlProfileCompiler } from "../control-profile/compiler"
import {
  type PrefixRule,
  evaluateCommand,
  generateAmendment,
  generateAmendmentForCapability,
  type ExecPolicyAmendment,
  type RuleMatch,
} from "./exec-policy"
import type { ProfileIdInput, ProfileRule, ProfileSandbox } from "../control-profile/types"

export interface Capability {
  class: string
  nonBypassable: boolean
  reason?: string
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
    guidance?: string
    amendment?: ExecPolicyAmendment
  }
  /** Populated when execPolicy generates an amendment for "ask" decisions */
  amendment?: ExecPolicyAmendment
}

export interface GateOptions {
  activeWorkspace: string
  workspaceType: string
  profileId?: ProfileIdInput
  interactionMode?: "attended" | "unattended"
  registeredMcpTools?: Set<string>
  registeredPluginTools?: Set<string>
  originalCheckout?: string
  /** Additional directories where read-only access is treated as inside-workspace.
   *  Write operations are never allowed through readRoots. */
  readRoots?: string[]
  execPolicy?: { rules: PrefixRule[] }
}

const DESTRUCTIVE_PATTERNS = [
  // File deletion
  "rm -rf",
  "rm -fr",
  "rm -r ",
  "rm -f ",
  "rmdir ",
  // Filesystem destruction
  "mkfs ",
  "fdisk ",
  "parted ",
  // LVM destructive
  "lvremove ",
  "pvremove ",
  "vgremove ",
  // Privilege escalation
  "sudo ",
  // Git destructive operations (subcommand-aware)
  "git reset --hard",
  "git clean -f",
  "git clean -x",
  "git branch -D",
  "git push --force",
  "git push -f",
  "git push --delete",
  "git stash clear",
  "git stash drop",
  "git stash pop",
  // Git history rewriting
  "git rebase ",
  "git filter-branch",
  "git reflog expire",
  "git reflog delete",
  // Git refined classifications — defense-in-depth
  "git push ",
  "git pull --rebase",
  "git pull -r",
  "git revert ",
  "git rm ",
  "git commit --amend",
  "git reset ",
]

const DESTRUCTIVE_REGEX = /(?:^|[\s;&|])dd\s/

const NETWORK_PATTERNS = [
  "curl ",
  "wget ",
  "nc ",
  "netcat",
  "http://",
  "https://",
  // Bash builtin network (critical — bypasses all tool-based detection)
  "/dev/tcp/",
  "/dev/udp/",
  // Advanced network tools
  "socat ",
  "openssl s_client",
  // Secure file transfer (exfiltration)
  "ssh ",
  "scp ",
  "rsync ",
  // DNS exfiltration
  "dig ",
  "nslookup ",
  "host ",
  // Raw network
  "telnet ",
  "ftp ",
  "sftp ",
  // Multi-protocol downloaders
  "aria2c ",
  "axel ",
  // Package managers (download + arbitrary script execution)
  "pip install",
  "pip3 install",
  "gem install",
  "cargo install",
]

const SAFE_PSEUDO_PATHS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
])

const EXTERNAL_NETWORK_TOOLS = new Set(["webfetch", "websearch", "arxiv_search", "arxiv_download"])

// const AGORA_NETWORK_TOOLS = new Set(["agora_read", "agora_search"])
//
// const AGORA_STATEFUL_TOOLS = new Set([
//   "agora_post",
//   "agora_comment",
//   "agora_submit",
//   "agora_sync",
//   "agora_join",
//   "agora_accept",
// ])

const AGENT_ORCHESTRATION_TOOLS = new Set([
  "runtime_reload",
  "session_control",
  "agenda_schedule",
  "agenda_watch",
  "agenda_update",
  "agenda_cancel",
  "agenda_trigger",
])

function isDestructive(command: string): string | null {
  const lower = command.toLowerCase()
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (lower.includes(p)) return p
  }
  if (DESTRUCTIVE_REGEX.test(lower)) return "dd with raw device"
  return null
}

function extractAbsolutePaths(command: string): string[] {
  const paths: string[] = []
  const pathPattern = /(?:\s|"|'|>|<|^|\|)(\/[^\s"'|;&]+)/g
  let match: RegExpExecArray | null
  while ((match = pathPattern.exec(command)) !== null) {
    const candidate = match[1]
    if (candidate.includes("/") && !SAFE_PSEUDO_PATHS.has(candidate)) paths.push(candidate)
  }
  // Post-filter: reject likely non-filesystem paths (URL fragments, commit message artifacts)
  const NON_PATH_PATTERNS = [
    /^\/[A-Z]{2,}$/,
    /^\/[a-z]{1,3}$/,
    /^\/usr\/bin\/[^/]+$/,
    /^\/bin\/[^/]+$/,
    /^\/sbin\/[^/]+$/,
    /:\/\//,
  ]
  return paths.filter((p) => !NON_PATH_PATTERNS.some((pat) => pat.test(p)))
}
function pathFromHashlinePatch(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const header = input.replace(/^\s+/, "").split("\n", 1)[0]?.trimEnd()
  const match = header?.match(/^\[([^#\]\n]+)#[0-9A-Fa-f]{4}\]$/)
  return match?.[1]
}

function allPathsFromMultiSectionPatch(input: unknown): string[] {
  if (typeof input !== "string") return []
  const headerPattern = /^\[([^#\]\n]+)#[0-9A-Fa-f]{4}\]$/gm
  const paths: string[] = []
  let m: RegExpExecArray | null
  while ((m = headerPattern.exec(input)) !== null) {
    const p = m[1]
    if (p && !paths.includes(p)) paths.push(p)
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
  options: { activeWorkspace: string; originalCheckout?: string; write?: boolean; readRoots?: string[] },
) {
  const classification = PathClassifier.classifyPath(pathInput, {
    workspace: options.activeWorkspace,
    originalCheckout: options.originalCheckout,
  })

  if (classification.boundary === "inside") {
    uniqueCapability(caps, {
      class: options.write ? "file_write" : "file_read",
      nonBypassable: false,
      paths: [pathInput],
    })
  } else if (!options.write && options.readRoots?.some((r) => Filesystem.contains(r, pathInput))) {
    uniqueCapability(caps, {
      class: "file_read",
      nonBypassable: false,
      paths: [pathInput],
    })
  } else {
    uniqueCapability(caps, { class: "file_external", nonBypassable: true, paths: [pathInput] })
  }
}

function extractShellPathArguments(command: string, cwd: string): string[] {
  const paths: string[] = []
  const commandPattern =
    /(?:^|[;&|]\s*)(cd|rm|cp|mv|mkdir|touch|chmod|chown|cat|tee|ln|install|dd|python3?|python2?|node|ruby|perl)\s+([^;&|]+)/g
  let match: RegExpExecArray | null
  while ((match = commandPattern.exec(command)) !== null) {
    const [, name, rawArgs] = match
    let prevWasFlag = false
    for (const raw of rawArgs.trim().split(/\s+/)) {
      if (!raw) continue
      if (prevWasFlag) {
        prevWasFlag = false
        continue
      }
      if (raw.startsWith("-")) {
        prevWasFlag = true
        continue
      }
      if (name === "chmod" && (raw.startsWith("+") || /^\d+$/.test(raw))) continue
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
  export async function create(options: GateOptions) {
    const {
      activeWorkspace,
      workspaceType,
      profileId: rawProfileId = "guarded",
      interactionMode = "attended",
      registeredMcpTools = new Set<string>(),
      registeredPluginTools = new Set<string>(),
      originalCheckout,
      readRoots,
      execPolicy,
    } = options
    const profileId = ControlProfileCompiler.normalize(rawProfileId)

    const resolved = await ControlProfileCompiler.resolve(profileId, {
      workspace: activeWorkspace,
      workspaceType,
      interactionMode,
    })

    if (!resolved.valid) {
      throw new Error(resolved.reason ?? "Invalid profile for this context")
    }
    const auditRecords: AuditRecord[] = []
    const pendingCapabilities = new Set<string>()
    // Accumulated sandbox-approved paths across all evaluate() calls
    const approvedReadPaths = new Set<string>()
    const approvedWritePaths = new Set<string>()
    let approvedNetwork = false
    const approvalCache = new ApprovalCache()

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
          classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout, readRoots })
        }
        return { capabilities: caps }
      }

      // File write operations
      if (toolName === "write" || toolName === "edit" || toolName === "revise_file" || toolName === "save_file") {
        if (toolName === "revise_file") {
          const multiPaths = allPathsFromMultiSectionPatch(args.input)
          const paths =
            multiPaths.length > 0 ? multiPaths : ([pathFromHashlinePatch(args.input)].filter(Boolean) as string[])
          for (const p of paths) {
            classifyPathCapability(caps, p, { activeWorkspace, originalCheckout, write: true })
          }
        } else {
          const filePath = args.filePath ?? args.path ?? ""
          if (filePath) {
            classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout, write: true })
          }
        }
        return { capabilities: caps }
      }

      // Document / attachment tools
      if (toolName === "scan_document" || toolName === "look_at" || toolName === "attach") {
        const raw = args.filePath ?? args.file_path ?? ""
        const filePath = Array.isArray(raw) ? (raw[0] ?? "") : raw
        if (filePath) {
          classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout, readRoots })
        }
        return { capabilities: caps }
      }

      //       // Agora is external collaboration I/O. Join/accept also touch local
      //       // directories, so they keep the file path classification in addition to
      //       // network/platform capabilities.
      //       if (AGORA_NETWORK_TOOLS.has(toolName) || AGORA_STATEFUL_TOOLS.has(toolName)) {
      //         caps.push({ class: "network_request", nonBypassable: true })
      //         if (AGORA_STATEFUL_TOOLS.has(toolName)) {
      //           caps.push({ class: "platform_control", nonBypassable: true })
      //         }
      //         if (toolName === "agora_join" || toolName === "agora_accept") {
      //           const dir = args.directory ?? ""
      //           if (dir) {
      //             classifyPathCapability(caps, dir, { activeWorkspace, originalCheckout, write: true })
      //           }
      //         }
      //         return { capabilities: caps }
      //       }

      // Shell operations
      if (toolName === "bash") {
        const command: string = args.command ?? ""
        const risk = ShellSafety.classifyBashRisk(command)

        if (risk === "shell_hardline") {
          caps.push({
            class: "shell_hardline",
            nonBypassable: true,
            reason: `hardline rule matched: ${command.slice(0, 200)}`,
          })
          return { capabilities: caps }
        }

        caps.push({ class: risk, nonBypassable: false })

        if (risk !== "shell_destructive" && isDestructive(command)) {
          const matched = isDestructive(command)
          caps.push({
            class: "shell_destructive",
            nonBypassable: true,
            reason: matched ? `matched destructive pattern: ${matched}` : undefined,
          })
        }

        const cwd = args.workdir ?? activeWorkspace
        if (args.workdir) {
          classifyPathCapability(caps, args.workdir, { activeWorkspace, originalCheckout, readRoots })
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

      // SII Inspire tools call external compute infrastructure.
      if (toolName.startsWith("inspire_")) {
        caps.push({ class: "network_request", nonBypassable: true })
        return { capabilities: caps }
      }

      if (AGENT_ORCHESTRATION_TOOLS.has(toolName)) {
        caps.push({ class: "file_write", nonBypassable: false })
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

      // Session query tools (read-only)
      if (toolName === "session_list" || toolName === "session_search" || toolName === "session_read") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Note query tools (read-only)
      if (toolName === "note_list" || toolName === "note_search" || toolName === "note_read") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Note write tools
      if (toolName === "note_write" || toolName === "note_edit") {
        caps.push({ class: "file_write", nonBypassable: false })
        return { capabilities: caps }
      }

      // Memory query tools (read-only)
      if (toolName === "memory_search" || toolName === "memory_get") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Memory write tools
      if (toolName === "memory_write" || toolName === "memory_edit") {
        caps.push({ class: "file_write", nonBypassable: false })
        return { capabilities: caps }
      }

      // Worktree tools
      if (toolName === "worktree_list") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }
      if (toolName === "worktree_enter" || toolName === "worktree_leave") {
        caps.push({ class: "file_write", nonBypassable: false })
        return { capabilities: caps }
      }

      // Read-only orchestration tools — internal agent coordination, no side effects
      if (toolName === "dagread" || toolName === "todoread" || toolName === "task_list" || toolName === "task_output") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Stateful orchestration tools — create/mutate internal state
      if (
        toolName === "dagwrite" ||
        toolName === "dagpatch" ||
        toolName === "todowrite" ||
        toolName === "task" ||
        toolName === "task_cancel" ||
        toolName === "batch"
      ) {
        caps.push({ class: "file_write", nonBypassable: false })
        return { capabilities: caps }
      }

      // Internal communication / knowledge tools — read-only user/model interactions
      if (toolName === "question" || toolName === "skill" || toolName === "render" || toolName === "diagram") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Agenda read tools
      if (toolName === "agenda_list" || toolName === "agenda_logs") {
        caps.push({ class: "file_read", nonBypassable: false })
        return { capabilities: caps }
      }

      // Filesystem listing / AST-aware search — file_read with path classification
      if (toolName === "list" || toolName === "ast_grep" || toolName === "lsp") {
        if (toolName === "ast_grep") {
          const paths: string[] = Array.isArray(args.paths) ? args.paths : []
          for (const p of paths) {
            classifyPathCapability(caps, p, { activeWorkspace, originalCheckout, readRoots })
          }
          if (paths.length === 0) {
            caps.push({ class: "file_read", nonBypassable: false })
          }
        } else {
          const filePath = args.filePath ?? args.path ?? args.pattern ?? ""
          if (filePath) {
            classifyPathCapability(caps, filePath, { activeWorkspace, originalCheckout, readRoots })
          } else {
            caps.push({ class: "file_read", nonBypassable: false })
          }
        }
        return { capabilities: caps }
      }

      // Process management — action-based classification
      if (toolName === "process") {
        const action = args.action ?? ""
        if (
          action === "write" ||
          action === "send-keys" ||
          action === "kill" ||
          action === "clear" ||
          action === "remove"
        ) {
          caps.push({ class: "shell", nonBypassable: false })
        } else {
          caps.push({ class: "file_read", nonBypassable: false })
        }
        return { capabilities: caps }
      }

      // Remote connection — action-based classification
      if (toolName === "connect") {
        const action = args.action ?? ""
        if (action === "open" || action === "close") {
          caps.push({ class: "network_request", nonBypassable: true })
        } else {
          caps.push({ class: "file_read", nonBypassable: false })
        }
        return { capabilities: caps }
      }
      // Default: unknown tool, no capabilities
      return { capabilities: caps }
    }

    function buildCapabilityKey(caps: Capability[]): string {
      const classes = [...new Set(caps.filter((c) => c.class !== "file_read").map((c) => c.class))].sort()
      return classes.join("|") || "file_read"
    }

    function evaluate(toolName: string, args: Record<string, any>): Envelope {
      // ── ExecPolicy: bash command routing ──────────────────────────────
      let execPolicyMatch: RuleMatch | undefined
      let amendment: ExecPolicyAmendment | undefined

      if (execPolicy && toolName === "bash") {
        const rawCmd: string = args.command ?? ""
        const words = rawCmd.trim().split(/\s+/).filter(Boolean)
        if (words.length > 0) {
          execPolicyMatch = evaluateCommand(words, execPolicy.rules)
        }
      }

      if (execPolicyMatch) {
        // "allow" → gate passes; no capabilities needed (policy-authorised)
        if (execPolicyMatch.action === "allow") {
          return {
            decision: "allow",
            profileId,
            opaque: false,
            capabilities: [],
            amendment,
            canAutoApprove() {
              return true
            },
          }
        }

        // "deny" → hardline forbid
        if (execPolicyMatch.action === "deny") {
          const caps: Capability[] = [{ class: "shell_hardline", nonBypassable: true }]
          auditRecords.push({ tool: toolName, capabilities: caps, timestamp: Date.now() })
          return {
            decision: "deny",
            profileId,
            opaque: false,
            capabilities: caps,
            amendment,
            refusal: {
              reason: `ExecPolicy forbids command prefix [${execPolicyMatch.matchedRule?.prefix?.join(" ") ?? ""}]`,
              permanent: true,
              matchedPermission: "shell_hardline",
            },
            canAutoApprove() {
              return false
            },
          }
        }

        // "ask" → generate amendment, then fall through to normal classify
        amendment = generateAmendment(execPolicyMatch) ?? undefined
      }

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
      }

      // When execPolicy says "ask", override profile decision to "ask"
      if (execPolicyMatch?.action === "ask") {
        decision = "ask"
      }

      // Approval cache: if the profile says "ask" but the capability was
      // previously approved for this session, skip the prompt.
      if (decision === "ask") {
        const key = buildCapabilityKey(capabilities)
        const cached = approvalCache.get(key)
        if (cached === "approved_for_session") {
          decision = "allow"
        }
      }

      // Populate refusal info for deny decisions
      let refusal: Envelope["refusal"]
      if (decision === "deny") {
        const isAutonomous = profileId === "autonomous"
        const diagnosticReasons = capabilities
          .filter((c) => c.reason)
          .map((c) => c.reason)
          .join("; ")

        refusal = {
          reason: diagnosticReasons
            ? `Profile "${profileId}" denies capability "${deniedCapClass ?? "unknown"}" — ${diagnosticReasons}`
            : `Profile "${profileId}" denies capability "${deniedCapClass ?? "unknown"}"`,
          permanent: true,
          matchedPermission: deniedCapClass ?? "unknown",
          guidance:
            diagnosticReasons || (isAutonomous ? "Switch to guarded profile to approve this operation." : undefined),
          amendment: isAutonomous && deniedCapClass ? generateAmendmentForCapability(deniedCapClass) : undefined,
        }
      }

      // Accumulate sandbox-approved paths when the profile auto-allows
      if (decision === "allow") {
        for (const cap of capabilities) {
          if (cap.paths?.length) {
            if (cap.class === "file_read" || cap.class === "file_external") {
              for (const p of cap.paths) approvedReadPaths.add(p)
            } else if (cap.class === "file_write") {
              for (const p of cap.paths) approvedWritePaths.add(p)
            }
          }
          if (cap.class === "network_request") {
            approvedNetwork = true
          }
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
        amendment,
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
      /** Register approval-granted external paths from outside the gate (e.g. tool-resolver). */
      registerApprovedPaths(readPaths: string[], writePaths: string[], network: boolean) {
        for (const p of readPaths) approvedReadPaths.add(p)
        for (const p of writePaths) approvedWritePaths.add(p)
        if (network) approvedNetwork = true
      },
      /**
       * Build the aggregated sandbox permission profile from all accumulated
       * approved paths. Returns null when sandbox is disabled.
       */
      getSandboxPolicy(): SynergySandboxPermissionProfile | null {
        const sandbox = resolved.sandbox
        if (sandbox.mode === "none") return null
        return buildPermissionProfile({
          workspace: activeWorkspace,
          executionCwd: activeWorkspace,
          sandboxMode: sandbox.mode,
          approvedReadPaths: [...approvedReadPaths],
          approvedWritePaths: [...approvedWritePaths],
          approvedNetwork,
          approvedUnixSockets: [],
        })
      },
      /** Record a session-level approval for the capability classes in this envelope. */
      approveCapability(capabilities: Capability[]) {
        const key = buildCapabilityKey(capabilities)
        approvalCache.put(key, "approved_for_session")
      },
      /** Record a session-level denial for the capability classes in this envelope. */
      denyCapability(capabilities: Capability[]) {
        const key = buildCapabilityKey(capabilities)
        approvalCache.put(key, "denied")
      },
      /** Clear all session-level approval cache entries. */
      clearApprovalCache() {
        approvalCache.clear()
      },
    }
  }
}
