import type { PluginTaskHandle, PluginTaskSnapshot, PluginTaskStartInput } from "@ericsanchezok/synergy-plugin"
import type { ToolInvokeInput, ToolResult } from "@ericsanchezok/synergy-plugin/tool"
import { Agent } from "@/agent/agent"
import { AgentDelegation } from "@/agent/delegation"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy } from "@/control-profile/approval"
import { Cortex } from "@/cortex"
import { EnforcementError } from "@/enforcement/errors"
import { PermissionNext } from "@/permission/next"
import { Provider } from "@/provider/provider"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { permissionCapability } from "@ericsanchezok/synergy-util/capability"
import { readPluginManifest } from "./spec-resolver"
import { PluginToolId } from "./ids"
import { baseCapabilities, toolCapabilities } from "./capability"
import { resolveRuntimeLimits } from "../plugin-runtime/health"
import { pluginTaskSnapshotFromSession, pluginTaskSnapshotFromTask } from "../cortex/plugin-task"

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
  if (
    !owner ||
    owner.pluginId !== pluginId ||
    owner.pluginGeneration !== pluginGeneration ||
    owner.scopeId !== scopeId
  ) {
    throw new Error("Plugin task does not belong to the invoking plugin generation and Scope")
  }
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

export async function assertPluginManifestCapability(input: {
  pluginDir?: string
  toolId?: string
  permission: string
}) {
  if (!input.pluginDir) return
  const manifest = await readPluginManifest(input.pluginDir)
  const capability = permissionCapability(input.permission)
  const shortToolId = normalizePluginToolId(input.toolId)
  const declaredCapabilities = shortToolId ? toolCapabilities(manifest, shortToolId) : baseCapabilities(manifest)

  if (declaredCapabilities.includes(capability)) return

  const scope = shortToolId ? `tool "${shortToolId}"` : "plugin"
  throw new Error(`Plugin manifest does not allow capability "${capability}" for ${scope}`)
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
  await requestPluginPermission(context, { permission: "task", patterns: [request.subagent], metadata })
}

export async function requestPluginPermission(
  context: RuntimeContext,
  request: { permission: string; patterns: string[]; metadata?: Record<string, any> },
) {
  await assertPluginManifestCapability({
    pluginDir: context.pluginDir,
    toolId: context.toolId,
    permission: request.permission,
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
    ruleset: PermissionNext.merge(agent?.permission ?? [], PermissionNext.sessionRuleset(session)),
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
