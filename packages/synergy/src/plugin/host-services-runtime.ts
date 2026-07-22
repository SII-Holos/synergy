import path from "path"
import fs from "fs/promises"
import Ajv2020 from "ajv/dist/2020"
import {
  PluginHostServiceErrorCode,
  type PluginAssetCreateInput,
  type PluginManifestType,
  type PluginTaskRunInput,
} from "@ericsanchezok/synergy-plugin"
import type { PluginHostServiceInvocationInput } from "../plugin-runtime/manager"
import { Attachment } from "../attachment"
import { Cortex } from "../cortex"
import { EnforcementError } from "../enforcement/errors"
import { EnforcementGate } from "../enforcement/gate"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { SandboxBackend } from "../sandbox/backend"
import { SkillPaths } from "../skill/paths"
import { Bus } from "../bus"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionInvoke } from "../session/invoke"
import { Agent } from "../agent/agent"
import { AgentCall } from "../agent/call"
import { isPathContained } from "../util/path-contain"
import { getPluginConfig, replacePluginConfig } from "./config-store"
import { createAuthStore } from "./store"
import { PluginEvent } from "./event"
import {
  cancelPluginBlueprint,
  cancelPluginTask,
  cancelLightLoop,
  getCurrentPluginTask,
  getLightLoop,
  getPluginBlueprint,
  getPluginTask,
  invokePluginTool,
  startLightLoop,
  startPluginBlueprint,
  startPluginTask,
} from "./host-services"

const capabilityByMethod = {
  "session.get": "session.read",
  "session.abort": "session.control",
  "task.start": "task.delegate",
  "task.run": "task.delegate",
  "task.current": "task.delegate",
  "task.get": "task.delegate",
  "task.cancel": "task.delegate",
  "blueprint.start": "blueprint.delegate",
  "blueprint.get": "blueprint.delegate",
  "blueprint.cancel": "blueprint.delegate",
  "lightloop.start": "lightloop.delegate",
  "lightloop.get": "lightloop.delegate",
  "lightloop.cancel": "lightloop.delegate",
  "workspace.read": "workspace.read",
  "workspace.write": "workspace.write",
  "workspace.metadata": "workspace.read",
  "settings.get": "settings.read",
  "settings.replace": "settings.write",
  "secrets.get": "secrets",
  "secrets.set": "secrets",
  "secrets.delete": "secrets",
  "tool.invoke": "tool.invoke",
  "agent.call": "agent.call",
  "asset.create": "asset.write",
  "shell.run": "shell.execute",
} as const

const AGENT_CALL_MAX_INPUT_CHARS = 32_000
const AGENT_CALL_MAX_OUTPUT_CHARS = 16_000
const AGENT_CALL_MAX_RUNTIME_MS = 120_000

function pluginHostServiceError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "PluginHostServiceError", code })
}

const validators = new Map<string, ReturnType<Ajv2020["compile"]>>()
const sequences = new Map<string, number>()

function assertCapability(input: PluginHostServiceInvocationInput) {
  if (input.method === "event.publish") return
  const required = capabilityByMethod[input.method]
  const granted = input.manifest.capabilities.some((capability) => capability.id === required)
  if (!granted) throw new Error(`Plugin ${input.pluginId} does not declare capability "${required}"`)
  if (required !== "agent.call") return
  const contribution = input.manifest.contributions.find((item) => `${item.kind}:${item.id}` === input.handlerId)
  if (!contribution?.requires?.includes(required)) {
    throw new Error(`Plugin contribution ${input.handlerId ?? "unknown"} does not declare capability "${required}"`)
  }
}

function params(input: PluginHostServiceInvocationInput): Record<string, unknown> {
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) return {}
  return input.params as Record<string, unknown>
}

function positiveConstraint(value: unknown, fallback: number, hardMaximum: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, hardMaximum)
}

async function callPluginAgent(input: PluginHostServiceInvocationInput, value: Record<string, unknown>) {
  const name = value.agent
  const text = value.text
  if (typeof name !== "string" || !name) throw new Error("agent.call requires agent")
  if (typeof text !== "string") throw new Error("agent.call requires text")
  const capability = input.manifest.capabilities.find((item) => item.id === "agent.call")
  const constraints = capability?.constraints ?? {}
  const maxInputChars = positiveConstraint(
    constraints.maxInputChars,
    AGENT_CALL_MAX_INPUT_CHARS,
    AGENT_CALL_MAX_INPUT_CHARS,
  )
  const maxOutputChars = positiveConstraint(
    constraints.maxOutputChars,
    AGENT_CALL_MAX_OUTPUT_CHARS,
    AGENT_CALL_MAX_OUTPUT_CHARS,
  )
  const requestedOutput = positiveConstraint(value.maxOutputChars, maxOutputChars, maxOutputChars)
  const maxRuntimeMs = positiveConstraint(
    constraints.maxRuntimeMs,
    AGENT_CALL_MAX_RUNTIME_MS,
    AGENT_CALL_MAX_RUNTIME_MS,
  )
  const timeoutMs = positiveConstraint(value.timeoutMs, maxRuntimeMs, maxRuntimeMs)
  const agent = await Agent.get(name)
  if (!agent) {
    throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_NOT_FOUND, `Plugin Agent is unavailable: ${name}`)
  }
  const owner = Agent.pluginOwner(agent)
  const owned =
    agent.hidden === true &&
    owner?.pluginId === input.pluginId &&
    owner.pluginGeneration === input.manifest.artifacts.generation
  const allowlist = Array.isArray(constraints.agents)
    ? constraints.agents.filter((item): item is string => typeof item === "string")
    : []
  if (!owned && !allowlist.includes(name)) {
    throw pluginHostServiceError(
      PluginHostServiceErrorCode.AGENT_NOT_OWNED,
      `Plugin is not approved to call Agent: ${name}`,
    )
  }
  try {
    return await AgentCall.text({
      agent: name,
      messages: [{ role: "user", content: text }],
      signal: input.signal,
      timeoutMs,
      retries: 1,
      maxInputChars,
      maxOutputChars: requestedOutput,
    })
  } catch (error) {
    if (!(error instanceof AgentCall.Error)) throw error
    if (error.code === "agent_not_found") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_NOT_FOUND, error.message)
    }
    if (error.code === "model_unavailable") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_MODEL_UNAVAILABLE, error.message)
    }
    if (error.code === "input_too_large") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_INPUT_TOO_LARGE, error.message)
    }
    if (error.code === "output_too_large") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_OUTPUT_TOO_LARGE, error.message)
    }
    if (error.code === "timeout") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_TIMEOUT, error.message)
    }
    if (error.code === "cancelled") {
      throw pluginHostServiceError(PluginHostServiceErrorCode.AGENT_CANCELLED, error.message)
    }
    throw error
  }
}

async function inScope<T>(input: PluginHostServiceInvocationInput, fn: () => Promise<T>): Promise<T> {
  const scope = await Scope.fromID(input.invocation.scopeId)
  if (!scope) throw new Error(`Plugin invocation scope not found: ${input.invocation.scopeId}`)
  return ScopeContext.provide({ scope, fn })
}

async function sessionInInvocationScope(input: PluginHostServiceInvocationInput, sessionId: string) {
  const session = await Session.get(sessionId)
  if (session.scope.id !== input.invocation.scopeId) {
    throw pluginHostServiceError(
      PluginHostServiceErrorCode.SESSION_SCOPE_MISMATCH,
      `Session ${sessionId} does not belong to the active Scope`,
    )
  }
  return session
}

function workspacePath(directory: string, requested: unknown): string {
  if (typeof requested !== "string" || !requested.trim()) throw new Error("Workspace path must be a non-empty string")
  const resolved = path.resolve(directory, requested)
  if (!isPathContained(directory, resolved)) throw new Error(`Workspace path escapes the active Scope: ${requested}`)
  return resolved
}

function eventContribution(manifest: PluginManifestType, eventId: string) {
  return manifest.contributions.find(
    (item): item is Extract<PluginManifestType["contributions"][number], { kind: "event" }> =>
      item.kind === "event" && item.id === eventId,
  )
}

function validateEvent(input: PluginHostServiceInvocationInput, eventId: string, payload: unknown) {
  const contribution = eventContribution(input.manifest, eventId)
  if (!contribution) throw new Error(`Plugin event is not declared: ${eventId}`)
  const key = `${input.pluginId}:${eventId}:${JSON.stringify(contribution.payload)}`
  let validate = validators.get(key)
  if (!validate) {
    validate = new Ajv2020({ allErrors: true, strict: false }).compile(contribution.payload)
    validators.set(key, validate)
  }
  if (!validate(payload)) {
    throw new Error(`Plugin event payload is invalid: ${new Ajv2020().errorsText(validate.errors)}`)
  }
}

async function publishEvent(input: PluginHostServiceInvocationInput) {
  const value = params(input)
  const eventId = value.eventId
  if (typeof eventId !== "string") throw new Error("event.publish requires eventId")
  validateEvent(input, eventId, value.payload)
  const sequenceKey = `${input.pluginId}:${input.manifest.artifacts.generation}:${input.invocation.scopeId}`
  const sequence = (sequences.get(sequenceKey) ?? 0) + 1
  sequences.set(sequenceKey, sequence)
  await Bus.publish(PluginEvent.Published, {
    pluginId: input.pluginId,
    pluginVersion: input.manifest.version,
    generation: input.manifest.artifacts.generation,
    eventId,
    scopeId: input.invocation.scopeId,
    sessionId: input.invocation.sessionId,
    sequence,
    timestamp: Date.now(),
    payload: value.payload,
  })
}

/**
 * Resolve the parent session and message for a start operation.
 *
 * Priority:
 *  1. Explicit request `parent` field,
 *  2. Agent actor invocation context (falls back to invocation session/message),
 *  3. Reject with TASK_PARENT_REQUIRED.
 *
 * On success validates the resolved parent Session exists and belongs to the
 * active invocation Scope (TASK_PARENT_SCOPE_MISMATCH).
 *
 * Returns a resolved RuntimeContext ready for the target service.
 */
async function resolveStartParent(
  input: PluginHostServiceInvocationInput,
  methodLabel: string,
  value: Record<string, unknown>,
) {
  const actor = input.invocation.actor
  const parentParam =
    value.parent && typeof value.parent === "object" ? (value.parent as Record<string, unknown>) : undefined
  const sessionID =
    typeof parentParam?.sessionId === "string"
      ? parentParam.sessionId
      : actor.type === "agent"
        ? input.invocation.sessionId
        : undefined
  const messageID =
    typeof parentParam?.messageId === "string"
      ? parentParam.messageId
      : actor.type === "agent"
        ? actor.messageId
        : undefined
  if (!sessionID || !messageID) {
    throw pluginHostServiceError(
      PluginHostServiceErrorCode.TASK_PARENT_REQUIRED,
      `${methodLabel} requires a parent Session and message`,
    )
  }
  const parentSession = await Session.get(sessionID)
  if (!parentSession || parentSession.scope.id !== input.invocation.scopeId) {
    throw pluginHostServiceError(
      PluginHostServiceErrorCode.TASK_PARENT_SCOPE_MISMATCH,
      `${methodLabel} parent Session does not belong to the active Scope`,
    )
  }
  return {
    pluginId: input.pluginId,
    pluginDir: input.pluginDir,
    sessionID,
    messageID,
    agent: actor.type === "agent" ? actor.agent : "synergy",
    callID: actor.type === "agent" ? actor.callId : undefined,
    directory: input.invocation.directory,
    abort: input.signal,
  }
}

const MAX_PLUGIN_ASSET_BYTES = 10 * 1024 * 1024

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Plugin invocation aborted", "AbortError")
}

async function runPluginTask(input: PluginHostServiceInvocationInput, value: Record<string, unknown>) {
  const request = {
    ...(value as PluginTaskRunInput),
    correlationId:
      typeof value.correlationId === "string" && value.correlationId.trim()
        ? value.correlationId.trim()
        : Identifier.ascending("cortex"),
  }
  const handle = await startPluginTask({
    pluginId: input.pluginId,
    pluginGeneration: input.manifest.artifacts.generation,
    scopeId: input.invocation.scopeId,
    pluginDir: input.pluginDir,
    context: await resolveStartParent(input, "task.run", value),
    request,
  })
  const active = Cortex.get(handle.taskId)
  const timeoutSeconds = Math.ceil(((active?.timeoutMs ?? request.timeoutMs ?? 120_000) + 5_000) / 1_000)
  const completed = Cortex.waitFor(handle.taskId, timeoutSeconds)
  const onAbort = () => {
    void cancelPluginTask({
      pluginId: input.pluginId,
      pluginGeneration: input.manifest.artifacts.generation,
      scopeId: input.invocation.scopeId,
      handle,
    }).catch(() => {})
  }
  if (input.signal.aborted) onAbort()
  else input.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await completed
  } finally {
    input.signal.removeEventListener("abort", onAbort)
  }
  if (input.signal.aborted) {
    await cancelPluginTask({
      pluginId: input.pluginId,
      pluginGeneration: input.manifest.artifacts.generation,
      scopeId: input.invocation.scopeId,
      handle,
    })
    throw abortError(input.signal)
  }
  return getPluginTask({
    pluginId: input.pluginId,
    pluginGeneration: input.manifest.artifacts.generation,
    scopeId: input.invocation.scopeId,
    handle,
  })
}

function decodePluginAsset(value: Record<string, unknown>): Uint8Array {
  if (value.data instanceof Uint8Array) {
    if (value.encoding !== undefined) {
      throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create encoding applies only to string data")
    }
    if (value.data.byteLength > MAX_PLUGIN_ASSET_BYTES) {
      throw pluginHostServiceError("PLUGIN_ASSET_TOO_LARGE", "asset.create exceeds the 10 MB size limit")
    }
    return value.data
  }
  if (typeof value.data !== "string") {
    throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create requires string or Uint8Array data")
  }
  const encoding = value.encoding ?? "utf8"
  if (encoding !== "utf8" && encoding !== "base64") {
    throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create encoding must be utf8 or base64")
  }
  if (encoding === "utf8") {
    const size = Buffer.byteLength(value.data, "utf8")
    if (size > MAX_PLUGIN_ASSET_BYTES) {
      throw pluginHostServiceError("PLUGIN_ASSET_TOO_LARGE", "asset.create exceeds the 10 MB size limit")
    }
    return Buffer.from(value.data, "utf8")
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create data is not valid base64")
  }
  const size =
    Math.floor((value.data.length * 3) / 4) - (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0)
  if (size > MAX_PLUGIN_ASSET_BYTES) {
    throw pluginHostServiceError("PLUGIN_ASSET_TOO_LARGE", "asset.create exceeds the 10 MB size limit")
  }
  const bytes = Buffer.from(value.data, "base64")
  if (bytes.toString("base64") !== value.data) {
    throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create data is not valid base64")
  }
  return bytes
}

async function createPluginAsset(input: PluginHostServiceInvocationInput, value: Record<string, unknown>) {
  const actor = input.invocation.actor
  if (actor.type !== "agent" || !input.invocation.sessionId) {
    throw new Error("asset.create requires an agent invocation context with Session identity")
  }
  await sessionInInvocationScope(input, input.invocation.sessionId)
  if (typeof value.mime !== "string" || !value.mime.trim()) {
    throw pluginHostServiceError("PLUGIN_ASSET_INPUT_INVALID", "asset.create requires mime")
  }
  input.signal.throwIfAborted()
  const bytes = decodePluginAsset(value)
  input.signal.throwIfAborted()
  const asset = value as PluginAssetCreateInput
  return Attachment.fromBytes({
    id: `part_${crypto.randomUUID()}`,
    bytes,
    mime: value.mime.trim(),
    filename: typeof asset.filename === "string" ? asset.filename : undefined,
    sessionID: input.invocation.sessionId,
    messageID: actor.messageId,
    presentation: asset.presentation,
    model: asset.model ?? { mode: "summary" },
    metadata: asset.metadata,
  })
}

function renderShellCommand(command: string[]) {
  return command.map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`).join(" ")
}

async function runPluginShell(input: PluginHostServiceInvocationInput, value: Record<string, unknown>) {
  const allowedKeys = new Set(["command", "timeoutMs"])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("shell.run accepts only command and timeoutMs")
  }
  if (
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    value.command.some((part) => typeof part !== "string")
  ) {
    throw new Error("shell.run requires a non-empty argv command")
  }
  const command = value.command as [string, ...string[]]
  if (!command[0]) throw new Error("shell.run requires a non-empty executable")
  const timeoutMs = value.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0) {
    throw new Error("shell.run timeoutMs must be a positive integer")
  }
  input.signal.throwIfAborted()
  const session = input.invocation.sessionId ? await Session.get(input.invocation.sessionId) : undefined
  const profileId = await Session.resolveEffectiveControlProfile({ sessionID: session?.id })
  const workspace = ScopeContext.current.workspace
  const trustedRoots = SkillPaths.runtimeSkillRootCandidatesSync(input.invocation.directory)
  const gate = await EnforcementGate.create({
    activeWorkspace: input.invocation.directory,
    workspaceType: workspace?.type === "git_worktree" ? "worktree" : "main",
    originalCheckout: (workspace as { originalCheckout?: string } | undefined)?.originalCheckout,
    profileId,
    readRoots: [Global.Path.root, ...trustedRoots],
    trustedRoots,
    synergyRoot: Global.Path.root,
  })
  const envelope = gate.evaluate("bash", { command: renderShellCommand(command), workdir: input.invocation.directory })
  if (envelope.decision === "deny") {
    throw new EnforcementError.PolicyDenied(
      envelope.refusal?.reason ?? `Profile "${profileId}" denies shell.run`,
      envelope.capabilities.map((capability) => capability.class),
      profileId,
    )
  }
  const sandbox = gate.getSandbox()
  const wrapper = SandboxBackend.prepareWrapper({
    command: command[0],
    args: command.slice(1),
    workspace: input.invocation.directory,
    sandboxMode: "none",
  })
  const executed = await SandboxBackend.executeAsync(wrapper, {
    cwd: input.invocation.directory,
    fallbackPolicy: sandbox.fallback,
    signal: input.signal,
    timeoutMs: Number(timeoutMs),
  })
  return { stdout: executed.stdout, stderr: executed.stderr, exitCode: executed.exitCode }
}

export async function executePluginHostService(input: PluginHostServiceInvocationInput): Promise<unknown> {
  assertCapability(input)
  return inScope(input, async () => {
    const value = params(input)
    if (input.method === "event.publish") return publishEvent(input)
    if (input.method === "agent.call") return callPluginAgent(input, value)
    if (input.method === "session.get") {
      const sessionId = value.sessionId
      if (typeof sessionId !== "string") throw new Error("session.get requires sessionId")
      return sessionInInvocationScope(input, sessionId)
    }
    if (input.method === "session.abort") {
      const sessionId = value.sessionId
      if (typeof sessionId !== "string") throw new Error("session.abort requires sessionId")
      await sessionInInvocationScope(input, sessionId)
      SessionInvoke.cancel(sessionId)
      return
    }
    if (input.method === "workspace.metadata") {
      return { scopeId: input.invocation.scopeId, directory: input.invocation.directory }
    }
    if (input.method === "workspace.read") {
      return Bun.file(workspacePath(input.invocation.directory, value.path)).text()
    }
    if (input.method === "workspace.write") {
      if (typeof value.content !== "string") throw new Error("workspace.write requires string content")
      const target = workspacePath(input.invocation.directory, value.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await Bun.write(target, value.content)
      return
    }
    if (input.method === "settings.get") return getPluginConfig(input.pluginId)
    if (input.method === "settings.replace") {
      return replacePluginConfig(input.pluginId, value.values, { manifest: input.manifest })
    }
    if (input.method.startsWith("secrets.")) {
      const key = value.key
      if (typeof key !== "string") throw new Error(`${input.method} requires key`)
      const store = createAuthStore(input.pluginId)
      if (input.method === "secrets.get") return store.get(key)
      if (input.method === "secrets.delete") return store.delete(key)
      if (typeof value.value !== "string") throw new Error("secrets.set requires string value")
      return store.set(key, value.value)
    }
    if (input.method === "shell.run") return runPluginShell(input, value)
    if (input.method === "asset.create") return createPluginAsset(input, value)
    if (input.method === "task.run") return runPluginTask(input, value)
    if (input.method === "task.current") {
      return getCurrentPluginTask({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        sessionId: input.invocation.sessionId,
      })
    }
    if (input.method === "task.get") {
      return getPluginTask({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        handle: value as never,
      })
    }
    if (input.method === "task.cancel") {
      return cancelPluginTask({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        handle: value as never,
      })
    }
    if (input.method === "blueprint.get") {
      const loopID = value.loopID
      if (typeof loopID !== "string") throw new Error("blueprint.get requires loopID")
      return getPluginBlueprint({
        scopeId: input.invocation.scopeId,
        loopID,
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
      })
    }
    if (input.method === "lightloop.get") {
      const sessionID = value.sessionID
      if (typeof sessionID !== "string") throw new Error("lightloop.get requires sessionID")
      return getLightLoop({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        sessionID,
      })
    }

    // --- start operations with resolved parent ---
    if (input.method === "lightloop.start") {
      return startLightLoop({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        pluginDir: input.pluginDir,
        context: await resolveStartParent(input, "lightloop.start", value),
        request: value as never,
      })
    }
    if (input.method === "blueprint.start") {
      return startPluginBlueprint({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        pluginDir: input.pluginDir,
        context: await resolveStartParent(input, "blueprint.start", value),
        request: value as never,
      })
    }
    if (input.method === "task.start") {
      return startPluginTask({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        pluginDir: input.pluginDir,
        context: await resolveStartParent(input, "task.start", value),
        request: value as never,
      })
    }

    // --- remaining operations that require agent context ---
    const actor = input.invocation.actor
    if (actor.type !== "agent" || !input.invocation.sessionId) {
      throw new Error(`${input.method} requires an agent invocation context`)
    }
    const runtimeContext = {
      pluginId: input.pluginId,
      pluginDir: input.pluginDir,
      sessionID: input.invocation.sessionId,
      messageID: actor.messageId,
      agent: actor.agent,
      callID: actor.callId,
      directory: input.invocation.directory,
      abort: input.signal,
    }
    if (input.method === "blueprint.cancel") {
      const loopID = value.loopID
      if (typeof loopID !== "string") throw new Error("blueprint.cancel requires loopID")
      return cancelPluginBlueprint({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        context: runtimeContext,
        loopID,
      })
    }
    if (input.method === "lightloop.cancel") {
      const sessionID = value.sessionID
      if (typeof sessionID !== "string") throw new Error("lightloop.cancel requires sessionID")
      return cancelLightLoop({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        context: runtimeContext,
        sessionID,
      })
    }
    if (input.method === "tool.invoke") {
      const toolId = value.toolId
      if (typeof toolId !== "string") throw new Error("tool.invoke requires toolId")
      return invokePluginTool({
        context: runtimeContext,
        pluginDir: input.pluginDir,
        request: { tool: toolId, args: value.input },
      })
    }
  })
}
