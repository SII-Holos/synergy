import { Provider } from "@/provider/provider"

import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."
import { SessionEvent } from "./event"

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Snapshot } from "@/session/snapshot"
import { SnapshotSchema } from "@/session/snapshot-schema"

import { Log } from "@/util/log"
import path from "path"
import { SessionManager } from "./manager"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Bus } from "@/bus"

import { LLM } from "./llm"
import { Agent } from "@/agent/agent"
import { Turn } from "./turn"
import { LoopJob } from "./loop-job"
import { SessionProgress } from "./progress"
import { withTimeout } from "@/util/timeout"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })
  const { asScopeID, asSessionID, asMessageID } = Identifier
  type SummaryInput = { sessionID: string; messageID: string }
  type ActiveSummary = { promise: Promise<void>; pending: SummaryInput[] }
  const active = new Map<string, ActiveSummary>()

  // Each summary LLM call is bounded so a stalled provider can never hang the
  // coalescing loop forever. AbortSignal.timeout aborts the request; the
  // per-run timeout below is a belt-and-suspenders guarantee that `active`
  // always clears even if some other await (or an SDK deadlock the abort
  // signal cannot interrupt) never settles.
  const SUMMARY_LLM_TIMEOUT_MS = 60_000
  const DEFAULT_SUMMARY_RUN_TIMEOUT_MS = 120_000
  function summaryRunTimeoutMs() {
    const env = Number.parseInt(process.env.SYNERGY_SUMMARY_TIMEOUT_MS ?? "", 10)
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_SUMMARY_RUN_TIMEOUT_MS
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      const current = active.get(input.sessionID)
      if (current) {
        if (!current.pending.some((item) => item.messageID === input.messageID)) current.pending.push(input)
        return current.promise
      }

      const pending = [input]
      const promise = Promise.resolve().then(() => runSummaries(input.sessionID))
      active.set(input.sessionID, { promise, pending })
      return promise
    },
  )

  async function runSummaries(sessionID: string) {
    try {
      while (true) {
        const state = active.get(sessionID)
        const current = state?.pending[0]
        if (!current) return
        await withTimeout(summarizeNow(current), summaryRunTimeoutMs(), {
          message: "summarize timed out",
        }).catch((error) => log.error("summarize failed", { sessionID, error }))
        state.pending.shift()
      }
    } finally {
      active.delete(sessionID)
    }
  }

  async function summarizeNow(input: SummaryInput) {
    const all = await Session.messages({ sessionID: input.sessionID })
    const diffCache = new Map<string, Promise<SnapshotSchema.FileDiff[]>>()
    const pendingWritten = Promise.withResolvers<void>()
    const messageSummary = summarizeMessage({
      messageID: input.messageID,
      messages: all,
      sessionID: input.sessionID,
      diffCache,
      onPending: pendingWritten.resolve,
    })
    await pendingWritten.promise
    const settled = await Promise.allSettled([
      summarizeSession({ sessionID: input.sessionID, messages: all, diffCache }),
      messageSummary,
    ])
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw failed.reason
  }

  async function summarizeSession(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
  }) {
    const session = await SessionManager.requireSession(input.sessionID)
    const directory = (session.scope as Scope).directory
    const scopeID = asScopeID((session.scope as Scope).id)
    const files = new Set(
      input.messages
        .flatMap((x) => x.parts)
        .filter((x) => x.type === "patch")
        .flatMap((x) => x.files)
        .map((x) => path.relative(directory, x)),
    )
    const diffs = await computeDiff({
      messages: input.messages,
      sessionID: input.sessionID,
      cache: input.diffCache,
    }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)), diffs)
    Bus.publish(SessionEvent.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  type UserSummary = NonNullable<MessageV2.User["summary"]>

  async function updateSummary(input: SummaryInput, patch: Partial<UserSummary>) {
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const fresh = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)),
    )
    if (!fresh || fresh.role !== "user") return
    fresh.summary = {
      diffs: fresh.summary?.diffs ?? [],
      ...fresh.summary,
      ...patch,
    }
    return (await Session.updateMessage(fresh)) as MessageV2.User
  }

  function diffErrorCode(error: unknown): Extract<UserSummary["diffState"], { status: "error" }>["code"] {
    if (error instanceof DOMException && error.name === "TimeoutError") return "timeout"
    if (error instanceof Error && /timeout|timed out/i.test(error.message)) return "timeout"
    if (error instanceof Error && /git|snapshot|diff/i.test(`${error.name} ${error.message}`)) return "git_failure"
    return "unknown"
  }

  async function summarizeMessage(input: {
    messageID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
    onPending: () => void
  }) {
    let pendingNotified = false
    const notifyPending = () => {
      if (pendingNotified) return
      pendingNotified = true
      input.onPending()
    }

    try {
      const turn = Turn.collectOne(input.messages, input.messageID)
      if (!turn) return
      const messages = [turn.user, ...turn.assistants]
      const msgWithParts = turn.user
      const userMsg = msgWithParts.info as MessageV2.User
      if (!MessageV2.isPromptVisible(msgWithParts)) return

      let latestUser = await updateSummary(
        { sessionID: input.sessionID, messageID: input.messageID },
        {
          diffState: {
            status: "pending",
            deadlineAt: Date.now() + summaryRunTimeoutMs(),
          },
        },
      )
      notifyPending()

      let diffs: SnapshotSchema.FileDiff[] | undefined
      try {
        diffs = await computeDiff({ messages, sessionID: input.sessionID, cache: input.diffCache })
        latestUser = await updateSummary(
          { sessionID: input.sessionID, messageID: input.messageID },
          { diffs, diffState: { status: "ready" } },
        )
      } catch (error) {
        latestUser = await updateSummary(
          { sessionID: input.sessionID, messageID: input.messageID },
          { diffState: { status: "error", code: diffErrorCode(error) } },
        )
      }

      const assistantMsg = messages.find((message) => message.info.role === "assistant")?.info as
        | MessageV2.Assistant
        | undefined
      if (!assistantMsg) return

      const textPart = msgWithParts.parts.find((part) => part.type === "text" && !MessageV2.isSystemPart(part)) as
        | MessageV2.TextPart
        | undefined
      const hasStepFinish = messages.some(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.some((part) => part.type === "step-finish" && part.reason !== "tool-calls"),
      )
      const needsBody = diffs !== undefined && hasStepFinish && diffs.length > 0
      const needsTitle = Boolean(textPart && !latestUser?.summary?.title)
      if (!needsTitle && !needsBody) return

      const fallbackModel = await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID)
      const llmUser = latestUser ?? userMsg

      const generateTitle = async (): Promise<string | undefined> => {
        if (!needsTitle || !textPart) return undefined
        const agent = await Agent.get("title")
        const agentModel = await Agent.getAvailableModel(agent)
        const stream = await LLM.stream({
          agent,
          user: llmUser,
          tools: {},
          model: agentModel ? await Provider.getModel(agentModel.providerID, agentModel.modelID) : fallbackModel,
          small: true,
          messages: [
            {
              role: "user" as const,
              content: `The following is the text to summarize:\n<text>\n${textPart.text ?? ""}\n</text>`,
            },
          ],
          abort: AbortSignal.timeout(SUMMARY_LLM_TIMEOUT_MS),
          sessionID: userMsg.sessionID,
          system: [],
          retries: 3,
        })
        const result = await LLM.collectText(stream).catch((error) => {
          log.error("failed to generate summary title", { error })
          return undefined
        })
        if (result) log.info("title", { title: result })
        return result
      }

      const generateBody = async (): Promise<string | undefined> => {
        if (!needsBody) return undefined
        const prunedMessages = structuredClone(messages)
        for (const message of prunedMessages) {
          for (const part of message.parts) {
            if (part.type === "tool" && part.state.status === "completed") {
              part.state.output = "[TOOL OUTPUT PRUNED]"
            }
          }
        }
        const summaryAgent = await Agent.get("summary")
        const summaryAgentModel = await Agent.getAvailableModel(summaryAgent)
        const stream = await LLM.stream({
          agent: summaryAgent,
          user: llmUser,
          tools: {},
          model: summaryAgentModel
            ? await Provider.getModel(summaryAgentModel.providerID, summaryAgentModel.modelID)
            : fallbackModel,
          small: true,
          messages: [
            ...MessageV2.toModelMessage(prunedMessages),
            {
              role: "user" as const,
              content: `Summarize the above conversation according to your system prompts.`,
            },
          ],
          abort: AbortSignal.timeout(SUMMARY_LLM_TIMEOUT_MS),
          sessionID: userMsg.sessionID,
          system: [],
          retries: 3,
        })
        return LLM.collectText(stream).catch((error) => {
          log.error("failed to generate summary body", { error })
          return undefined
        })
      }

      const [title, body] = await Promise.all([generateTitle(), generateBody()])
      if (!title && !body) return
      await updateSummary(
        { sessionID: input.sessionID, messageID: input.messageID },
        {
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
        },
      )
    } finally {
      notifyPending()
    }
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const session = await SessionManager.requireSession(input.sessionID)
      const scopeID = asScopeID((session.scope as Scope).id)
      return Storage.read<SnapshotSchema.FileDiff[]>(
        StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)),
      ).catch(() => [])
    },
  )

  async function computeDiff(input: {
    messages: MessageV2.WithParts[]
    sessionID: string
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
  }) {
    const range = diffRange(input.messages)
    if (!range) return []
    const key = `${range.from}:${range.to}`
    let cached = input.cache.get(key)
    if (!cached) {
      cached = Snapshot.diffSummary(range.from, range.to, input.sessionID)
      input.cache.set(key, cached)
    }
    return cached
  }

  function diffRange(messages: MessageV2.WithParts[]) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
          break
        }
      }
    }

    if (from && to) return { from, to }
    return undefined
  }
}

LoopJob.register({
  type: "summarize",
  phase: "post",
  blocking: false,
  collect(ctx) {
    if (!ctx.lastAssistant || !SessionProgress.isTerminalAssistant(ctx.lastAssistant)) return []
    return [{ type: "summarize" }]
  },
  async execute(ctx) {
    await SessionSummary.summarize({
      sessionID: ctx.sessionID,
      messageID: ctx.lastUser.id,
    })
    return "pass"
  },
})
