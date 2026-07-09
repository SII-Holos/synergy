import z from "zod"
import { Tool } from "./tool"
import { PermissionNext } from "../permission/next"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { SessionInvoke } from "../session/invoke"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { MessageV2 } from "../session/message-v2"
import { SessionInteraction } from "../session/interaction"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Worktree } from "../project/worktree"
import DESCRIPTION from "./session-control.txt"

const Action = z.enum([
  "create",
  "status",
  "compact",
  "abort",
  "worktree_enter",
  "worktree_leave",
  "set_agent",
  "set_model",
  "set_mode",
  "set_control_profile",
  "question_reply",
  "question_reject",
  "permission_reply",
])

const ModelRef = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
})

const WorkspaceSelection = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("current"),
  }),
  z.object({
    mode: z.literal("existing"),
    target: z.string().min(1),
    force: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal("create"),
    name: z.string().optional(),
    baseRef: z.enum(["current", "fresh"]).optional(),
    baseRevision: z.string().min(1).optional(),
  }),
])

const parameters = z.object({
  target: z.string().optional().describe("Target session ID (ses_xxx). Required for every action except create."),
  action: Action.describe("The control action to perform on the target session."),
  title: z.string().optional().describe("Title for create, or an updated title when supported by future actions."),
  initialMessage: z
    .string()
    .optional()
    .describe("Initial user message to enqueue after create. The new session processes it asynchronously."),
  scopeID: z.string().optional().describe("Scope ID for create. Defaults to the current scope."),
  directory: z.string().optional().describe("Project directory for create when scopeID is not provided."),
  workspace: WorkspaceSelection.optional().describe("Workspace selection for create."),
  agent: z.string().optional().describe("Agent name for create or set_agent."),
  model: ModelRef.optional().describe("Model override for create or set_model."),
  mode: SessionInteraction.Mode.optional().describe("Interaction mode for create or set_mode."),
  modeSource: z.string().optional().describe("Optional source label for set_mode; defaults to session_control."),
  controlProfile: z
    .enum(["guarded", "autonomous", "full_access"])
    .optional()
    .describe("Control profile for create or set_control_profile."),
  worktreeTarget: z.string().min(1).optional().describe("Worktree name, ID, branch, or path for worktree_enter."),
  baseRef: z
    .enum(["current", "fresh"])
    .optional()
    .default("current")
    .describe("Base reference for worktree creation from worktree_enter."),
  baseRevision: z.string().min(1).optional().describe("Explicit git revision/ref/commit for worktree creation."),
  force: z.boolean().optional().default(false).describe("Force worktree switch/remove operations when supported."),
  cleanup: z
    .enum(["keep", "remove_if_clean"])
    .optional()
    .default("keep")
    .describe("Cleanup behavior for worktree_leave."),
  requestID: z
    .string()
    .optional()
    .describe(
      "ID of the pending question or permission request. Required for question_reply, question_reject, and permission_reply.",
    ),
  answers: z
    .array(z.array(z.string()))
    .optional()
    .describe(
      "Answers for question_reply. An array of arrays of selected labels — one array per question, each containing the label(s) selected.",
    ),
  reply: z
    .enum(["once", "reject"])
    .optional()
    .describe("Reply for permission_reply. 'once' approves this request; 'reject' denies it."),
  message: z.string().optional().describe("Optional feedback message when rejecting a permission request."),
})
type Parameters = z.infer<typeof parameters>

async function resolveSession(target: string): Promise<Session.Info> {
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  throw new Error(`Invalid session target: "${target}". Use a session ID (ses_xxx).`)
}

export const SessionControlTool = Tool.define("session_control", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    if (params.action === "create") {
      return handleCreate(params, ctx)
    }

    if (!params.target) {
      throw new Error(`target is required for ${params.action}`)
    }

    const session = await resolveSession(params.target)
    const sessionID = session.id

    if (params.action === "status") {
      return handleStatus(sessionID)
    }

    const inSession = <T>(fn: () => Promise<T>) => SessionManager.run(sessionID, fn)

    switch (params.action) {
      case "compact": {
        return inSession(() => handleCompact(sessionID))
      }
      case "abort": {
        return inSession(() => handleAbort(sessionID))
      }
      case "worktree_enter": {
        return inSession(() => handleWorktreeEnter(sessionID, params))
      }
      case "worktree_leave": {
        return inSession(() => handleWorktreeLeave(sessionID, params))
      }
      case "set_agent": {
        return handleSetAgent(sessionID, params)
      }
      case "set_model": {
        return handleSetModel(sessionID, params)
      }
      case "set_mode": {
        return handleSetMode(sessionID, params)
      }
      case "set_control_profile": {
        return handleSetControlProfile(sessionID, params)
      }
      case "question_reply": {
        if (!params.requestID) {
          throw new Error("requestID is required for question_reply")
        }
        if (!params.answers) {
          throw new Error("answers is required for question_reply")
        }
        return inSession(() => handleQuestionReply(params.requestID!, params.answers!))
      }
      case "question_reject": {
        if (!params.requestID) {
          throw new Error("requestID is required for question_reject")
        }
        return inSession(() => handleQuestionReject(params.requestID!))
      }
      case "permission_reply": {
        if (!params.requestID) {
          throw new Error("requestID is required for permission_reply")
        }
        if (!params.reply) {
          throw new Error("reply is required for permission_reply")
        }
        return inSession(() => handlePermissionReply(params.requestID!, params.reply!, params.message))
      }
    }
  },
})

async function handleStatus(sessionID: string) {
  const runtime = SessionManager.getRuntime(sessionID)
  const { Question } = await import("../question")
  const pendingQuestions = await Question.list()
  const sessionQuestions = pendingQuestions.filter((q) => q.sessionID === sessionID)
  const pendingPermissions = await PermissionNext.list()
  const sessionPermissions = pendingPermissions.filter((p) => p.sessionID === sessionID)
  const session = await Session.get(sessionID)

  const status = {
    sessionID,
    status: runtime?.status ?? { type: "idle" as const },
    interaction: session?.interaction ?? SessionInteraction.interactive(),
    controlProfile: await Session.resolveControlProfile(sessionID),
    agentOverride: session?.agentOverride,
    modelOverride: session?.modelOverride,
    workspace: session?.workspace,
    pendingQuestions: sessionQuestions.map((q) => ({
      id: q.id,
      questions: q.questions,
    })),
    pendingPermissions: sessionPermissions.map((p) => ({
      id: p.id,
      permission: p.permission,
      patterns: p.patterns,
      metadata: p.metadata,
    })),
  }

  const parts: string[] = []
  parts.push(`Session ${sessionID}: ${status.status.type}`)
  if (status.interaction.mode === "unattended") parts.push(`Mode: unattended (${status.interaction.source ?? ""})`)
  parts.push(`Control profile: ${status.controlProfile}`)
  if (status.agentOverride) parts.push(`Agent override: ${status.agentOverride}`)
  if (status.modelOverride)
    parts.push(`Model override: ${status.modelOverride.providerID}/${status.modelOverride.modelID}`)
  if (status.workspace) parts.push(`Workspace: ${status.workspace.type} at ${status.workspace.path}`)
  if (status.pendingQuestions.length > 0) {
    parts.push(`Pending questions: ${status.pendingQuestions.length}`)
    for (const q of status.pendingQuestions) {
      for (const question of q.questions) {
        const opts = question.options.map((o) => `"${o.label}" (${o.description})`).join(", ")
        parts.push(`  [${q.id}] ${question.header}: ${question.question}`)
        parts.push(`    Options: ${opts}`)
        if (question.multiple) parts.push("    (multiple selection allowed)")
      }
    }
  }
  if (status.pendingPermissions.length > 0) {
    parts.push(`Pending permissions: ${status.pendingPermissions.length}`)
    for (const p of status.pendingPermissions) {
      const toolInfo = p.metadata?.tool
      const toolLabel = toolInfo ? ` (tool: ${p.metadata?.toolName ?? "unknown"})` : ""
      parts.push(`  [${p.id}] ${p.permission} on ${p.patterns.join(", ")}${toolLabel}`)
    }
  }
  if (status.pendingQuestions.length === 0 && status.pendingPermissions.length === 0) {
    parts.push("No pending questions or permissions.")
  }

  return {
    title: `Status of ${sessionID}`,
    output: parts.join("\n"),
    metadata: { status } as Record<string, any>,
  }
}

async function requireAgent(name: string) {
  const agent = await Agent.get(name)
  if (!agent) {
    throw new Error(`Agent "${name}" not found`)
  }
  return agent
}

async function resolveCreateScope(params: Parameters): Promise<Scope> {
  if (params.scopeID) {
    const scope = await Scope.fromID(params.scopeID)
    if (!scope) throw new Error(`Scope "${params.scopeID}" not found`)
    return scope
  }
  if (params.directory) {
    return (await Scope.fromDirectory(params.directory)).scope
  }
  return ScopeContext.current.scope
}

function interactionFor(
  mode: SessionInteraction.Mode | undefined,
  source?: string,
): SessionInteraction.Info | undefined {
  if (!mode) return undefined
  return mode === "unattended"
    ? SessionInteraction.unattended(source ?? "session_control")
    : SessionInteraction.interactive(source ?? "session_control")
}

function modelLabel(model: { providerID: string; modelID: string } | undefined) {
  return model ? `${model.providerID}/${model.modelID}` : "default"
}

function sessionSummary(session: Session.Info) {
  return {
    id: session.id,
    title: session.title,
    scopeID: session.scope.id,
    workspace: session.workspace,
    interaction: session.interaction,
    controlProfile: session.controlProfile,
    agentOverride: session.agentOverride,
    modelOverride: session.modelOverride,
  }
}

async function handleCreate(params: Parameters, ctx: Tool.Context) {
  const agent = params.agent ? await requireAgent(params.agent) : undefined
  const scope = await resolveCreateScope(params)
  const interaction = interactionFor(params.mode, params.modeSource)
  let session = await Session.create({
    scope,
    title: params.title,
    controlProfile: params.controlProfile,
    agentOverride: agent?.name,
    interaction,
  })

  try {
    if (params.workspace) {
      session = await ScopeContext.provide({
        scope,
        fn: () => Session.applyWorkspaceSelection(session.id, params.workspace),
      })
    }

    if (params.model) {
      session = await Session.update(session.id, (draft) => {
        draft.modelOverride = params.model
      })
    }

    if (params.initialMessage?.trim()) {
      const messageID = Identifier.ascending("message")
      const textPart: MessageV2.TextPart = {
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "text",
        text: params.initialMessage,
      }
      await SessionManager.deliver({
        target: session.id,
        waitForProcessing: false,
        mail: {
          type: "user",
          parts: [textPart],
          agent: agent?.name,
          model: params.model,
          summary: params.title ? { title: params.title } : undefined,
          metadata: {
            source: "session_control",
            sourceSessionID: ctx.sessionID,
            sourceName: "session_control",
          },
        },
      })
      session = await Session.get(session.id)
    }
  } catch (error) {
    await Session.remove(session.id).catch(() => undefined)
    throw error
  }

  const lines = [`Created session ${session.id}: ${session.title}`]
  if (agent) lines.push(`Agent override: ${agent.name}`)
  if (params.model) lines.push(`Model override: ${modelLabel(params.model)}`)
  if (interaction) lines.push(`Mode: ${interaction.mode}`)
  if (params.workspace)
    lines.push(`Workspace: ${session.workspace?.type ?? "main"} at ${session.workspace?.path ?? scope.directory}`)
  if (params.initialMessage?.trim()) lines.push("Initial message queued for asynchronous processing.")

  return {
    title: `Created ${session.id}`,
    output: lines.join("\n"),
    metadata: {
      action: "create",
      session: sessionSummary(session),
      initialMessageQueued: Boolean(params.initialMessage?.trim()),
    } as Record<string, any>,
  }
}

async function handleCompact(sessionID: string) {
  const session = await Session.get(sessionID)
  if (!session) {
    throw new Error(`Session ${sessionID} not found`)
  }

  const msgs = await Session.messages({ sessionID })
  let currentAgent = await Agent.defaultAgent()
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role === "user") {
      currentAgent = info.agent || (await Agent.defaultAgent())
      break
    }
  }

  const lastUserModel = msgs
    .filter((m) => m.info.role === "user")
    .map((m) => m.info as MessageV2.User)
    .at(-1)?.model

  const model = lastUserModel ?? (await Agent.getAvailableModel(await Agent.get(currentAgent)))
  if (!model) {
    throw new Error(`No model available for compaction in session ${sessionID}`)
  }

  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    model,
    sessionID,
    agent: currentAgent,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "compaction",
    auto: false,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: "What did we do so far?",
  })

  SessionManager.scheduleWake(sessionID, "session_control.compact")

  return {
    title: `Compacted ${sessionID}`,
    output: `Compaction triggered for session ${sessionID}.`,
    metadata: { sessionID, action: "compact" } as Record<string, any>,
  }
}

async function handleAbort(sessionID: string) {
  SessionInvoke.cancel(sessionID)
  const { Cortex } = await import("../cortex")
  await Cortex.cancelAll(sessionID)
  return {
    title: `Aborted ${sessionID}`,
    output: `Session ${sessionID} has been aborted.`,
    metadata: { sessionID, action: "abort" } as Record<string, any>,
  }
}

async function handleSetAgent(sessionID: string, params: Parameters) {
  if (!params.agent) throw new Error("agent is required for set_agent")
  const agent = await requireAgent(params.agent)
  const updated = await Session.update(sessionID, (draft) => {
    draft.agentOverride = agent.name
  })
  return {
    title: `Updated agent for ${sessionID}`,
    output: `Session ${sessionID} will use agent "${agent.name}" for new user messages unless a message overrides it.`,
    metadata: { action: "set_agent", session: sessionSummary(updated), agent: agent.name } as Record<string, any>,
  }
}

async function handleSetModel(sessionID: string, params: Parameters) {
  if (!params.model) throw new Error("model is required for set_model")
  const updated = await Session.update(sessionID, (draft) => {
    draft.modelOverride = params.model
  })
  return {
    title: `Updated model for ${sessionID}`,
    output: `Session ${sessionID} model override set to ${modelLabel(params.model)}.`,
    metadata: { action: "set_model", session: sessionSummary(updated), model: params.model } as Record<string, any>,
  }
}

async function handleSetMode(sessionID: string, params: Parameters) {
  if (!params.mode) throw new Error("mode is required for set_mode")
  const interaction = interactionFor(params.mode, params.modeSource)!
  const updated = await Session.update(sessionID, (draft) => {
    draft.interaction = interaction
  })
  return {
    title: `Updated mode for ${sessionID}`,
    output: `Session ${sessionID} interaction mode set to ${interaction.mode}.`,
    metadata: { action: "set_mode", session: sessionSummary(updated), interaction } as Record<string, any>,
  }
}

async function handleSetControlProfile(sessionID: string, params: Parameters) {
  if (!params.controlProfile) throw new Error("controlProfile is required for set_control_profile")
  const updated = await Session.updateControlProfile(sessionID, params.controlProfile)
  return {
    title: `Updated control profile for ${sessionID}`,
    output: `Session ${sessionID} control profile set to ${params.controlProfile}.`,
    metadata: {
      action: "set_control_profile",
      session: sessionSummary(updated),
      controlProfile: params.controlProfile,
    } as Record<string, any>,
  }
}

function workspaceMetadata(info: Worktree.Info): Record<string, unknown> {
  return {
    type: "git_worktree" as const,
    path: info.path,
    scopeID: info.scopeID,
    worktreeID: info.id,
    name: info.name,
    branch: info.branch,
    baseRef: info.baseRef,
    baseRevision: info.baseRevision,
    resolvedBaseCommit: info.resolvedBaseCommit,
  }
}

function denied(action: string, reason: string, message: string) {
  return {
    title: action,
    output: message,
    metadata: { action: "denied", reason, message } as Record<string, any>,
  }
}

async function handleWorktreeEnter(sessionID: string, params: Parameters) {
  const currentWorkspace = ScopeContext.current.workspace
  if (currentWorkspace?.type === "git_worktree") {
    const current = currentWorkspace as Record<string, unknown>
    const currentName = String(current.name ?? current.worktreeID ?? current.path ?? "unknown")
    const currentPath = String(current.path)
    const currentID = typeof current.worktreeID === "string" ? current.worktreeID : undefined
    const currentBranch = typeof current.branch === "string" ? current.branch : undefined

    if (
      params.worktreeTarget &&
      (params.worktreeTarget === currentID ||
        params.worktreeTarget === currentName ||
        params.worktreeTarget === currentPath ||
        params.worktreeTarget === currentBranch)
    ) {
      return {
        title: "worktree_enter",
        output: `Session ${sessionID} is already in worktree "${currentName}" at ${currentPath}.`,
        metadata: {
          action: "worktree_enter",
          status: "already_current",
          created: false,
          workspace: currentWorkspace,
        } as Record<string, any>,
      }
    }

    const status = await Worktree.status(sessionID)
    if (status.dirty !== false && !params.force) {
      return denied(
        "worktree_enter",
        "current_dirty",
        `Current worktree "${currentName}" has uncommitted changes. Use force to switch without saving.`,
      )
    }

    await Worktree.leave(sessionID)
  }

  try {
    if (params.worktreeTarget) {
      const worktrees = await Worktree.list()
      const match = worktrees.find(
        (item) =>
          item.id === params.worktreeTarget ||
          item.name === params.worktreeTarget ||
          item.branch === params.worktreeTarget ||
          item.path === params.worktreeTarget,
      )
      if (match) {
        const entered = await Worktree.enter({
          sessionID,
          target: params.worktreeTarget,
          force: params.force,
        })
        return {
          title: "worktree_enter",
          output: `Session ${sessionID} entered existing worktree "${entered.name}" at ${entered.path}.`,
          metadata: {
            action: "worktree_enter",
            status: "entered",
            created: false,
            worktree: entered,
            workspace: workspaceMetadata(entered),
          } as Record<string, any>,
        }
      }
    }

    const created = await Worktree.create({
      sessionID,
      name: params.worktreeTarget,
      baseRef: params.baseRef,
      baseRevision: params.baseRevision,
      bind: true,
    })
    const baseLabel = params.baseRevision ?? `${params.baseRef} base`
    return {
      title: "worktree_enter",
      output: `Session ${sessionID} created and entered worktree "${created.name}" at ${created.path} from ${baseLabel}.`,
      metadata: {
        action: "worktree_enter",
        status: "entered",
        created: true,
        worktree: created,
        workspace: workspaceMetadata(created),
      } as Record<string, any>,
    }
  } catch (error) {
    if (error instanceof Worktree.NotGitError) {
      return denied(
        "worktree_enter",
        "not_git_scope",
        "Current scope is not a Git repository; git worktree is unavailable.",
      )
    }
    throw error
  }
}

async function handleWorktreeLeave(sessionID: string, params: Parameters) {
  const workspace = ScopeContext.current.workspace

  if (!workspace || workspace.type !== "git_worktree") {
    return {
      title: "worktree_leave",
      output: `Session ${sessionID} is already on the main checkout. No worktree to leave.`,
      metadata: {
        action: "worktree_leave",
        status: "noop",
        reason: "already_on_main",
      } as Record<string, any>,
    }
  }

  const worktreeID =
    typeof (workspace as any).worktreeID === "string" ? ((workspace as any).worktreeID as string) : undefined
  const worktreePath = workspace.path
  const worktreeName = typeof (workspace as any).name === "string" ? ((workspace as any).name as string) : undefined
  const previous = { type: workspace.type, path: worktreePath, name: worktreeName }

  let isClean: boolean | undefined
  if (params.cleanup === "remove_if_clean") {
    const status = await Worktree.status(sessionID)
    isClean = status.dirty === false
  }

  await Worktree.leave(sessionID)
  const restored = { type: "main", path: ScopeContext.current.scope.directory }
  let cleanup: { performed: boolean; skippedReason?: string } = { performed: false }
  if (params.cleanup === "remove_if_clean" && worktreeID) {
    if (isClean) {
      await Worktree.remove({ sessionID, target: worktreeID, force: false })
      cleanup = { performed: true }
    } else {
      cleanup = { performed: false, skippedReason: "dirty" }
    }
  }

  const lines = [
    `Session ${sessionID} left worktree "${worktreeName || worktreePath}" and returned to main checkout.`,
    `Previous: ${worktreePath}`,
    `Restored: ${restored.path}`,
  ]
  if (cleanup.performed) lines.push("Worktree removed (was clean).")
  if (cleanup.skippedReason === "dirty") lines.push("Worktree kept (has uncommitted changes).")

  return {
    title: "worktree_leave",
    output: lines.join("\n"),
    metadata: {
      action: "worktree_leave",
      status: "left",
      previous,
      restored,
      cleanup,
    } as Record<string, any>,
  }
}

async function handleQuestionReply(requestID: string, answers: string[][]) {
  const { Question } = await import("../question")
  await Question.reply({ requestID, answers })
  const formatted = answers.map((a) => a.join(", ")).join("; ")
  return {
    title: `Answered question ${requestID}`,
    output: `Question ${requestID} answered: ${formatted}`,
    metadata: { action: "question_reply", requestID, answers } as Record<string, any>,
  }
}

async function handleQuestionReject(requestID: string) {
  const { Question } = await import("../question")
  await Question.reject(requestID)
  return {
    title: `Rejected question ${requestID}`,
    output: `Question ${requestID} rejected.`,
    metadata: { action: "question_reject", requestID } as Record<string, any>,
  }
}

async function handlePermissionReply(requestID: string, reply: PermissionNext.Reply, message?: string) {
  await PermissionNext.reply({ requestID, reply, message })
  const desc = reply === "once" ? "approved" : "rejected"
  return {
    title: `${reply === "once" ? "Approved" : "Rejected"} permission ${requestID}`,
    output: `Permission ${requestID} ${desc}.${message ? ` Feedback: ${message}` : ""}`,
    metadata: { action: "permission_reply", requestID, reply, message } as Record<string, any>,
  }
}
