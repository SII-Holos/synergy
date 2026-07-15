import path from "path"
import fs from "fs/promises"
import Ajv2020 from "ajv/dist/2020"
import { PluginHostServiceErrorCode, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import type { PluginHostServiceInvocationInput } from "../plugin-runtime/manager"
import { Bus } from "../bus"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionInvoke } from "../session/invoke"
import { isPathContained } from "../util/path-contain"
import { getPluginConfig, replacePluginConfig } from "./config-store"
import { createAuthStore } from "./store"
import { PluginEvent } from "./event"
import {
  cancelPluginBlueprint,
  cancelPluginTask,
  createPluginBlueprint,
  enablePluginLightLoop,
  getCurrentPluginTask,
  getPluginBlueprint,
  getPluginTask,
  invokePluginTool,
  listPluginBlueprints,
  startPluginBlueprint,
  startPluginTask,
} from "./host-services"

const capabilityByMethod = {
  "session.get": "session.read",
  "session.abort": "session.control",
  "task.start": "task.delegate",
  "task.current": "task.delegate",
  "task.get": "task.delegate",
  "task.cancel": "task.delegate",
  "blueprint.create": "blueprint.delegate",
  "blueprint.start": "blueprint.delegate",
  "blueprint.get": "blueprint.delegate",
  "blueprint.list": "blueprint.delegate",
  "blueprint.cancel": "blueprint.delegate",
  "lightloop.enable": "lightloop.delegate",
  "workspace.read": "workspace.read",
  "workspace.write": "workspace.write",
  "workspace.metadata": "workspace.read",
  "settings.get": "settings.read",
  "settings.replace": "settings.write",
  "secrets.get": "secrets",
  "secrets.set": "secrets",
  "secrets.delete": "secrets",
  "tool.invoke": "tool.invoke",
} as const

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
}

function params(input: PluginHostServiceInvocationInput): Record<string, unknown> {
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) return {}
  return input.params as Record<string, unknown>
}

async function inScope<T>(input: PluginHostServiceInvocationInput, fn: () => Promise<T>): Promise<T> {
  const scope = await Scope.fromID(input.invocation.scopeId)
  if (!scope) throw new Error(`Plugin invocation scope not found: ${input.invocation.scopeId}`)
  return ScopeContext.provide({ scope, fn })
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

export async function executePluginHostService(input: PluginHostServiceInvocationInput): Promise<unknown> {
  assertCapability(input)
  return inScope(input, async () => {
    const value = params(input)
    if (input.method === "event.publish") return publishEvent(input)
    if (input.method === "session.get") {
      const sessionId = value.sessionId
      if (typeof sessionId !== "string") throw new Error("session.get requires sessionId")
      return Session.get(sessionId)
    }
    if (input.method === "session.abort") {
      const sessionId = value.sessionId
      if (typeof sessionId !== "string") throw new Error("session.abort requires sessionId")
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
      return getPluginBlueprint({ scopeId: input.invocation.scopeId, loopID })
    }
    if (input.method === "blueprint.list") {
      return listPluginBlueprints(input.invocation.scopeId)
    }
    const actor = input.invocation.actor
    if (input.method === "task.start") {
      const parent =
        value.parent && typeof value.parent === "object" ? (value.parent as Record<string, unknown>) : undefined
      const sessionID =
        typeof parent?.sessionId === "string"
          ? parent.sessionId
          : actor.type === "agent"
            ? input.invocation.sessionId
            : undefined
      const messageID =
        typeof parent?.messageId === "string" ? parent.messageId : actor.type === "agent" ? actor.messageId : undefined
      if (!sessionID || !messageID) {
        throw pluginHostServiceError(
          PluginHostServiceErrorCode.TASK_PARENT_REQUIRED,
          "task.start requires a parent Session and message",
        )
      }
      const parentSession = await Session.get(sessionID)
      if (!parentSession || parentSession.scope.id !== input.invocation.scopeId) {
        throw pluginHostServiceError(
          PluginHostServiceErrorCode.TASK_PARENT_SCOPE_MISMATCH,
          "task.start parent Session does not belong to the active Scope",
        )
      }
      return startPluginTask({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        pluginDir: input.pluginDir,
        context: {
          pluginId: input.pluginId,
          pluginDir: input.pluginDir,
          sessionID,
          messageID,
          agent: actor.type === "agent" ? actor.agent : "synergy",
          callID: actor.type === "agent" ? actor.callId : undefined,
          directory: input.invocation.directory,
          abort: input.signal,
        },
        request: value as never,
      })
    }
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
    if (input.method === "blueprint.create") {
      return createPluginBlueprint({
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        context: runtimeContext,
        request: value as never,
      })
    }
    if (input.method === "blueprint.start" || input.method === "blueprint.cancel") {
      const loopID = value.loopID
      if (typeof loopID !== "string") throw new Error(`${input.method} requires loopID`)
      const request = {
        pluginId: input.pluginId,
        pluginGeneration: input.manifest.artifacts.generation,
        scopeId: input.invocation.scopeId,
        context: runtimeContext,
        loopID,
      }
      return input.method === "blueprint.start" ? startPluginBlueprint(request) : cancelPluginBlueprint(request)
    }
    if (input.method === "lightloop.enable") {
      return enablePluginLightLoop({ context: runtimeContext, request: value as never })
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
