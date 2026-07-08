import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { NoteStore } from "../note"
import { Log } from "../util/log"
import { SessionWorkflowService } from "../session/workflow"
import { BlueprintLoopStore } from "./loop-store"
import type { Info } from "./types"

const log = Log.create({ service: "blueprint.service" })

const CODING_BLUEPRINT_AGENTS = new Set(["synergy-max", "developer", "implementation-engineer", "refactoring-engineer"])

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

  export async function resolveBlueprintAuditAgent(noteID: string): Promise<string> {
    const note = await NoteStore.getAny(ScopeContext.current.scope.id, noteID).catch(() => undefined)
    const noteAgent = await knownAgentName(note?.blueprint?.auditAgent)
    return noteAgent ?? "supervisor"
  }

  export function normalizeStartUserPrompt(userPrompt?: string): string | undefined {
    const trimmed = userPrompt?.trim()
    return trimmed ? trimmed : undefined
  }

  function defaultFirstPrompt(loop: { id: string; title: string; noteID: string }, agentName?: string) {
    if (isCodingBlueprintAgent(agentName)) {
      return `Execute the coding Blueprint "${loop.title}" (note ID: ${loop.noteID}, loop ID: ${loop.id}).
First call note_read with ids=["${loop.noteID}"] and read the full Blueprint content.
Treat the Blueprint as the authoritative engineering contract for this run: requirements, non-goals, codebase entry points, migration or compatibility expectations, cleanup, and verification commands.
Create or update a DAG when the work has multiple phases, dependencies, parallel implementation slices, or review gates. Split independent code work by module or concern and keep each delegated task narrow.
Continue until every Blueprint requirement is implemented, verified, and integrated. Keep the codebase clean: remove obsolete paths when the Blueprint replaces them, avoid redundant logic, and preserve local conventions.
When the Blueprint is ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).
If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`
    }

    return `Execute the Blueprint "${loop.title}" (note ID: ${loop.noteID}, loop ID: ${loop.id}).
First call note_read with ids=["${loop.noteID}"] and read the full Blueprint content.
Treat the Blueprint as the authoritative brief for this run: goal, deliverables, constraints, audience, chosen approach, quality criteria, and acceptance criteria.
Choose the execution shape that fits the Blueprint's domain and complexity. Work directly for small linear tasks; create or update a DAG when there are multiple phases, real dependencies, parallel workstreams, or useful progress checkpoints.
Use domain-appropriate specialists when they improve the outcome. Do not import software-engineering workflow unless the Blueprint is software work.
Continue until the requested outcome is complete. For every material requirement, produce or update the requested artifact or result, keep the whole deliverable coherent, and apply quality checks appropriate to the domain.
When the Blueprint is ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).
If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`
  }

  export async function bindSessionToLoop(sessionID: string, loopID: string, loopRole: "execution" | "audit") {
    const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loopID)
    await SessionWorkflowService.prepareBlueprintLoopBinding(sessionID, loop.source)
    await Session.update(sessionID, (draft) => {
      draft.blueprint = { ...draft.blueprint, loopID, loopRole }
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
    },
    userPrompt?: string,
  ) {
    const agentName = loop.executionAgent ?? (await resolveBlueprintAgent(sessionID, loop.noteID))
    let text = loop.firstPrompt?.trim() || defaultFirstPrompt(loop, agentName)
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
      resolveBlueprintAuditAgent(input.noteID),
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
    await SessionWorkflowService.prepareBlueprintLoopBinding(before.sessionID, before.source)
    const loop = await BlueprintLoopStore.updateStatus(scopeID, loopID, {
      status: "running",
      userPrompt: normalized ?? null,
    })
    await bindSessionToLoop(before.sessionID, loopID, "execution")
    void deliverFirstPrompt(before.sessionID, before, normalized).catch((err) => {
      log.error("failed to deliver BlueprintLoop start prompt", { loopID, error: err })
      BlueprintLoopStore.updateStatus(scopeID, loopID, {
        status: "failed",
        error: err?.message ?? String(err),
      }).catch(() => undefined)
    })
    return loop
  }

  /**
   * Create an armed loop and immediately start it. The primary entry point for
   * external orchestrators (e.g. Lattice) that own the whole lifecycle.
   */
  export async function createAndStart(input: CreateInput & { userPrompt?: string }): Promise<Info> {
    const scopeID = ScopeContext.current.scope.id
    const armed = await create(input)
    return start(scopeID, armed.id, input.userPrompt)
  }
}
