import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { RolloutExecution } from "@ericsanchezok/synergy-harness/rollout"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"
import { SessionDecisionReceipts as Decisions } from "@ericsanchezok/synergy-harness/session/decision-receipts"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import z from "zod"

export const DEFAULT_TIMEOUT = ToolTimeout.DEFAULTS.questionMs / 1_000

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().max(12).describe("Very short label (max 12 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      allow_custom: z.boolean().optional().describe("Allow a custom free-form answer; defaults to true"),
      input_type: z
        .enum(["text", "password"])
        .optional()
        .describe("Direct input; password replies are redacted from lifecycle events"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
      timeout: z.number().optional().describe("Seconds before this question auto-expires"),
      createdAt: z.number().optional().describe("Unix timestamp (ms) when this question was asked"),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
        actor: ActorStamp.Info.optional(),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        actor: ActorStamp.Info.optional(),
      }),
    ),
    TimedOut: BusEvent.define(
      "question.timed_out",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = ScopedState.create(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
        decision?: { receipt: Decisions.Receipt; settle: () => Promise<void> }
      }
    > = {}

    return {
      pending,
    }
  })

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
    signal?: AbortSignal
  }): Promise<Answer[]> {
    return RolloutExecution.wait(() => askPending(input))
  }

  async function askPending(input: Parameters<typeof ask>[0]): Promise<Answer[]> {
    input.signal?.throwIfAborted()
    const s = await state()
    const id = Identifier.ascending("question")
    const createdAt = Date.now()

    log.info("asking", { id, questions: input.questions.length })

    const promise = new Promise<Answer[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
        timeout: DEFAULT_TIMEOUT,
        createdAt,
      }

      s.pending[id] = {
        info,
        resolve,
        reject,
      }

      Bus.publish(Event.Asked, info)
    })

    // Read config and adjust timeout asynchronously — pending entry is already visible with default timeout
    void (async () => {
      try {
        const cfg = await Config.current()
        const configuredTimeout = cfg.question?.timeout
        const timeout = configuredTimeout === 0 ? undefined : (configuredTimeout ?? DEFAULT_TIMEOUT)

        const existing = s.pending[id]
        if (!existing) return

        if (!timeout) {
          // User explicitly disabled timeout — clear it
          existing.info = { ...existing.info, timeout: undefined }
          return
        }

        if (timeout !== DEFAULT_TIMEOUT) {
          existing.info = { ...existing.info, timeout }
        }

        const timer = setTimeout(() => {
          const entry = s.pending[id]
          if (!entry) return
          delete s.pending[id]
          log.info("timed out", { id })
          Bus.publish(Event.TimedOut, {
            sessionID: input.sessionID,
            requestID: id,
          })
          entry.reject(new TimeoutError())
        }, timeout * 1000)

        const origResolve = existing.resolve
        const origReject = existing.reject
        existing.resolve = (answers) => {
          clearTimeout(timer)
          origResolve(answers)
        }
        existing.reject = (e) => {
          clearTimeout(timer)
          origReject(e)
        }
      } catch {
        // Config.current() failed — keep default timeout, question works without config
      }
    })()

    void import("@ericsanchezok/synergy-harness/session/manager")
      .then(({ SessionManager }) => SessionManager.getSession(input.sessionID))
      .then((session) => {
        const interaction = session?.interaction
        if (!SessionInteraction.isUnattended(interaction)) return
        const existing = s.pending[id]
        if (!existing) return
        delete s.pending[id]
        existing.reject(new UnattendedError(interaction?.source))
      })
      .catch((error) => {
        const existing = s.pending[id]
        if (!existing) return
        delete s.pending[id]
        log.error("failed to resolve session interaction", { sessionID: input.sessionID, error })
        existing.reject(error instanceof Error ? error : new Error(String(error)))
      })

    const onAbort = () => {
      const entry = s.pending[id]
      if (!entry) return
      delete s.pending[id]
      Bus.publish(Event.Rejected, { sessionID: input.sessionID, requestID: id })
      entry.reject(input.signal?.reason ?? new DOMException("Question cancelled", "AbortError"))
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    return promise.finally(() => input.signal?.removeEventListener("abort", onAbort))
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    await tryReply(input)
  }

  export async function tryReply(input: { requestID: string; answers: Answer[] }): Promise<boolean> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return false
    }
    const result = await decide({ ...input, sessionID: existing.info.sessionID, reply: "answer" })
    return result.status === "resolved"
  }

  export async function decide(input: {
    sessionID: string
    requestID: string
    reply: "answer" | "reject"
    answers?: Answer[]
    actor?: ActorStamp.Info
  }): Promise<Decisions.Result> {
    const s = await state()
    const scope = ScopeContext.current.scope
    return Storage.transaction(async () => {
      const prior = await reconcile(input)
      if (prior) return { status: "already_resolved", receipt: prior }
      const existing = s.pending[input.requestID]
      if (!existing || existing.info.sessionID !== input.sessionID) return { status: "expired" }
      const original = input.reply === "answer" ? z.array(Answer).parse(input.answers) : undefined
      const answers = original && redactAnswers(existing.info.questions, original)
      const receipt = await Decisions.record({
        sessionID: input.sessionID,
        requestID: input.requestID,
        actor: input.actor,
        outcome: { kind: "question", reply: input.reply, ...(answers ? { answers } : {}) },
      })
      const settle = () =>
        ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => {
            if (s.pending[input.requestID] !== existing) return
            delete s.pending[input.requestID]
            if (original && answers) {
              existing.resolve(original)
              log.info("replied", { requestID: input.requestID, answers })
              Bus.publish(Event.Replied, {
                sessionID: input.sessionID,
                requestID: input.requestID,
                answers,
                actor: input.actor,
              })
            } else {
              existing.reject(new RejectedError())
              log.info("rejected", { requestID: input.requestID })
              Bus.publish(Event.Rejected, {
                sessionID: input.sessionID,
                requestID: input.requestID,
                actor: input.actor,
              })
            }
          },
        })
      existing.decision = { receipt, settle }
      await Storage.transaction(
        async () => {
          Storage.afterCommit(settle)
        },
        {
          commitGuard() {
            if (s.pending[input.requestID] !== existing)
              throw new DOMException("Native question expired before commit", "AbortError")
          },
        },
      )
      return { status: "resolved", receipt }
    })
  }

  export function redactAnswers(questions: readonly Info[], answers: readonly Answer[]): Answer[] {
    return answers.map((answer, index) =>
      questions[index]?.input_type === "password" ? answer.map(() => "[redacted]") : [...answer],
    )
  }

  export async function reconcile(input: { sessionID: string; requestID: string }) {
    const s = await state()
    return Storage.transaction(async () => {
      const prior = await Decisions.read({ ...input, kind: "question" })
      const candidate = s.pending[input.requestID]?.decision
      if (prior && candidate && JSON.stringify(candidate.receipt) === JSON.stringify(prior))
        Storage.afterCommit(candidate.settle)
      return prior
    })
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    await decide({ sessionID: existing.info.sessionID, requestID, reply: "reject" })
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export class UnattendedError extends Error {
    constructor(source?: string) {
      super(
        source
          ? `This session is unattended (${source}) and cannot ask interactive questions.`
          : "This session is unattended and cannot ask interactive questions.",
      )
    }
  }

  export class TimeoutError extends Error {
    constructor() {
      super("Question timed out waiting for user response")
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
