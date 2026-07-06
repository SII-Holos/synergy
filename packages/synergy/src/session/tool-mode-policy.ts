import type { Capability } from "@/enforcement/gate"
import type { Info as SessionInfo } from "@/session/types"
import { ToolDiagnostic } from "@/tool/diagnostic"
import { ToolTaxonomy } from "@/tool/taxonomy"

export namespace SessionModePolicy {
  const PLAN_MODE_EXPLICIT_ALLOW = new Set([
    "bash",
    "read",
    "glob",
    "grep",
    "file_search",
    "view_file",
    "scan_files",
    "parse_code",
    "look_at",
    "view_image",
    "scan_document",
    "ast_grep",
    "lsp",
    "session_list",
    "session_read",
    "session_search",
    "note_list",
    "note_read",
    "note_search",
    "note_write",
    "note_edit",
    "memory_search",
    "memory_get",
    "task_list",
    "task_output",
    "dagread",
    "dagwrite",
    "dagpatch",
    "task",
    "task_cancel",
    "question",
    "skill",
    "search_tools",
    "expand_tools",
    "websearch",
    "webfetch",
    "agenda_list",
    "agenda_logs",
    "worktree_list",
  ])

  const PLAN_MODE_READ_KINDS = new Set([
    "search.web",
    "search.academic",
    "search.codebase",
    "search.session",
    "search.note",
    "search.memory",
    "code.read",
    "code.analyze",
    "knowledge.skill",
    "orchestration.session",
    "communication.question",
  ])

  const PLAN_MODE_ALLOWED_BASH_CAPABILITIES = new Set(["shell_read", "file_read", "file_external_read"])

  export function isPlanMode(session?: Pick<SessionInfo, "blueprint">) {
    return session?.blueprint?.planMode === true
  }

  export function visibility(input: {
    toolName: string
    session?: Pick<SessionInfo, "blueprint">
  }): ToolDiagnostic | undefined {
    if (!isPlanMode(input.session)) return undefined
    if (PLAN_MODE_EXPLICIT_ALLOW.has(input.toolName)) return undefined

    const taxonomy = ToolTaxonomy.classify(input.toolName)
    if (!taxonomy.traits.stateful && !taxonomy.traits.externalIO && PLAN_MODE_READ_KINDS.has(taxonomy.kind)) {
      return undefined
    }

    return planModeBlocked(input.toolName, {
      reason: "tool is not part of the Plan Mode planning surface",
      kind: taxonomy.kind,
      domain: taxonomy.domain,
      traits: taxonomy.traits,
    })
  }

  export function evaluateCall(input: {
    toolName: string
    args: Record<string, any>
    session?: Pick<SessionInfo, "blueprint">
    capabilities: Capability[]
  }): ToolDiagnostic | undefined {
    if (!isPlanMode(input.session)) return undefined

    const staticDiagnostic = visibility({ toolName: input.toolName, session: input.session })
    if (staticDiagnostic) return staticDiagnostic

    if (input.toolName !== "bash") return undefined

    const classes = [...new Set(input.capabilities.map((cap) => cap.class))]
    const blocked = classes.filter((className) => !PLAN_MODE_ALLOWED_BASH_CAPABILITIES.has(className))
    if (blocked.length === 0) return undefined

    return planModeBlocked(input.toolName, {
      reason: "bash command is not read-only under Plan Mode",
      command: String(input.args.command ?? ""),
      capabilities: classes,
      blockedCapabilities: blocked,
    })
  }

  export function unavailable(input: {
    toolName: string
    reason: "deferred" | "permission" | "user_disabled" | "audit_only" | "blueprint_loop_required"
    session?: Pick<SessionInfo, "blueprint">
    metadata?: Record<string, unknown>
  }): ToolDiagnostic {
    if (input.reason === "permission") {
      return {
        code: "permission_denied",
        toolName: input.toolName,
        mode: isPlanMode(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is disabled by the current permission rules. Choose another tool or ask the user to adjust permissions.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "user_disabled") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlanMode(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is disabled for this request. Choose a currently available tool instead.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "audit_only") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlanMode(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is only available to the active Blueprint audit session.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "blueprint_loop_required") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlanMode(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool requires an active BlueprintLoop session.`,
        metadata: input.metadata,
      }
    }

    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      mode: isPlanMode(input.session) ? "plan" : undefined,
      message: `The "${input.toolName}" tool is not currently visible. Use search_tools or expand_tools when a deferred planning capability is appropriate.`,
      metadata: input.metadata,
    }
  }

  function planModeBlocked(toolName: string, metadata: Record<string, unknown>): ToolDiagnostic {
    return {
      code: "plan_mode_blocked",
      toolName,
      mode: "plan",
      message: [
        `The "${toolName}" tool is blocked because this session is in Plan Mode.`,
        "Plan Mode may inspect and design, but it must not modify project files, start execution work, commit, push, deploy, or perform external identity actions.",
        "Continue with read-only investigation, planning tools, questions, or Blueprint note edits.",
      ].join("\n"),
      metadata,
    }
  }
}
