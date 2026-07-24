import type {
  BlueprintLoopInfo,
  BlueprintStartInput,
  LightLoopInfo,
  LightLoopStartInput,
  PluginTaskHandle,
  PluginTaskSnapshot,
  PluginTaskStartInput,
} from "@ericsanchezok/synergy-plugin"
import type { ToolInvokeInput, ToolResult } from "@ericsanchezok/synergy-plugin/tool"
import { Agent } from "@/agent/agent"
import { AgentDelegation } from "@/agent/delegation"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy } from "@/control-profile/approval"
import { Cortex } from "@/cortex"
import { EnforcementError } from "@/enforcement/errors"
import { PermissionNext } from "@/permission/next"
import { PermissionRules } from "@/permission/rules"
import { Provider } from "@/provider/provider"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { readPluginManifest } from "./spec-resolver"
import { PluginToolId } from "./ids"
import { baseCapabilities, toolCapabilities } from "./capability"
import { resolveRuntimeLimits } from "../plugin-runtime/health"
import { pluginTaskSnapshotFromSession, pluginTaskSnapshotFromTask } from "../cortex/plugin-task"
import { startBlueprint, getBlueprint, cancelBlueprint } from "../blueprint/plugin-adapter"
import { SessionWorkflowService } from "../session/workflow"
import { LightLoopRuntime } from "../session/light-loop-runtime"
import { LightLoopTerminalStore } from "../session/light-loop-terminal-hook"

type RuntimeContext = {
  pluginId?: string
  pluginDir?: string
  toolId?: string
  sessionID: string
  messageID: string
  agent: string
  directory?: string
  callID?: string
  abort?: AbortSignal
}

export type PluginHostRuntimeContext = RuntimeContext

export async function startPluginTask(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  pluginDir: string
  context: RuntimeContext
  request: PluginTaskStartInput
}): Promise<PluginTaskHandle> {
  const request = normalizeTaskStartInput(input.request)
  const taskPermission = await assertTaskPermission(input.pluginDir, request)
  const agent = await Agent.get(request.subagent)
  if (!agent) throw new Error(`Unknown delegated subagent: ${request.subagent}`)
  const caller = input.context.agent ? await Agent.get(input.context.agent) : undefined
  if (
    !canPluginStartAgent({
      agent,
      pluginOwner: Agent.pluginOwner(agent),
      caller: caller ?? input.context.agent,
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      declaredByPlugin: taskPermission.declaredByPlugin,
    })
  ) {
    const reason = taskPermission.declaredByPlugin
      ? "is not registered to the invoking plugin generation"
      : `is not delegatable by "${input.context.agent}"`
    throw new Error(`Agent "${request.subagent}" ${reason}`)
  }

  await askForTask(input.context, request)

  const model = request.model ?? (await Agent.getAvailableModel(agent)) ?? (await parentModel(input.context))
  const limits = await defaultPluginRuntimeLimits(input.pluginDir)
  const timeoutMs = request.timeoutMs ?? taskPermission.maxRuntimeMs ?? limits.taskRunTimeoutMs
  const task = await Cortex.launch({
    description: request.description,
    prompt: request.prompt,
    agent: request.subagent,
    executionRole: "delegated_subagent",
    category: request.category,
    parentSessionID: input.context.sessionID,
    parentMessageID: input.context.messageID,
    model,
    tools: request.tools,
    visibility: request.visibility,
    output: request.output,
    notifyParentOnComplete: request.visibility === "hidden" ? false : undefined,
    timeoutMs,
    owner: {
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      scopeId: input.scopeId,
      correlationId: request.correlationId,
    },
  })
  return { taskId: task.id, sessionId: task.sessionID }
}

export function canPluginStartAgent(input: {
  agent: Pick<Agent.Info, "name" | "mode" | "hidden" | "visibleTo">
  pluginOwner?: Agent.PluginOwner
  caller?: { name: string; delegationGroups?: string[] } | string
  pluginId: string
  pluginGeneration: string
  declaredByPlugin: boolean
}): boolean {
  if (!input.declaredByPlugin) return AgentDelegation.canDelegateTo(input.agent, input.caller)
  const owner = input.pluginOwner
  if (!owner || owner.pluginId !== input.pluginId || owner.pluginGeneration !== input.pluginGeneration) {
    return false
  }
  return AgentDelegation.canProgrammaticallyDelegateTo(input.agent, input.caller)
}

export async function getPluginTask(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  handle: PluginTaskHandle
}): Promise<PluginTaskSnapshot> {
  const active = Cortex.get(input.handle.taskId)
  if (active) {
    assertPluginTaskOwner(active.owner, input.pluginId, input.pluginGeneration, input.scopeId)
    if (active.sessionID !== input.handle.sessionId)
      throw new Error("Plugin task handle session does not match Cortex task")
    return pluginTaskSnapshotFromTask(active)!
  }

  const session = await Session.get(input.handle.sessionId)
  const delegated = session?.cortex
  if (!delegated || delegated.taskID !== input.handle.taskId) throw new Error("Plugin task not found")
  assertPluginTaskOwner(delegated.owner, input.pluginId, input.pluginGeneration, input.scopeId)
  return pluginTaskSnapshotFromSession(input.handle, delegated)!
}

export async function getCurrentPluginTask(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  sessionId?: string
}): Promise<PluginTaskSnapshot | undefined> {
  if (!input.sessionId) return undefined
  const session = await Session.get(input.sessionId)
  const delegated = session?.cortex
  if (!delegated?.owner || !samePluginTaskOwner(delegated.owner, input)) return undefined
  return getPluginTask({
    pluginId: input.pluginId,
    pluginGeneration: input.pluginGeneration,
    scopeId: input.scopeId,
    handle: { taskId: delegated.taskID, sessionId: input.sessionId },
  })
}

export async function cancelPluginTask(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  handle: PluginTaskHandle
}): Promise<void> {
  const snapshot = await getPluginTask(input)
  if (snapshot.status !== "queued" && snapshot.status !== "running") return
  await Cortex.cancel(input.handle.taskId)
}

function assertPluginTaskOwner(
  owner: { pluginId: string; pluginGeneration: string; scopeId: string } | undefined,
  pluginId: string,
  pluginGeneration: string,
  scopeId: string,
): void {
  if (!owner || !samePluginTaskOwner(owner, { pluginId, pluginGeneration, scopeId })) {
    throw new Error("Plugin task does not belong to the invoking plugin generation and Scope")
  }
}

function samePluginTaskOwner(
  owner: { pluginId: string; pluginGeneration: string; scopeId: string },
  expected: { pluginId: string; pluginGeneration: string; scopeId: string },
): boolean {
  return (
    owner.pluginId === expected.pluginId &&
    owner.pluginGeneration === expected.pluginGeneration &&
    owner.scopeId === expected.scopeId
  )
}

export async function invokePluginTool(input: {
  context: RuntimeContext
  pluginDir?: string
  request: ToolInvokeInput
}): Promise<ToolResult> {
  const toolName = input.request.tool
  if (!toolName || typeof toolName !== "string") throw new Error("tools.invoke requires a tool name")

  const { ToolResolver } = await import("@/session/tool-resolver")
  const agent = await Agent.get(input.context.agent)
  if (!agent) throw new Error(`Unknown agent: ${input.context.agent}`)
  const session = await Session.get(input.context.sessionID)
  const selected = await parentModel(input.context)
  const model = await Provider.getModel(selected.providerID, selected.modelID)

  const processor = {
    message: { id: input.context.messageID },
    partFromToolCall: () => undefined,
    beginExecution: (callID: string) => SessionProcessor.createSlot(callID),
  } as unknown as SessionProcessor.Info

  const tools = await ToolResolver.resolve({
    agent,
    model,
    sessionID: input.context.sessionID,
    processor,
    session,
    includeMCP: true,
    userTools: { [toolName]: true },
  })
  const resolved = tools[toolName] as any
  if (!resolved?.execute) throw new Error(`Tool "${toolName}" is not available to this plugin context`)

  const timeoutMs = input.request.timeoutMs ?? (await defaultPluginToolInvocationTimeoutMs(input.pluginDir))
  const signal = input.context.abort
    ? AbortSignal.any([input.context.abort, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  return resolved.execute(input.request.args ?? {}, {
    toolCallId: input.context.callID ? `${input.context.callID}:host-service:${toolName}` : `host-service:${toolName}`,
    abortSignal: signal,
  }) as Promise<ToolResult>
}

function normalizePluginToolId(toolId: string | undefined): string | undefined {
  if (!toolId) return undefined
  if (!PluginToolId.is(toolId)) return toolId
  return PluginToolId.parse(toolId)?.toolId ?? toolId
}
/**
 * Protocol 5 Blueprint atomic start — full validation, note/session/loop creation, rollback on failure.
 */
export async function startPluginBlueprint(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  pluginDir?: string
  context: RuntimeContext
  request: BlueprintStartInput
}): Promise<BlueprintLoopInfo> {
  await requestPluginPermission(input.context, {
    capability: "blueprint.delegate",
    permission: "task",
    patterns: [input.request.executionAgent, input.request.auditAgent],
    metadata: { capability: "blueprint.delegate", source: "plugin" },
  })
  return startBlueprint({
    context: {
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      scopeId: input.scopeId,
      pluginDir: input.pluginDir,
      parentSessionID: input.context.sessionID,
      parentMessageID: input.context.messageID,
    },
    request: input.request,
  })
}

export async function getPluginBlueprint(input: {
  scopeId: string
  loopID: string
  pluginId: string
  pluginGeneration: string
}): Promise<BlueprintLoopInfo> {
  return getBlueprint(input)
}

export async function cancelPluginBlueprint(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  context: RuntimeContext
  loopID: string
}): Promise<BlueprintLoopInfo> {
  await requestPluginPermission(input.context, {
    capability: "blueprint.delegate",
    permission: "task",
    patterns: [input.loopID],
    metadata: { capability: "blueprint.delegate", source: "plugin", loopID: input.loopID },
  })
  return cancelBlueprint(input)
}

async function assertLightLoopDelegation(
  input: {
    pluginId: string
    pluginGeneration: string
    pluginDir: string
    executionAgent: string
    reviewAgent: string
  },
  manifestCapability: string,
) {
  const execAgent = await Agent.get(input.executionAgent)
  if (!execAgent) throw new Error(`Unknown execution agent: ${input.executionAgent}`)
  if (execAgent.mode === "primary") throw new Error(`Execution agent "${input.executionAgent}" is a primary agent`)
  if (!execAgent.hidden) throw new Error(`Execution agent "${input.executionAgent}" is not hidden`)

  const reviewAgent = await Agent.get(input.reviewAgent)
  if (!reviewAgent) throw new Error(`Unknown review agent: ${input.reviewAgent}`)
  if (reviewAgent.mode === "primary") throw new Error(`Review agent "${input.reviewAgent}" is a primary agent`)
  if (!reviewAgent.hidden) throw new Error(`Review agent "${input.reviewAgent}" is not hidden`)

  if (input.executionAgent === input.reviewAgent) throw new Error("Execution and review agents must differ")

  const manifest = await readPluginManifest(input.pluginDir)
  const cap = manifest.capabilities.find((c) => c.id === manifestCapability)
  if (!cap) throw new Error(`Plugin manifest does not declare capability ${manifestCapability}`)

  const agents = Array.isArray(cap.constraints?.agents) ? cap.constraints.agents : undefined
  if (agents) {
    if (!agents.includes(input.executionAgent))
      throw new Error(`Plugin manifest does not allow LightLoop execution agent "${input.executionAgent}"`)
    if (!agents.includes(input.reviewAgent))
      throw new Error(`Plugin manifest does not allow LightLoop review agent "${input.reviewAgent}"`)
  }

  const execOwner = Agent.pluginOwner(execAgent)
  if (!execOwner || execOwner.pluginId !== input.pluginId || execOwner.pluginGeneration !== input.pluginGeneration) {
    throw new Error(`Execution agent "${input.executionAgent}" is not owned by this plugin generation`)
  }
  const reviewOwner = Agent.pluginOwner(reviewAgent)
  if (
    !reviewOwner ||
    reviewOwner.pluginId !== input.pluginId ||
    reviewOwner.pluginGeneration !== input.pluginGeneration
  ) {
    throw new Error(`Review agent "${input.reviewAgent}" is not owned by this plugin generation`)
  }
}

export async function startLightLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  pluginDir: string
  context: RuntimeContext
  request: LightLoopStartInput
}): Promise<LightLoopInfo> {
  const request = input.request

  if (!request.instructions?.trim()) throw new Error("lightloop.start requires instructions")
  if (!request.correlationId?.trim()) throw new Error("lightloop.start requires correlationId")
  if (!request.executionAgent?.trim()) throw new Error("lightloop.start requires executionAgent")
  if (!request.reviewAgent?.trim()) throw new Error("lightloop.start requires reviewAgent")
  if (!request.budget) throw new Error("lightloop.start requires budget")
  if (!Number.isFinite(request.budget.maxRuntimeMs) || request.budget.maxRuntimeMs <= 0)
    throw new Error("budget.maxRuntimeMs must be a positive integer")
  if (!Number.isFinite(request.budget.maxIterations) || request.budget.maxIterations <= 0)
    throw new Error("budget.maxIterations must be a positive integer")

  await assertLightLoopDelegation(
    {
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      pluginDir: input.pluginDir,
      executionAgent: request.executionAgent.trim(),
      reviewAgent: request.reviewAgent.trim(),
    },
    "lightloop.delegate",
  )

  await requestPluginPermission(input.context, {
    capability: "lightloop.delegate",
    permission: "task",
    patterns: [request.executionAgent, request.reviewAgent],
    metadata: { capability: "lightloop.delegate", source: "plugin" },
  })

  const execAgent = (await Agent.get(request.executionAgent.trim()))!
  const model = request.model ?? (await Agent.getAvailableModel(execAgent)) ?? (await parentModel(input.context))
  const limits = await defaultPluginRuntimeLimits(input.pluginDir)
  const timeoutMs = request.budget.maxRuntimeMs

  const task = await Cortex.prepare({
    description: `[LightLoop] ${request.instructions.slice(0, 80)}`,
    prompt: request.instructions.trim(),
    agent: request.executionAgent.trim(),
    executionRole: "delegated_subagent",
    category: "general",
    parentSessionID: input.context.sessionID,
    parentMessageID: input.context.messageID,
    model,
    tools: request.executionTools,
    visibility: "hidden",
    notifyParentOnComplete: false,
    timeoutMs,
    owner: {
      pluginId: input.pluginId,
      pluginGeneration: input.pluginGeneration,
      scopeId: input.scopeId,
      correlationId: request.correlationId.trim(),
    },
  })

  try {
    const deadlineAt = Date.now() + timeoutMs
    await SessionWorkflowService.startLightloop(task.sessionID, request.instructions.trim())
    await Session.update(task.sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") return
      draft.workflow = {
        ...draft.workflow,
        status: "running",
        executionAgent: request.executionAgent.trim(),
        reviewAgent: request.reviewAgent.trim(),
        ...(request.reviewTools ? { reviewTools: request.reviewTools } : {}),
        pluginOwner: {
          pluginId: input.pluginId,
          pluginGeneration: input.pluginGeneration,
          scopeId: input.scopeId,
          correlationId: request.correlationId.trim(),
        },
        budget: request.budget,
        deadlineAt,
      }
    })

    await Cortex.start(task.id)
    LightLoopRuntime.scheduleDeadline(task.sessionID, deadlineAt)

    return {
      sessionID: task.sessionID,
      status: "running",
      instructions: request.instructions.trim(),
    }
  } catch (error) {
    await Cortex.cancel(task.id).catch(() => {})
    await Session.update(task.sessionID, (draft) => {
      draft.workflow = undefined
      draft.time.archived = Date.now()
    }).catch(() => {})
    throw error
  }
}

export async function getLightLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  sessionID: string
}): Promise<LightLoopInfo> {
  const session = await Session.get(input.sessionID)
  if (!session) throw new Error(`LightLoop session not found: ${input.sessionID}`)

  const terminal = await LightLoopTerminalStore.get(session)
  const workflow = session.workflow?.kind === "lightloop" ? session.workflow : undefined
  const owner = workflow?.pluginOwner ?? terminal?.pluginOwner
  if (!owner) throw new Error(`Session ${input.sessionID} is not a plugin-owned LightLoop`)
  if (
    owner.pluginId !== input.pluginId ||
    owner.pluginGeneration !== input.pluginGeneration ||
    owner.scopeId !== input.scopeId
  ) {
    throw new Error(`LightLoop not found`)
  }

  if (terminal) {
    return {
      sessionID: input.sessionID,
      status: terminal.status,
      instructions: terminal.instructions,
      ...(terminal.error ? { error: terminal.error } : {}),
    }
  }
  if (!workflow) throw new Error(`Session ${input.sessionID} is not a LightLoop`)

  return {
    sessionID: input.sessionID,
    status: workflow.stopRequest?.reviewSessionID ? "reviewing" : "running",
    instructions: workflow.instructions,
  }
}

export async function cancelLightLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  context: RuntimeContext
  sessionID: string
}): Promise<LightLoopInfo> {
  const session = await Session.get(input.sessionID)
  if (!session) throw new Error(`LightLoop session not found: ${input.sessionID}`)
  const terminal = await LightLoopTerminalStore.get(session)
  if (terminal) {
    if (
      terminal.pluginOwner.pluginId !== input.pluginId ||
      terminal.pluginOwner.pluginGeneration !== input.pluginGeneration ||
      terminal.pluginOwner.scopeId !== input.scopeId
    ) {
      throw new Error(`LightLoop not found`)
    }
    return {
      sessionID: input.sessionID,
      status: terminal.status,
      instructions: terminal.instructions,
      ...(terminal.error ? { error: terminal.error } : {}),
    }
  }
  if (session.workflow?.kind !== "lightloop") throw new Error(`Session ${input.sessionID} is not a LightLoop`)

  const owner = session.workflow.pluginOwner
  if (!owner) throw new Error(`LightLoop ${input.sessionID} is not plugin-owned`)
  if (
    owner.pluginId !== input.pluginId ||
    owner.pluginGeneration !== input.pluginGeneration ||
    owner.scopeId !== input.scopeId
  ) {
    throw new Error(`LightLoop not found`)
  }

  // Cancel the execution session
  const { Cortex: CortexModule } = await import("@/cortex")
  const delegated = session.cortex
  if (delegated) {
    await CortexModule.cancel(delegated.taskID).catch(() => {})
  }

  // Cancel any pending review session
  if (session.workflow.stopRequest?.reviewSessionID) {
    const reviewSession = await Session.get(session.workflow.stopRequest.reviewSessionID).catch(() => undefined)
    if (reviewSession?.cortex) {
      await CortexModule.cancel(reviewSession.cortex.taskID).catch(() => {})
    }
  }

  await LightLoopRuntime.setTerminalStatus(input.sessionID, "cancelled")
  const result = await LightLoopTerminalStore.get(session)
  if (!result) throw new Error(`LightLoop ${input.sessionID} did not persist its terminal result`)
  return {
    sessionID: input.sessionID,
    status: result.status,
    instructions: result.instructions,
    ...(result.error ? { error: result.error } : {}),
  }
}

export async function assertPluginManifestCapability(input: {
  pluginDir?: string
  toolId?: string
  capability: string
}) {
  if (!input.pluginDir) return
  const manifest = await readPluginManifest(input.pluginDir)
  const shortToolId = normalizePluginToolId(input.toolId)
  const declaredCapabilities = shortToolId ? toolCapabilities(manifest, shortToolId) : baseCapabilities(manifest)

  if (declaredCapabilities.includes(input.capability)) return

  const scope = shortToolId ? `tool "${shortToolId}"` : "plugin"
  throw new Error(`Plugin manifest does not allow capability "${input.capability}" for ${scope}`)
}

async function assertTaskPermission(pluginDir: string, request: PluginTaskStartInput) {
  const manifest = await readPluginManifest(pluginDir)
  const task = manifest.capabilities.find((item) => item.id === "task.delegate")
  if (!task) throw new Error("Plugin manifest does not declare capability task.delegate")
  const agents = Array.isArray(task.constraints?.agents) ? task.constraints.agents : undefined
  const maxRuntimeMs = typeof task.constraints?.maxRuntimeMs === "number" ? task.constraints.maxRuntimeMs : undefined
  if (agents && !agents.includes(request.subagent)) {
    throw new Error(`Plugin manifest does not allow task delegation to "${request.subagent}"`)
  }
  if (maxRuntimeMs && request.timeoutMs && request.timeoutMs > maxRuntimeMs) {
    throw new Error(`Delegated task timeout exceeds manifest maxRuntimeMs (${maxRuntimeMs}ms)`)
  }
  const declaredByPlugin = manifest.contributions.some(
    (contribution) => contribution.kind === "agent" && contribution.id === request.subagent,
  )
  return { maxRuntimeMs, declaredByPlugin }
}

async function askForTask(context: RuntimeContext, request: PluginTaskStartInput) {
  const metadata = {
    description: request.description,
    subagent_type: request.subagent,
    source: "plugin",
  }
  await requestPluginPermission(context, {
    capability: "task.delegate",
    permission: "task",
    patterns: [request.subagent],
    metadata,
  })
}

export async function requestPluginPermission(
  context: RuntimeContext,
  request: { capability: string; permission: string; patterns: string[]; metadata?: Record<string, any> },
) {
  await assertPluginManifestCapability({
    pluginDir: context.pluginDir,
    toolId: context.toolId,
    capability: request.capability,
  })

  const agent = await Agent.get(context.agent)
  const session = await Session.get(context.sessionID)
  const profileId = await Session.resolveEffectiveControlProfile({
    sessionID: session?.id,
    agentControlProfile: agent?.controlProfile,
  })
  const workspaceInfo = ScopeContext.current.workspace
  const profile = await ControlProfileCompiler.resolve(profileId, {
    workspace: context.directory ?? ScopeContext.current.directory,
    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
  })
  const metadata = request.metadata ?? {}
  const decision = ApprovalPolicy.decidePermission(profile, request.permission, metadata)
  if (decision.action === "deny") {
    throw new EnforcementError.PolicyDenied(
      decision.reason,
      decision.capabilities,
      profile.summary?.profileId ?? profileId,
    )
  }
  if (decision.action === "allow") return

  await PermissionNext.ask({
    sessionID: context.sessionID,
    permission: request.permission,
    patterns: request.patterns,
    metadata,
    tool: context.callID ? { messageID: context.messageID, callID: context.callID } : undefined,
    ruleset: PermissionNext.merge(
      agent?.permission ?? [],
      await PermissionRules.userRuleset(),
      PermissionNext.sessionRuleset(session),
    ),
    signal: context.abort,
  })
}

async function parentModel(context: RuntimeContext) {
  try {
    const msg = await MessageV2.get({
      scopeID: ScopeContext.current.scope.id,
      sessionID: context.sessionID,
      messageID: context.messageID,
    })
    if (msg.info.role === "assistant" && msg.info.modelID && msg.info.providerID) {
      return { providerID: msg.info.providerID, modelID: msg.info.modelID }
    }
  } catch {}
  return Provider.defaultModel()
}

function normalizeTaskStartInput(input: PluginTaskStartInput): PluginTaskStartInput {
  if (!input.subagent?.trim()) throw new Error("task.start requires subagent")
  if (!input.description?.trim()) throw new Error("task.start requires description")
  if (!input.prompt?.trim()) throw new Error("task.start requires prompt")
  if (!input.correlationId?.trim()) throw new Error("task.start requires correlationId")
  return {
    ...input,
    subagent: input.subagent.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    correlationId: input.correlationId.trim(),
    visibility: input.visibility ?? "visible",
  }
}

async function defaultPluginToolInvocationTimeoutMs(pluginDir?: string): Promise<number> {
  return (await defaultPluginRuntimeLimits(pluginDir)).toolInvocationTimeoutMs
}

async function defaultPluginRuntimeLimits(pluginDir?: string) {
  const config = await Config.current().catch(() => undefined)
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits)
}
