import type { Capability } from "@/enforcement/gate"
import type { Info as SessionInfo } from "@/session/types"
import { ToolDiagnostic } from "@/tool/diagnostic"
import { ToolTaxonomy } from "@/tool/taxonomy"

export namespace SessionModePolicy {
  const PLAN_EXPLICIT_ALLOW = new Set([
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

  const PLAN_READ_KINDS = new Set([
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

  const PATHWAY_TOOLS = new Set(["pathway_read", "pathway_patch"])

  export function isPlan(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "plan"
  }

  export function isLattice(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "lattice"
  }

  export function visibility(input: {
    toolName: string
    session?: Pick<SessionInfo, "workflow">
  }): ToolDiagnostic | undefined {
    const latticeDiagnostic = latticeVisibility(input.toolName, input.session)
    if (latticeDiagnostic) return latticeDiagnostic

    if (!isPlan(input.session)) return undefined
    if (PLAN_EXPLICIT_ALLOW.has(input.toolName)) return undefined

    const taxonomy = ToolTaxonomy.classify(input.toolName)
    if (!taxonomy.traits.stateful && !taxonomy.traits.externalIO && PLAN_READ_KINDS.has(taxonomy.kind)) {
      return undefined
    }

    return planBlocked(input.toolName, {
      reason: "tool is not part of the Plan planning surface",
      kind: taxonomy.kind,
      domain: taxonomy.domain,
      traits: taxonomy.traits,
    })
  }

  export function evaluateCall(input: {
    toolName: string
    args: Record<string, any>
    session?: Pick<SessionInfo, "workflow">
    capabilities: Capability[]
  }): ToolDiagnostic | undefined {
    if (!isPlan(input.session)) return undefined

    const staticDiagnostic = visibility({ toolName: input.toolName, session: input.session })
    if (staticDiagnostic) return staticDiagnostic
    return undefined
  }

  export function unavailable(input: {
    toolName: string
    reason:
      | "deferred"
      | "permission"
      | "user_disabled"
      | "audit_only"
      | "blueprint_loop_required"
      | "light_loop_required"
    session?: Pick<SessionInfo, "workflow" | "blueprint">
    metadata?: Record<string, unknown>
  }): ToolDiagnostic {
    if (input.reason === "permission") {
      return {
        code: "permission_denied",
        toolName: input.toolName,
        mode: isPlan(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is disabled by the current permission rules. Choose another tool or ask the user to adjust permissions.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "user_disabled") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlan(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is disabled for this request. Choose a currently available tool instead.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "audit_only") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlan(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool is only available to the active Blueprint audit session.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "blueprint_loop_required") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlan(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool requires an active BlueprintLoop session.`,
        metadata: input.metadata,
      }
    }

    if (input.reason === "light_loop_required") {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        mode: isPlan(input.session) ? "plan" : undefined,
        message: `The "${input.toolName}" tool requires an active Light Loop session.`,
        metadata: input.metadata,
      }
    }

    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      mode: isPlan(input.session) ? "plan" : undefined,
      message: `The "${input.toolName}" tool is not currently visible. Use search_tools or expand_tools when a deferred planning capability is appropriate.`,
      metadata: input.metadata,
    }
  }

  /**
   * Lattice tool visibility:
   *  - pathway_* tools are hidden outside an active Lattice session;
   *  - in auto mode after the first BlueprintLoop has started, `question` is
   *    hidden so the run keeps advancing without waiting for the user.
   */
  function latticeVisibility(toolName: string, session?: Pick<SessionInfo, "workflow">): ToolDiagnostic | undefined {
    if (!isLattice(session)) {
      if (PATHWAY_TOOLS.has(toolName)) {
        return {
          code: "tool_unavailable",
          toolName,
          message: `The "${toolName}" tool is only available while this session is in Lattice mode.`,
        }
      }
      return undefined
    }

    const workflow = session!.workflow!
    if (
      workflow.kind === "lattice" &&
      toolName === "question" &&
      workflow.mode === "auto" &&
      workflow.firstBlueprintStarted === true
    ) {
      return {
        code: "tool_unavailable",
        toolName,
        message: [
          `The "question" tool is disabled in autonomous Lattice mode once the first BlueprintLoop has started.`,
          "Do not wait for the user: replan forward and keep advancing the Pathway.",
        ].join("\n"),
      }
    }
    return undefined
  }

  function planBlocked(toolName: string, metadata: Record<string, unknown>): ToolDiagnostic {
    return {
      code: "plan_mode_blocked",
      toolName,
      mode: "plan",
      message: [
        `The "${toolName}" tool is blocked because this session is in Plan.`,
        "Plan may inspect and design, but it must not modify project files, start execution work, commit, push, deploy, or perform external identity actions.",
        "Continue with read-only investigation, planning tools, questions, or Blueprint note edits.",
      ].join("\n"),
      metadata,
    }
  }
}
