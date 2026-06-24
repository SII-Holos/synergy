import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import type { Scope } from "../scope"
import { ScopedState } from "../scope/scoped-state"
import { SessionEvent } from "./event"
import { SessionManager } from "./manager"
import { MessageV2 } from "./message-v2"
import { SessionProgress } from "./progress"

export namespace BlueprintContinuation {
  const log = Log.create({ service: "session.blueprint-continuation" })
  const subscription = ScopedState.create(
    () => {
      const unsubscribe = Bus.subscribe(SessionEvent.Idle, (event) => {
        handleIdle(event.properties.sessionID).catch((error) => {
          log.error("idle continuation failed", { sessionID: event.properties.sessionID, error })
        })
      })
      return { unsubscribe }
    },
    async (state) => state.unsubscribe(),
  )

  export function init() {
    return subscription().unsubscribe
  }

  export async function handleIdle(sessionID: string): Promise<boolean> {
    const session = await SessionManager.getSession(sessionID)
    if (!session || session.time.archived) return false

    const loopID = session.blueprint?.loopID
    if (!loopID) return false

    const scopeID = (session.scope as Scope).id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => undefined)
    if (!loop || loop.status !== "running") return false

    if (await hasActiveCortexWork(sessionID)) return false
    if (!(await hasCompletedAssistantReply(sessionID))) return false

    await SessionManager.deliver({
      target: sessionID,
      mail: {
        type: "user",
        summary: {
          title: `Continue ${loop.title} blueprint`,
        },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID,
            messageID: "",
            type: "text",
            text: continuationText(loop),
            synthetic: true,
          },
        ],
        metadata: {
          source: "blueprint_loop_continuation",
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          status: loop.status,
        },
      },
    })

    return true
  }

  async function hasActiveCortexWork(sessionID: string): Promise<boolean> {
    const { Cortex } = await import("../cortex/manager")
    return Cortex.getTasksForSession(sessionID).some((task) => task.status === "running" || task.status === "queued")
  }

  async function hasCompletedAssistantReply(sessionID: string): Promise<boolean> {
    const messages = await MessageV2.filterCompacted(MessageV2.stream({ sessionID }))
    const latestUser = latestReplyRequiredUser(messages)
    if (!latestUser) return false

    const assistant = latestAssistantFor(messages, latestUser.id)
    if (!assistant) return false
    if (assistant.error) return false
    return SessionProgress.isTerminalAssistant(assistant)
  }

  function latestAssistantFor(messages: MessageV2.WithParts[], parentID: string): MessageV2.Assistant | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue
      const assistant = message.info as MessageV2.Assistant
      if (assistant.parentID !== parentID) continue
      return assistant
    }
  }

  function latestReplyRequiredUser(messages: MessageV2.WithParts[]): MessageV2.User | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "user") continue
      if (!MessageV2.isPromptVisible(message)) continue
      const user = message.info as MessageV2.User
      if (SessionProgress.isReplyRequiredUser(user)) return user
    }
  }

  function continuationText(loop: BlueprintLoopInfo): string {
    return [
      `BlueprintLoop ${loop.id} status is \`running\`.`,
      "",
      `A normal final response does not finish this loop. Inspect the Blueprint note (${loop.noteID}), the current implementation state, and any test or verification results before deciding what to do next.`,
      "",
      `If the Blueprint is not fully implemented, continue the remaining implementation work now.`,
      `If the Blueprint is fully implemented and ready for review, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).`,
      `If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`,
    ].join("\n")
  }
}
