import { MessageV2 } from "../session/message-v2"
import { Session } from "../session/index"
import { ContinuationKernel } from "../session/continuation-kernel"
import { SessionInbox } from "../session/inbox"
import { bossAssignmentMetadata } from "./boss-message"

const BOSS_REPORT_TOOL = "boss_report"

/**
 * BossContinuationPolicy — idle wake-up for boss workers. When a worker has an
 * assigned task whose assistant reply never reported back via boss_report, the
 * worker is nudged to continue or report. The root boss session never gets a
 * continuation proposal (it stays human-driven), and workers fall dormant when
 * the root is disabled or archived.
 */
export const BossContinuationPolicy: ContinuationKernel.Policy = {
  id: "boss_worker",
  priority: 40,
  async handle(gate) {
    const workflow = gate.session.workflow
    if (workflow?.kind !== "boss" || workflow.role !== "worker") return undefined

    const rootID = workflow.rootID
    if (!rootID) return undefined
    const root = await Session.get(rootID).catch(() => undefined)
    if (root?.workflow?.kind !== "boss") return undefined

    if (await SessionInbox.hasRunnableItem(gate.sessionID, { allowSteer: false })) return undefined

    const messages = await Session.messages({ sessionID: gate.sessionID, limit: 50 }).catch(() => [])
    const latestTask = latestTaskUserMessage(messages, gate.session)
    if (!latestTask) return undefined
    if (hasReported(messages, latestTask.info.id)) return undefined

    return {
      kind: "inbox",
      mode: "steer",
      message: {
        role: "user",
        summary: { title: "Continue assigned task" },
        origin: { type: "system" },
        parts: [
          {
            type: "text",
            text: `Your assigned task is still waiting for a report.\n\nIf the task is not complete, continue working on it now.\nIf the task is complete or blocked, call boss_report with a summary and a status ("completed", "blocked", or "needs_input").`,
            origin: "system",
          },
        ],
        metadata: { source: "boss_continuation" },
      },
    }
  },
}

function latestTaskUserMessage(
  messages: MessageV2.WithParts[],
  session: Pick<Session.Info, "id" | "parentID">,
): MessageV2.WithParts | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    if (bossAssignmentMetadata(message.info, session, { requireRoot: true })) return message
  }
  return undefined
}

function hasReported(messages: MessageV2.WithParts[], taskUserID: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "assistant") continue
    const assistant = message.info as MessageV2.Assistant
    if (assistant.parentID !== taskUserID && assistant.rootID !== taskUserID) continue
    if (assistant.error) continue
    const report = message.parts.find(
      (part): part is Extract<MessageV2.Part, { type: "tool" }> =>
        part.type === "tool" && part.tool === BOSS_REPORT_TOOL,
    )
    if (report && report.state.status === "completed") return true
  }
  return false
}
