import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
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
import { RolloutAdmissionError } from "./rollout/error"
import { RolloutLedger } from "./rollout/ledger"
import { RolloutLifecycle } from "./rollout/lifecycle"
import { StatusInfo, ResumeInfo } from "./types"
import * as SessionWorking from "./working"

class ResumeChanged extends Error {
  constructor(
    readonly outcome: "stale" | "blocked",
    message: string,
  ) {
    super(message)
  }
}

export namespace SessionResume {
  export const Input = z.object({
    sessionID: Identifier.schema("session"),
    requestID: z.string().min(1).max(200).optional(),
    pausedSince: z.number().optional(),
  })
  export type Input = z.infer<typeof Input>

  export type Admission = {
    actor?: ActorStamp.Info
    signal?: AbortSignal
    // Admission hooks join only a new native receipt's transaction, after execution has drained.
    validate?(): Promise<void>
    record?(receipt: ResumeInfo): Promise<void>
    commitGuard?(): void
  }

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

  async function inspect(input: Input): Promise<{ session: Session.Info } | { result: Result }> {
    const session = await Session.get(input.sessionID)
    if (input.requestID && session.resume?.requestID === input.requestID)
      return { result: await result(session.id, "already_accepted") }
    if (input.pausedSince !== undefined && session.paused?.since !== input.pausedSince) {
      if (session.resume?.pausedSince === input.pausedSince)
        return { result: await result(session.id, "already_accepted") }
      return {
        result: await result(session.id, "stale", "The session changed. Check its current state before continuing."),
      }
    }
    if (session.time.archived)
      return { result: await result(session.id, "blocked", "Archived sessions cannot continue.") }
    if (!session.paused && SessionManager.isRunning(session.id)) return { result: await result(session.id, "running") }
    return { session }
  }

  async function controlled<T>(sessionID: string, signal: AbortSignal | undefined, body: () => Promise<T>) {
    using control = signal
      ? await Lock.writeWithSignal(`session-control:${sessionID}`, signal)
      : await Lock.write(`session-control:${sessionID}`)
    signal?.throwIfAborted()
    return await body()
  }

  export async function request(input: Input, options?: Admission): Promise<Result> {
    if (Storage.inTransaction()) throw new Error("Session continuation must own its commit boundary")
    input = Input.parse(input)
    const admission = { ...options, actor: ActorStamp.Info.optional().parse(options?.actor) }
    const initial = await controlled(input.sessionID, admission.signal, () => inspect(input))
    if ("result" in initial) return initial.result
    await SessionManager.waitForIdle(input.sessionID, admission.signal)
    return controlled(input.sessionID, admission.signal, async () => {
      const current = await inspect(input)
      if ("result" in current) return current.result
      if (current.session.paused?.since !== initial.session.paused?.since)
        return result(input.sessionID, "stale", "The session changed. Check its current state before continuing.")
      await SessionExecutionOwners.assertResume(current.session)
      return admit(input, current.session, admission)
    })
  }

  async function admit(input: Input, session: Session.Info, admission: Admission): Promise<Result> {
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
    const delivery = previous ?? nextTask ?? (!root ? queued[0] : undefined)
    let admitted = false
    let refusal: InstanceType<typeof RolloutAdmissionError> | undefined
    function reject(cause: unknown): never {
      if (refusal && cause === refusal) throw cause
      refusal = new RolloutAdmissionError({ message: "Session continuation admission failed" }, { cause })
      throw refusal
    }
    const apply = async (deliver: () => Promise<{ itemID: string; messageID: string }>) => {
      const commit = async () => {
        try {
          await Storage.transaction(
            async () => {
              admitted = false
              admission.signal?.throwIfAborted()
              await admission.validate?.()
              const current = await Session.get(session.id)
              if (current.time.archived) throw new ResumeChanged("blocked", "Archived sessions cannot continue.")
              if (
                current.paused?.since !== session.paused?.since ||
                current.resume?.requestID !== session.resume?.requestID
              )
                throw new ResumeChanged("stale", "The session changed. Check its current state before continuing.")
              const receipt = await deliver()
              const updated = await Session.update(session.id, (draft) => {
                draft.resume = {
                  requestID,
                  actor: admission.actor,
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
              await admission.record?.(ResumeInfo.parse(updated.resume))
              Storage.afterCommit(() => SessionManager.scheduleWake(session.id, "user-continue"))
              admitted = true
            },
            {
              commitGuard() {
                try {
                  admission.signal?.throwIfAborted()
                  admission.commitGuard?.()
                } catch (cause) {
                  reject(cause)
                }
              },
            },
          )
        } catch (cause) {
          reject(cause)
        }
      }
      if (resumeRoot) {
        const owner = RolloutLifecycle.owner(session)
        if (pending && SessionProgress.findTerminalReply(messages, resumeRoot.id))
          await RolloutLedger.continueRun(owner, resumeRoot.id, commit)
        if (!admitted) await RolloutLedger.resumeRun(owner, resumeRoot.id, commit)
      } else await Storage.transaction(commit)
    }
    try {
      if (delivery) await apply(async () => ({ itemID: delivery.id, messageID: delivery.messageID }))
      else
        await SessionInbox.withUniqueDelivery(
          {
            sessionID: session.id,
            deliveryKey: requestID,
            mode: "steer",
            message: {
              role: "user",
              actor: admission.actor,
              visible: false,
              origin: { type: "user", detail: "continue" },
              parts: [
                {
                  type: "text",
                  text: "Continue the current task from the saved progress. Preserve completed work and check uncertain operation results before retrying them.",
                },
              ],
            },
          },
          apply,
          admission.signal,
        )
    } catch (error) {
      if (!refusal || error !== refusal) throw error
      if (refusal.cause instanceof ResumeChanged)
        return result(session.id, refusal.cause.outcome, refusal.cause.message)
      throw refusal.cause
    }
    if (!admitted) return result(session.id, "blocked", "The task is completed or its execution evidence needs repair.")
    return result(session.id, "accepted")
  }
}
