import { Bus } from "../bus"
import { Identifier } from "../id/id"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { SessionCompaction } from "./compaction"
import { SessionManager } from "./manager"
import type { MessageV2 } from "./message-v2"

/**
 * CharterRecall re-grounds a session immediately after context compaction.
 *
 * The charter *body* is compaction-immune already: it lives in the system
 * prompt (invoke.ts Layer 2.4), rebuilt every turn. What compaction destroys is
 * the *runtime* state a long-running seat accumulated — the entity it is working
 * on, the outstanding handoff, the last submission. This subscriber re-injects a
 * short pointer to that state as a `context` inbox item (assistant mail → never
 * wakes an idle session; it piggybacks on the next needed turn).
 *
 * It is the first subscriber to SessionCompaction.Event.Compacted.
 */
export namespace CharterRecall {
  const log = Log.create({ service: "session.charter-recall" })

  const subscription = ScopedState.create(
    () => {
      const unsubscribe = Bus.subscribe(SessionCompaction.Event.Compacted, (event) =>
        handle(event.properties.sessionID).catch((error) => {
          log.error("charter recall failed", { sessionID: event.properties.sessionID, error })
        }),
      )
      return { unsubscribe }
    },
    async (state) => state.unsubscribe(),
  )

  export function init(): () => void {
    return subscription().unsubscribe
  }

  async function handle(sessionID: string): Promise<void> {
    const session = await SessionManager.getSession(sessionID).catch(() => undefined)
    if (!session) return
    if (!session.charter && !session.workflowRun) return

    const body = await buildRecallBody(session)
    if (!body) return

    const part: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      sessionID,
      messageID: Identifier.ascending("message"),
      type: "text",
      text: body,
      synthetic: true,
    }
    await SessionManager.deliver({
      target: sessionID,
      mail: {
        type: "assistant",
        parts: [part],
        metadata: { source: "charter_recall", sessionID },
      },
    })
  }

  /**
   * Assemble the recall pointer. For a workflow-run seat this summarises the
   * bound entity and outstanding handoff; for a plain charter session it just
   * reminds the agent the standing charter is authoritative.
   */
  async function buildRecallBody(session: {
    id: string
    charter?: { noteID: string }
    workflowRun?: { runID: string; role: string; seat?: string; instance?: number }
  }): Promise<string | undefined> {
    const lines: string[] = ["<charter-recall>", "Context was just compacted. Re-ground before continuing."]

    if (session.charter) {
      lines.push(
        `Your standing charter (note ${session.charter.noteID}) remains authoritative and is present in your system prompt.`,
      )
    }

    if (session.workflowRun) {
      const runtime = await buildWorkflowRuntime(session.id, session.workflowRun).catch(() => undefined)
      if (runtime) lines.push(runtime)
      lines.push("Use session_read on your own history if you need detail beyond this summary.")
    }

    lines.push("</charter-recall>")
    return lines.join("\n")
  }

  async function buildWorkflowRuntime(
    sessionID: string,
    binding: { runID: string; role: string; seat?: string; instance?: number },
  ): Promise<string | undefined> {
    const { WorkflowRunStore } = await import("../workflow-run/store")
    const { ScopeContext } = await import("../scope/context")
    const run = await WorkflowRunStore.getOrUndefined(ScopeContext.current.scope.id, binding.runID).catch(
      () => undefined,
    )
    if (!run) return undefined

    const parts: string[] = [`Workflow run: ${run.title} (${run.id}), your role: ${binding.role}`]
    if (binding.seat) parts.push(`Your seat: ${binding.seat}#${binding.instance ?? 0}`)

    const entity =
      run.entities.find((e) => e.assignedSeat?.seat === binding.seat && e.bindings.seatSessionID === sessionID) ??
      run.entities.find(
        (e) => e.assignedSeat?.seat === binding.seat && e.assignedSeat?.instance === (binding.instance ?? 0),
      )
    if (entity) {
      parts.push(`Current entity: "${entity.title}" (${entity.id}) is in state "${entity.state}".`)
      const lastSubmission = entity.submissions.at(-1)
      if (lastSubmission) parts.push(`Last submission: [${lastSubmission.kind}] ${lastSubmission.summary}`)
    }
    return parts.join("\n")
  }
}
