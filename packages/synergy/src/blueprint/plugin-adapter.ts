import type { BlueprintLoopInfo, BlueprintStartInput } from "@ericsanchezok/synergy-plugin"
import { hash as sha256 } from "@ericsanchezok/synergy-util/encode"
import { Agent } from "@/agent/agent"
import { Cortex } from "@/cortex"
import { Provider } from "@/provider/provider"
import { NoteStore } from "../note"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { Identifier } from "../id/id"
import { readPluginManifest } from "../plugin/spec-resolver"
import { BlueprintLoopStore } from "./loop-store"
import { BlueprintLoopService } from "./service"
import { BlueprintLoopRuntime } from "./loop-runtime"
import type { Info } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "blueprint.plugin-adapter" })

export const BlueprintPluginErrorCode = {
  DIGEST_MISMATCH: "BLUEPRINT_DIGEST_MISMATCH",
  NOT_FOUND: "BLUEPRINT_NOT_FOUND",
  NOT_PLUGIN_OWNED: "BLUEPRINT_NOT_PLUGIN_OWNED",
} as const

function pluginAdapterError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "BlueprintPluginError", code })
}

function publicLoop(loop: Info): BlueprintLoopInfo {
  return loop
}

async function assertBlueprintDelegation(
  input: {
    pluginId: string
    pluginGeneration: string
    pluginDir?: string
    executionAgent: string
    auditAgent: string
  },
  manifestCapability: string,
) {
  const execAgent = await Agent.get(input.executionAgent)
  if (!execAgent) throw new Error(`Unknown execution agent: ${input.executionAgent}`)
  if (execAgent.mode === "primary") throw new Error(`Execution agent "${input.executionAgent}" is a primary agent`)
  if (!execAgent.hidden) throw new Error(`Execution agent "${input.executionAgent}" is not hidden`)

  const auditAgentInfo = await Agent.get(input.auditAgent)
  if (!auditAgentInfo) throw new Error(`Unknown audit agent: ${input.auditAgent}`)
  if (auditAgentInfo.mode === "primary") throw new Error(`Audit agent "${input.auditAgent}" is a primary agent`)
  if (!auditAgentInfo.hidden) throw new Error(`Audit agent "${input.auditAgent}" is not hidden`)

  if (input.executionAgent === input.auditAgent) throw new Error("Execution and audit agents must differ")

  if (input.pluginDir) {
    const manifest = await readPluginManifest(input.pluginDir)
    const cap = manifest.capabilities.find((c) => c.id === manifestCapability)
    if (!cap) throw new Error(`Plugin manifest does not declare capability ${manifestCapability}`)

    const agents = Array.isArray(cap.constraints?.agents) ? cap.constraints.agents : undefined
    if (agents) {
      if (!agents.includes(input.executionAgent))
        throw new Error(`Plugin manifest does not allow Blueprint execution agent "${input.executionAgent}"`)
      if (!agents.includes(input.auditAgent))
        throw new Error(`Plugin manifest does not allow Blueprint audit agent "${input.auditAgent}"`)
    }
  }

  const execOwner = Agent.pluginOwner(execAgent)
  if (!execOwner || execOwner.pluginId !== input.pluginId || execOwner.pluginGeneration !== input.pluginGeneration) {
    throw new Error(`Execution agent "${input.executionAgent}" is not owned by this plugin generation`)
  }
  const auditOwner = Agent.pluginOwner(auditAgentInfo)
  if (!auditOwner || auditOwner.pluginId !== input.pluginId || auditOwner.pluginGeneration !== input.pluginGeneration) {
    throw new Error(`Audit agent "${input.auditAgent}" is not owned by this plugin generation`)
  }
}

export interface BlueprintStartContext {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  pluginDir?: string
  /** Parent session + message for child Cortex task delegation */
  parentSessionID: string
  parentMessageID: string
}

function firstPromptText(title: string, noteID: string, loopID: string): string {
  return `Execute the Blueprint "${title}" (note ID: ${noteID}, loop ID: ${loopID}).
First call note_read with ids=["${noteID}"] and read the full Blueprint content.
Treat the Blueprint as the authoritative engineering contract for this run: requirements, non-goals, deliverables, constraints, quality criteria, and acceptance criteria.
Continue until every Blueprint requirement is implemented, verified, and integrated.
When the Blueprint is complete and verified, call blueprint_loop_stop with a concise summary, completed requirements, concrete evidence, and any known limitations to request independent review.`
}

/**
 * Protocol 5 atomic Blueprint start.
 *
 * Validates all inputs, hashes markdown, creates a Blueprint Note, a dedicated
 * hidden execution Session via Session.create (no execution yet), a Store record,
 * binds, marks running, and THEN launches Cortex with the pre-created sessionID
 * delivering exactly ONE formatted execution prompt. Raw markdown stays in the
 * frozen Note only.
 *
 * On failure at any stage, all previously created resources are rolled back
 * (archived/cancelled).
 */
export async function startBlueprint(input: {
  context: BlueprintStartContext
  request: BlueprintStartInput
}): Promise<BlueprintLoopInfo> {
  const ctx = input.context
  const r = input.request

  // --- validation ---
  if (!r.title?.trim()) throw new Error("blueprint.start requires title")
  if (!r.markdown?.trim()) throw new Error("blueprint.start requires markdown")
  if (!r.correlationId?.trim()) throw new Error("blueprint.start requires correlationId")
  if (!r.executionAgent?.trim()) throw new Error("blueprint.start requires executionAgent")
  if (!r.auditAgent?.trim()) throw new Error("blueprint.start requires auditAgent")
  if (!r.budget) throw new Error("blueprint.start requires budget")
  if (!Number.isFinite(r.budget.maxRuntimeMs) || r.budget.maxRuntimeMs <= 0)
    throw new Error("budget.maxRuntimeMs must be a positive integer")
  if (!Number.isFinite(r.budget.maxIterations) || r.budget.maxIterations <= 0)
    throw new Error("budget.maxIterations must be a positive integer")

  const title = r.title.trim()
  const markdown = r.markdown.trim()
  const correlationId = r.correlationId.trim()
  const executionAgent = r.executionAgent.trim()
  const auditAgent = r.auditAgent.trim()
  const description = r.description?.trim()

  // Digest validation
  const computedDigest = await sha256(markdown)
  if (computedDigest !== r.sourceDigest) {
    throw pluginAdapterError(BlueprintPluginErrorCode.DIGEST_MISMATCH, "sourceDigest does not match markdown content")
  }

  await assertBlueprintDelegation(
    {
      pluginId: ctx.pluginId,
      pluginGeneration: ctx.pluginGeneration,
      pluginDir: ctx.pluginDir,
      executionAgent,
      auditAgent,
    },
    "blueprint.delegate",
  )

  const scopeID = ctx.scopeId
  const execAgentInfo = (await Agent.get(executionAgent))!
  const model = r.executionModel ?? (await Agent.getAvailableModel(execAgentInfo)) ?? (await Provider.defaultModel())
  const pluginOwner = {
    pluginId: ctx.pluginId,
    pluginGeneration: ctx.pluginGeneration,
    scopeId: scopeID,
    correlationId,
  }

  // --- state for rollback ---
  let noteID: string | undefined
  let sessionID: string | undefined
  let taskID: string | undefined
  let loopID: string | undefined

  const rollback = async () => {
    if (taskID) {
      await Cortex.cancel(taskID).catch(() => {})
    }
    if (loopID) {
      await BlueprintLoopStore.updateStatus(scopeID, loopID, { status: "cancelled" }).catch(() => {})
    }
    if (sessionID) {
      await Session.update(sessionID, (draft) => {
        draft.time.archived = Date.now()
      }).catch(() => {})
    }
    if (noteID) {
      await NoteStore.update(scopeID, noteID, { archived: true }).catch(() => {})
    }
  }

  try {
    // Step 1: Create a project-scoped Blueprint Note (frozen, raw markdown only)
    const note = await NoteStore.create({
      title,
      content: { format: "markdown", text: markdown },
      kind: "blueprint",
      blueprint: { description },
    })
    noteID = note.id

    // Step 2: Create a dedicated hidden execution Session WITHOUT starting execution
    const scope = ScopeContext.current.scope
    const parent = await Session.get(ctx.parentSessionID).catch(() => undefined)
    const workspace = parent?.workspace ?? {
      type: "main" as const,
      path: scope.directory,
      scopeID: scope.id,
    }
    const execSession = await Session.create({
      scope,
      parentID: ctx.parentSessionID,
      title: `[Blueprint] ${title.slice(0, 80)}`,
      cortex: {
        taskID: "",
        parentSessionID: ctx.parentSessionID,
        parentMessageID: ctx.parentMessageID,
        description: `[Blueprint] ${title.slice(0, 80)}`,
        agent: executionAgent,
        model,
        executionRole: "delegated_subagent",
        status: "queued",
        startedAt: Date.now(),
        visibility: "hidden",
        owner: pluginOwner,
        timeoutMs: r.budget.maxRuntimeMs,
      },
      workspace,
      completionNotice: { silent: true },
      permission: [{ permission: "question", pattern: "*", action: "deny" } as any],
    })
    sessionID = execSession.id

    // Step 3: Create BlueprintLoopStore record (armed)
    const loop = await BlueprintLoopStore.create({
      noteID,
      noteVersion: note.version,
      title,
      description,
      sessionID,
      executionAgent,
      auditAgent,
      runMode: "current",
      source: "plugin",
      sourceDigest: r.sourceDigest,
      budget: r.budget,
      pluginOwner,
      model: r.executionModel,
      executionTools: r.executionTools,
      auditTools: r.auditTools,
    })
    loopID = loop.id

    // Step 4: Bind session to loop and mark running
    await BlueprintLoopService.bindSessionToLoop(sessionID, loop.id, "execution")
    const runningLoop = await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
      status: "running",
    })

    // Step 5: Launch Cortex with the pre-created session, delivering exactly ONE formatted prompt.
    // Raw markdown stays in the Note; the Cortex prompt is the execution instruction.
    const ft = firstPromptText(title, noteID, loop.id)
    const task = await Cortex.launch({
      description: `[Blueprint] ${title.slice(0, 80)}`,
      prompt: ft,
      agent: executionAgent,
      executionRole: "delegated_subagent",
      category: "general",
      parentSessionID: ctx.parentSessionID,
      parentMessageID: ctx.parentMessageID,
      sessionID, // reuse pre-created session
      model,
      visibility: "hidden",
      notifyParentOnComplete: false,
      timeoutMs: r.budget.maxRuntimeMs,
      tools: r.executionTools,
      owner: pluginOwner,
    })
    taskID = task.id

    // Schedule timer for maxRuntimeMs
    BlueprintLoopRuntime.scheduleDeadline(scopeID, loop.id, r.budget.maxRuntimeMs)

    return publicLoop(runningLoop)
  } catch (err) {
    await rollback()
    throw err
  }
}

export async function getBlueprint(input: {
  scopeId: string
  loopID: string
  pluginId: string
  pluginGeneration: string
}): Promise<BlueprintLoopInfo> {
  const loop = await BlueprintLoopStore.get(input.scopeId, input.loopID).catch(() => {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
  })
  if (loop.source !== "plugin" || !loop.pluginOwner) {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_PLUGIN_OWNED, "BlueprintLoop is not plugin-owned")
  }
  if (
    loop.pluginOwner.pluginId !== input.pluginId ||
    loop.pluginOwner.pluginGeneration !== input.pluginGeneration ||
    loop.pluginOwner.scopeId !== input.scopeId
  ) {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
  }
  return publicLoop(loop)
}

export async function cancelBlueprint(input: {
  scopeId: string
  loopID: string
  pluginId: string
  pluginGeneration: string
}): Promise<BlueprintLoopInfo> {
  const loop = await BlueprintLoopStore.get(input.scopeId, input.loopID).catch(() => {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
  })
  if (loop.source !== "plugin" || !loop.pluginOwner) {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_PLUGIN_OWNED, "BlueprintLoop is not plugin-owned")
  }
  if (
    loop.pluginOwner.pluginId !== input.pluginId ||
    loop.pluginOwner.pluginGeneration !== input.pluginGeneration ||
    loop.pluginOwner.scopeId !== input.scopeId
  ) {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
  }

  // Cancel execution and audit tasks/sessions
  if (loop.sessionID) {
    const execSession = await Session.get(loop.sessionID).catch(() => undefined)
    if (execSession?.cortex) {
      await Cortex.cancel(execSession.cortex.taskID).catch(() => {})
    }
  }
  if (loop.auditSessionID) {
    const auditSession = await Session.get(loop.auditSessionID).catch(() => undefined)
    if (auditSession?.cortex) {
      await Cortex.cancel(auditSession.cortex.taskID).catch(() => {})
    }
  }

  // Transition to cancelled (fires blueprint.after hook, archives resources)
  const updated = await BlueprintLoopStore.updateStatus(input.scopeId, input.loopID, {
    status: "cancelled",
  })

  BlueprintLoopRuntime.cancelDeadline(input.scopeId, input.loopID)

  return publicLoop(updated)
}
