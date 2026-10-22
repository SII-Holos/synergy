import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { WorkflowSessionService } from "@ericsanchezok/synergy-blueprint/session/workflow"
import { BlueprintLoopStore } from "./loop-store"
import { BlueprintLoopSources } from "./source"
import { LoopError } from "./error"
import { BLUEPRINT_PAUSE_GUIDANCE } from "./prompt"
import type { Info } from "./types"

const log = Log.create({ service: "blueprint.service" })

const CODING_BLUEPRINT_AGENTS = new Set([
  PrimaryAgentIdentity.names.coding,
  "developer",
  "implementation-engineer",
  "refactoring-engineer",
])

/**
 * BlueprintLoopService centralises the create/start orchestration that used to
 * live as private helpers inside the HTTP route (server/blueprint.ts). Both the
 * route and higher-level orchestrators (e.g. Lattice) call these so there is a
 * single implementation of first-prompt delivery, agent resolution, session
 * binding, and start failure roll-back.
 */
export namespace BlueprintLoopService {
  export type CreateInput = {
    noteID: string
    noteVersion?: number
    title: string
    description?: string
    sessionID: string
    executionAgent?: string
    runMode?: Info["runMode"]
    parentSessionID?: string
    firstPrompt?: string
    loopIndex?: number
    model?: { providerID: string; modelID: string }
    source?: Info["source"]
    sourceDigest?: string
    pluginOwner?: Info["pluginOwner"]
  }

  export function isCodingBlueprintAgent(agentName?: string): boolean {
    return !!agentName && CODING_BLUEPRINT_AGENTS.has(agentName)
  }

  export async function knownAgentName(agentName?: string): Promise<string | undefined> {
    const trimmed = agentName?.trim()
    if (!trimmed) return undefined
    const agent = await Agent.get(trimmed).catch(() => undefined)
    return agent?.name
  }

  export async function resolveBlueprintAgent(sessionID: string, noteID: string): Promise<string | undefined> {
    const note = await NoteStore.getAny(ScopeContext.current.scope.id, noteID).catch(() => undefined)
    const noteAgent = await knownAgentName(note?.blueprint?.defaultAgent)
    if (noteAgent) return noteAgent

    const messages = await Session.messages({ sessionID, raw: true }).catch(() => [])
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "user") continue
      const messageAgent = await knownAgentName(message.info.agent)
      if (messageAgent) return messageAgent
    }

    return Agent.defaultAgent()
      .then(knownAgentName)
      .catch(() => undefined)
  }

  export function resolveBlueprintAuditAgent(): string {
    return "supervisor"
  }

  export function normalizeStartUserPrompt(userPrompt?: string): string | undefined {
    const trimmed = userPrompt?.trim()
    return trimmed ? trimmed : undefined
  }

  function defaultFirstPrompt(loop: { id: string; title: string; noteID: string }) {
    return `Execute Blueprint "${loop.title}" (${loop.noteID}). Read the complete Note before starting; preserve its requirements, boundaries and acceptance criteria. Work directly unless coordination materially helps. Verify the delivered outcome with evidence appropriate to the claim. When complete, call blueprint_loop_stop with concise results, key checks, evidence references and limitations, then end the turn. ${BLUEPRINT_PAUSE_GUIDANCE}`
  }

  export async function bindSessionToLoop(sessionID: string, loopID: string, loopRole: "execution" | "audit") {
    const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loopID)
    await WorkflowSessionService.prepareBlueprintLoopBinding(sessionID, loop.source)
    await Session.update(sessionID, (draft) => {
      draft.blueprint = { ...draft.blueprint, loopID, loopRole, source: loop.source ?? "user" }
    })
  }

  export async function assertLoopSessionInCurrentScope(sessionID: string) {
    const session = await Session.get(sessionID)
    const sessionScopeID = session.scope.id
    const loopScopeID = ScopeContext.current.scope.id
    if (sessionScopeID !== loopScopeID) {
      throw new Error(
        `Session ${sessionID} belongs to scope ${sessionScopeID}, but this BlueprintLoop is in ${loopScopeID}.`,
      )
    }
  }

  export async function deliverFirstPrompt(
    sessionID: string,
    loop: {
      id: string
      noteID: string
      title: string
      firstPrompt?: string
      executionAgent?: string
      model?: { providerID: string; modelID: string }
      source?: Info["source"]
    },
    userPrompt?: string,
  ) {
    const agentName = loop.executionAgent ?? (await resolveBlueprintAgent(sessionID, loop.noteID))
    let text = loop.firstPrompt?.trim() || defaultFirstPrompt(loop)
    if (userPrompt) {
      text += `\n\nUser instruction:\n${userPrompt}`
    }
    const textPart: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      sessionID,
      messageID: Identifier.ascending("message"),
      type: "text",
      text,
    }
    const mail: SessionManager.SessionMail.User = {
      type: "user",
      parts: [textPart],
      ...(agentName ? { agent: agentName } : {}),
      ...(loop.model ? { model: loop.model } : {}),
      summary: {
        title: `Execute ${loop.title} blueprint`,
      },
      metadata: {
        source: "blueprint_loop_start",
        requiredFeatures: BlueprintLoopSources.requiredFeatures(loop.source),
        requiredOwners: BlueprintLoopSources.requiredOwners(loop.source),
        loopID: loop.id,
        noteID: loop.noteID,
        title: loop.title,
        ...(agentName ? { agent: agentName } : {}),
        ...(userPrompt ? { userPrompt } : {}),
      },
    }
    await SessionManager.deliver({ target: sessionID, mail })
  }

  /**
   * Create an armed BlueprintLoop with fully resolved execution/audit agents.
   * Mirrors the previous POST /loop route behaviour.
   */
  export async function create(input: CreateInput): Promise<Info> {
    await assertLoopSessionInCurrentScope(input.sessionID)
    const [explicitExecutionAgent, fallbackExecutionAgent, auditAgent] = await Promise.all([
      knownAgentName(input.executionAgent),
      resolveBlueprintAgent(input.sessionID, input.noteID),
      resolveBlueprintAuditAgent(),
    ])
    return BlueprintLoopStore.create({
      ...input,
      executionAgent: explicitExecutionAgent ?? fallbackExecutionAgent,
      auditAgent,
      runMode: input.runMode ?? "current",
    })
  }

  /**
   * Transition an armed loop to running, bind the session, and deliver the
   * execution first-prompt. On delivery failure the loop is rolled back to
   * failed. Mirrors the previous POST /loop/:id/start route behaviour.
   */
  export async function start(scopeID: string, loopID: string, userPrompt?: string): Promise<Info> {
    const normalized = normalizeStartUserPrompt(userPrompt)
    const before = await BlueprintLoopStore.get(scopeID, loopID)
    // The drive gate refuses a paused session, so a delivery made under the
    // latch parks in the inbox while the loop and the Note both report a run
    // that never starts. Settle the latch before anything is written, so a
    // blocked start leaves neither a binding nor a `running` claim behind.
    //
    // A user-owned start is the user taking the session back: the first prompt
    // is a new task root, so the previous failure's pause must be released. A
    // machine-owned start may not release it — resuming work the user stopped
    // behind their back is the defect the latch exists to prevent — so it fails
    // with the fact and lets its owner decide what that means for its own
    // lifecycle.
    if (await SessionLifecycle.blocksDrive(await Session.get(before.sessionID))) {
      if (before.source !== "user")
        throw new LoopError.SessionPaused({
          loopID,
          sessionID: before.sessionID,
          source: before.source,
        })
      await SessionLifecycle.startNewTask(before.sessionID)
    }
    await bindSessionToLoop(before.sessionID, loopID, "execution")
    const loop = await BlueprintLoopStore.updateStatus(scopeID, loopID, {
      status: "running",
      userPrompt: normalized ?? null,
    })
    void deliverFirstPrompt(before.sessionID, before, normalized).catch(async (err) => {
      // Delivery awaits the executing turn; a user interruption is not a failed start.
      if (
        (err instanceof Error && err.name === "AbortError") ||
        (MessageV2.SessionTerminalError.isInstance(err) && err.data.errorName === MessageV2.AbortedError.name)
      ) {
        const paused = await SessionLifecycle.snapshot(before.sessionID)
        if (paused?.reason === "aborted" || paused?.reason === "interrupted") return
      }
      log.error("failed to deliver BlueprintLoop start prompt", { loopID, error: err })
      await BlueprintLoopStore.updateStatus(scopeID, loopID, {
        status: "failed",
        error: err?.message ?? String(err),
      }).catch(() => undefined)
    })
    return loop
  }
}
