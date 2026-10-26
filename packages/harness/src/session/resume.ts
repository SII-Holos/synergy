import { z } from "zod"
import { Session } from "."
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { SessionExecutionOwners } from "./execution-owners"
import { SessionHistory } from "./history"
import { SessionInbox } from "./inbox"
import { SessionLifecycle } from "./lifecycle"
import { SessionManager } from "./manager"
import { SessionProgress } from "./progress"
import { RolloutLedger } from "./rollout/ledger"
import { RolloutLifecycle } from "./rollout/lifecycle"
import { StatusInfo, ResumeInfo } from "./types"
import * as SessionWorking from "./working"

export namespace SessionResume {
  export const Input = z.object({
    sessionID: Identifier.schema("session"),
    requestID: z.string().min(1).max(200).optional(),
    pausedSince: z.number().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Result = z
    .object({
      handled: z.boolean(),
      outcome: z.enum(["accepted", "already_accepted", "running", "idle", "stale", "blocked"]),
      receipt: ResumeInfo.optional(),
      status: StatusInfo,
      reason: z.string().optional(),
    })
    .meta({ ref: "SessionContinueResult" })
  export type Result = z.infer<typeof Result>

  async function result(sessionID: string, outcome: Result["outcome"], reason?: string): Promise<Result> {
    const session = await Session.get(sessionID)
    const working = await SessionWorking.resolve(sessionID, session)
    return {
      handled: ["accepted", "already_accepted", "running"].includes(outcome),
      outcome,
      receipt: session.resume,
      status: working ? SessionWorking.toStatus(working) : { type: "idle" },
      ...(reason ? { reason } : {}),
    }
  }

  export async function request(input: Input): Promise<Result> {
    using control = await Lock.write(`session-control:${input.sessionID}`)
    let session = await Session.get(input.sessionID)
    if (input.requestID && session.resume?.requestID === input.requestID) return result(session.id, "already_accepted")
    if (input.pausedSince !== undefined && session.paused?.since !== input.pausedSince) {
      if (session.resume?.pausedSince === input.pausedSince) return result(session.id, "already_accepted")
      return result(session.id, "stale", "The session changed. Check its current state before continuing.")
    }
    if (session.time.archived) return result(session.id, "blocked", "Archived sessions cannot continue.")
    if (!session.paused && SessionManager.isRunning(session.id)) return result(session.id, "running")
    await SessionExecutionOwners.assertResume(session)
    await SessionManager.waitForIdle(session.id)
    session = await Session.get(session.id)
    const messages = await SessionHistory.modelMessages({ sessionID: session.id })
    const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)?.info
    const latest = messages.findLast((message) => message.info.role === "assistant")?.info
    const queued = await SessionInbox.peekReady(session.id)
    if (!session.paused && session.resume?.state === "queued") return result(session.id, "already_accepted")
    const pending = SessionProgress.pendingReply(messages)
    const failed = latest?.role === "assistant" && !!latest.error && latest.rootID === root?.id
    const nextTask = !pending && !failed ? queued.find((item) => item.mode === "task") : undefined
    const resumeRoot = nextTask ? undefined : root
    if (!queued.length && !pending && !failed && !session.paused) return result(session.id, "idle")
    if (!root && !queued.length) return result(session.id, "blocked", "There is no saved task to continue.")
    if ((await SessionHistory.storedInfo(session.id))?.rollback?.canUnrollback)
      return result(session.id, "blocked", "Restore the rolled-back task or send a new task before continuing.")

    const requestID = input.requestID ?? `continue:${session.paused?.since ?? latest?.id ?? root?.id}`
    const previous =
      session.resume?.state === "queued" ? queued.find((item) => item.id === session.resume?.itemID) : undefined
    let admitted = false
    const commit = async () => {
      const delivery = previous ?? nextTask ?? (!root ? queued[0] : undefined)
      const receipt = delivery
        ? { itemID: delivery.id, messageID: delivery.messageID }
        : await SessionInbox.deliverUnique({
            sessionID: session.id,
            deliveryKey: requestID,
            mode: "steer",
            message: {
              role: "user",
              visible: false,
              origin: { type: "user", detail: "continue" },
              parts: [
                {
                  type: "text",
                  text: "Continue the current task from the saved progress. Preserve completed work and check uncertain operation results before retrying them.",
                },
              ],
            },
          })
      await Session.update(session.id, (draft) => {
        draft.resume = {
          requestID,
          rootID: resumeRoot?.id ?? nextTask?.messageID,
          itemID: receipt.itemID,
          messageID: receipt.messageID,
          pausedSince: session.paused?.since,
          created: Date.now(),
          state: "queued",
        }
      })
      if (!(await SessionLifecycle.clear(session.id))) {
        const current = await result(session.id, "accepted")
        await SessionManager.publishStatusOnly(session.id, current.status)
      }
      Storage.afterCommit(() => SessionManager.scheduleWake(session.id, "user-continue"))
      admitted = true
    }
    if (resumeRoot) {
      const owner = RolloutLifecycle.owner(session)
      if (pending && SessionProgress.findTerminalReply(messages, resumeRoot.id))
        await RolloutLedger.continueRun(owner, resumeRoot.id, commit)
      if (!admitted) await RolloutLedger.resumeRun(owner, resumeRoot.id, commit)
    } else await Storage.transaction(commit)
    if (!admitted) return result(session.id, "blocked", "The task is completed or its execution evidence needs repair.")
    return result(session.id, "accepted")
  }
}
