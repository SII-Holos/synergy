import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { SessionManager } from "@/session/manager"
import { SessionInteraction } from "@/session/interaction"
import { Instance } from "@/scope/instance"
import { Log } from "@/util/log"
import z from "zod"

export const DEFAULT_TIMEOUT = 1800

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
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
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

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
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
  }): Promise<Answer[]> {
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
        createdAt,
      }

      s.pending[id] = {
        info,
        resolve,
        reject,
      }

      Bus.publish(Event.Asked, info)
    })

    // Read config and set timeout timer asynchronously — pending entry is already visible
    void (async () => {
      try {
        const cfg = await Config.get()
        const configuredTimeout = cfg.question?.timeout
        const timeout = configuredTimeout === 0 ? undefined : (configuredTimeout ?? DEFAULT_TIMEOUT)

        if (!timeout) return

        const existing = s.pending[id]
        if (!existing) return

        existing.info = { ...existing.info, timeout }

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
        // Config.get() failed — no timeout, question works without it
      }
    })()

    void SessionManager.getSession(input.sessionID).then((session) => {
      const interaction = session?.interaction
      if (!SessionInteraction.isUnattended(interaction)) return
      const existing = s.pending[id]
      if (!existing) return
      delete s.pending[id]
      existing.reject(new UnattendedError(interaction?.source))
    })

    return promise
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
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
