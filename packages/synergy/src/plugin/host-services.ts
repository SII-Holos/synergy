import type {
  ToolContext as PluginToolContext,
  ToolInvokeInput,
  ToolResult,
  ToolTaskRunInput,
  ToolTaskRunResult,
} from "@ericsanchezok/synergy-plugin/tool"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { ApprovalPolicy } from "@/control-profile/approval"
import { Cortex } from "@/cortex"
import type { CortexTypes } from "@/cortex/types"
import { EnforcementError } from "@/enforcement/errors"
import { PermissionNext } from "@/permission/next"
import { Provider } from "@/provider/provider"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionProcessor } from "@/session/processor"
import type { Tool } from "@/tool/tool"
import * as ManifestReader from "./manifest-reader"
import { resolveRuntimeLimits } from "../plugin-runtime/health"

type RuntimeContext = {
  sessionID: string
  messageID: string
  agent: string
  directory?: string
  callID?: string
  abort?: AbortSignal
}

export type PluginHostRuntimeContext = RuntimeContext

export function createPluginToolContext(input: {
  pluginId: string
  pluginDir: string
  context: Tool.Context
  directory: string
}): PluginToolContext {
  const runtimeContext: RuntimeContext = {
    sessionID: input.context.sessionID,
    messageID: input.context.messageID,
    agent: input.context.agent,
    callID: input.context.callID,
    directory: input.directory,
    abort: input.context.abort,
  }

  return {
    sessionID: input.context.sessionID,
    messageID: input.context.messageID,
    agent: input.context.agent,
    abort: input.context.abort,
    directory: input.directory,
    ask: (request) => input.context.ask({ ...request, metadata: request.metadata ?? {} }),
    task: {
      run: (request) =>
        runPluginTask({
          pluginId: input.pluginId,
          pluginDir: input.pluginDir,
          context: runtimeContext,
          request,
          ask: (permissionRequest) =>
            input.context.ask({ ...permissionRequest, metadata: permissionRequest.metadata ?? {} }),
        }),
    },
    tools: {
      invoke: (request) =>
        invokePluginTool({
          context: runtimeContext,
          request,
        }),
    },
  }
}

export async function runPluginTask(input: {
  pluginId: string
  pluginDir: string
  context: RuntimeContext
  request: ToolTaskRunInput
  ask?: (input: { permission: string; patterns: string[]; metadata?: Record<string, any> }) => Promise<void>
}): Promise<ToolTaskRunResult> {
  const request = normalizeTaskRunInput(input.request)
  const taskPermission = await assertTaskPermission(input.pluginDir, request)
  const agent = await Agent.get(request.subagent)
  if (!agent) throw new Error(`Unknown delegated subagent: ${request.subagent}`)
  if (input.context.agent && agent.visibleTo && !agent.visibleTo.includes(input.context.agent)) {
    throw new Error(`Agent "${request.subagent}" is not visible to "${input.context.agent}"`)
  }

  await askForTask(input.context, request, input.ask)

  const model = request.model ?? (await Agent.getAvailableModel(agent)) ?? (await parentModel(input.context))
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
  })

  const abort = input.context.abort
  const cancel = () => {
    void Cortex.cancel(task.id)
  }
  abort?.addEventListener("abort", cancel, { once: true })
  try {
    const timeoutMs =
      request.timeoutMs ??
      (typeof taskPermission === "object" ? taskPermission.maxRuntimeMs : undefined) ??
      (await defaultPluginRequestTimeoutMs())
    const completed = await Cortex.waitFor(task.id, Math.max(1, Math.ceil(timeoutMs / 1_000)))
    if (!completed || completed.status === "queued" || completed.status === "running") {
      await Cortex.cancel(task.id)
      return taskResult(task, "timeout", undefined, "Delegated task timed out")
    }
    return taskResult(completed, completed.status)
  } finally {
    abort?.removeEventListener("abort", cancel)
  }
}

export async function invokePluginTool(input: {
  context: RuntimeContext
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
    trackExecution: () => {},
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

  const timeoutMs = input.request.timeoutMs ?? (await defaultPluginRequestTimeoutMs())
  const signal = input.context.abort
    ? AbortSignal.any([input.context.abort, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  return resolved.execute(input.request.args ?? {}, {
    toolCallId: input.context.callID ? `${input.context.callID}:bridge:${toolName}` : `bridge:${toolName}`,
    abortSignal: signal,
  }) as Promise<ToolResult>
}

async function assertTaskPermission(pluginDir: string, request: ToolTaskRunInput) {
  const manifest = await ManifestReader.read(pluginDir)
  const task = manifest?.permissions?.tools?.task
  if (task === undefined) throw new Error("Plugin manifest does not declare permissions.tools.task")
  if (task === true) return
  if (task === false) throw new Error("Plugin manifest denies permissions.tools.task")
  if (task.agents && !task.agents.includes(request.subagent)) {
    throw new Error(`Plugin manifest does not allow task delegation to "${request.subagent}"`)
  }
  if (task.maxRuntimeMs && request.timeoutMs && request.timeoutMs > task.maxRuntimeMs) {
    throw new Error(`Delegated task timeout exceeds manifest maxRuntimeMs (${task.maxRuntimeMs}ms)`)
  }
  return task
}

async function askForTask(
  context: RuntimeContext,
  request: ToolTaskRunInput,
  ask?: (input: { permission: string; patterns: string[]; metadata?: Record<string, any> }) => Promise<void>,
) {
  const metadata = {
    description: request.description,
    subagent_type: request.subagent,
    source: "plugin",
  }
  if (ask) {
    await ask({ permission: "task", patterns: [request.subagent], metadata })
    return
  }
  await requestPluginPermission(context, { permission: "task", patterns: [request.subagent], metadata })
}

export async function requestPluginPermission(
  context: RuntimeContext,
  request: { permission: string; patterns: string[]; metadata?: Record<string, any> },
) {
  const agent = await Agent.get(context.agent)
  const session = await Session.get(context.sessionID)
  const topLevelProfile = await topLevelControlProfile()
  const sessionProfile = session?.id ? await Session.resolveControlProfile(session.id) : undefined
  const profileId = ControlProfileCompiler.normalize(sessionProfile ?? agent?.controlProfile ?? topLevelProfile)
  const workspaceInfo = ScopeContext.current.workspace
  const interaction = session?.interaction
  const profile = await ControlProfileCompiler.resolve(profileId, {
    workspace: context.directory ?? ScopeContext.current.directory,
    workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
    interactionMode: interaction?.mode === "unattended" ? "unattended" : "attended",
  })
  const metadata = {
    ...request.metadata,
    ...PermissionNext.requestMetadata(session),
  }
  const decision = ApprovalPolicy.decidePermission(profile.approval, request.permission, metadata)
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
    ruleset: PermissionNext.merge(agent?.permission ?? [], PermissionNext.sessionRuleset(session), [
      { permission: request.permission, pattern: "*", action: "ask" },
    ]),
    signal: context.abort,
  })
}

async function topLevelControlProfile(): Promise<string | undefined> {
  try {
    return (await Config.current()).controlProfile
  } catch {
    return undefined
  }
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

function normalizeTaskRunInput(input: ToolTaskRunInput): ToolTaskRunInput {
  if (!input.subagent?.trim()) throw new Error("task.run requires subagent")
  if (!input.description?.trim()) throw new Error("task.run requires description")
  if (!input.prompt?.trim()) throw new Error("task.run requires prompt")
  return {
    ...input,
    subagent: input.subagent.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    visibility: input.visibility ?? "visible",
  }
}

async function defaultPluginRequestTimeoutMs(): Promise<number> {
  const config = await Config.current().catch(() => undefined)
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits).requestTimeoutMs
}

function taskResult(
  task: CortexTypes.Task,
  status: ToolTaskRunResult["status"],
  output = task.result ?? "",
  error = task.error,
): ToolTaskRunResult {
  return {
    taskId: task.id,
    sessionId: task.sessionID,
    status,
    output,
    outputResult: task.outputResult as ToolTaskRunResult["outputResult"],
    error,
  }
}
