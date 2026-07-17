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
  type SummaryInput = {
    sessionID: string
    messageID: string
    messages?: MessageV2.WithParts[]
  }
  type QueuedSummaryInput = SummaryInput & { historyRevision: number }
  const SummaryCursor = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    files: z.array(z.string()),
  })
  type SummaryCursor = z.infer<typeof SummaryCursor>
  const active = new Map<string, { promise: Promise<void>; next?: QueuedSummaryInput }>()

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

  function enqueueSummary(input: SummaryInput) {
    const queued = { ...input, historyRevision: SessionManager.historyRevision(input.sessionID) }
    const pending = active.get(input.sessionID)
    if (pending) {
      pending.next = queued
      return pending.promise
    }
    const task = Promise.resolve().then(() => runSummaries(queued))
    active.set(input.sessionID, { promise: task })
    return task
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    enqueueSummary,
  )

  export function summarizeFromLoop(input: SummaryInput & { messages: MessageV2.WithParts[] }) {
    return enqueueSummary(input)
  }

  async function runSummaries(input: QueuedSummaryInput) {
    try {
      let current: QueuedSummaryInput | undefined = input
      while (current) {
        // Isolate per-iteration failures: a throw here (e.g. the session was
        // removed mid-run, a storage hiccup) must not abandon the coalescing
        // loop. If it did, `active` would keep a rejected entry that later
        // summarize() calls attach `next` to but nothing ever drains —
        // permanently wedging summarization for the session.
        await withTimeout(summarizeNow(current), summaryRunTimeoutMs(), {
          message: "summarize timed out",
        }).catch((error) => log.error("summarize failed", { sessionID: input.sessionID, error }))
        const state = active.get(input.sessionID)
        current = state?.next
        if (state) state.next = undefined
      }
    } finally {
      active.delete(input.sessionID)
    }
  }

  async function summarizeNow(input: QueuedSummaryInput) {
    const completeHistory = input.messages === undefined
    const messages = input.messages ?? (await Session.messages({ sessionID: input.sessionID }))
    const diffCache = new Map<string, Promise<SnapshotSchema.FileDiff[]>>()
    const results = await Promise.allSettled([
      summarizeSession({
        sessionID: input.sessionID,
        messages,
        completeHistory,
        diffCache,
        historyRevision: input.historyRevision,
      }),
      summarizeMessage({ messageID: input.messageID, messages, sessionID: input.sessionID, diffCache }),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
  }

  async function summarizeSession(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
    completeHistory: boolean
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
    historyRevision: number
  }) {
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) return
    const session = await SessionManager.requireSession(input.sessionID)
    const directory = (session.scope as Scope).directory
    const scopeID = asScopeID((session.scope as Scope).id)
    let cursor = await readSummaryCursor(scopeID, input.sessionID)
    if (!cursor) {
      const history = input.completeHistory ? input.messages : await Session.messages({ sessionID: input.sessionID })
      cursor = cursorFromMessages(history, directory)
    }
    cursor = mergeSummaryCursor(cursor, input.messages, directory)
    const files = new Set(cursor.files)
    const diffs = (await computeCursorDiff(cursor, input.sessionID, input.diffCache)).filter((diff) =>
      files.has(diff.file),
    )
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) return
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Promise.all([
      Storage.write(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)), diffs),
      Storage.write(StoragePath.sessionSummaryCursor(scopeID, asSessionID(input.sessionID)), cursor),
    ])
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) {
      await Storage.remove(StoragePath.sessionSummaryCursor(scopeID, asSessionID(input.sessionID)))
      return
    }
    Bus.publish(SessionEvent.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  function cursorFromMessages(messages: MessageV2.WithParts[], directory: string): SummaryCursor {
    const range = diffRange(messages)
    return {
      from: range?.from,
      to: range?.to,
      files: summaryFiles(messages, directory),
    }
  }

  function mergeSummaryCursor(cursor: SummaryCursor, messages: MessageV2.WithParts[], directory: string) {
    const next = cursorFromMessages(messages, directory)
    return {
      from: cursor.from ?? next.from,
      to: next.to ?? cursor.to,
      files: Array.from(new Set([...cursor.files, ...next.files])),
    }
  }

  function summaryFiles(messages: MessageV2.WithParts[], directory: string) {
    return messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "patch")
      .flatMap((part) => part.files)
      .map((file) => path.relative(directory, file))
  }

  async function readSummaryCursor(scopeID: Identifier.ScopeID, sessionID: string) {
    return Storage.read<unknown>(StoragePath.sessionSummaryCursor(scopeID, asSessionID(sessionID)))
      .then((value) => SummaryCursor.parse(value))
      .catch(() => undefined)
  }

  function computeCursorDiff(
    cursor: SummaryCursor,
    sessionID: string,
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>,
  ) {
    if (!cursor.from || !cursor.to) return Promise.resolve([])
    return computeSnapshotDiff({ from: cursor.from, to: cursor.to }, sessionID, cache)
  }

  async function saveSummary(userMsg: MessageV2.User) {
    const session = await SessionManager.requireSession(userMsg.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const fresh = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(scopeID, asSessionID(userMsg.sessionID), asMessageID(userMsg.id)),
    )
    if (fresh) {
      fresh.summary = userMsg.summary
      await Session.updateMessage(fresh)
    } else {
      await Session.updateMessage(userMsg)
    }
  }

  function sameDiffs(a: SnapshotSchema.FileDiff[] | undefined, b: SnapshotSchema.FileDiff[]) {
    if ((a?.length ?? 0) !== b.length) return false
    return b.every((next, index) => {
      const previous = a?.[index]
      if (!previous) return false
      return (
        previous.file === next.file &&
        previous.additions === next.additions &&
        previous.deletions === next.deletions &&
        previous.binary === next.binary &&
        previous.preview === next.preview &&
        previous.beforeBytes === next.beforeBytes &&
        previous.afterBytes === next.afterBytes &&
        previous.truncated === next.truncated
      )
    })
  }

  async function summarizeMessage(input: {
    messageID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
  }) {
    const turn = Turn.collectOne(input.messages, input.messageID)
    if (!turn) return
    const messages = [turn.user, ...turn.assistants]
    const msgWithParts = turn.user
    const userMsg = msgWithParts.info as MessageV2.User
    if (!MessageV2.isPromptVisible(msgWithParts)) return
    const diffs = await computeDiff({ messages, sessionID: input.sessionID, cache: input.diffCache })
    const diffsChanged = !sameDiffs(userMsg.summary?.diffs, diffs)
    userMsg.summary = {
      ...userMsg.summary,
      diffs,
    }

    const assistantMsg = messages.find((m) => m.info.role === "assistant")?.info as MessageV2.Assistant | undefined
    if (!assistantMsg) {
      await saveSummary(userMsg)
      return
    }

    const textPart = msgWithParts.parts.find((p) => p.type === "text" && !MessageV2.isSystemPart(p)) as
      | MessageV2.TextPart
      | undefined
    const hasStepFinish = messages.some(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "step-finish" && p.reason !== "tool-calls"),
    )
    const needsBody = hasStepFinish && diffs.length > 0
    const needsTitle = textPart && !userMsg.summary?.title
    if (!needsTitle && !needsBody) {
      if (diffsChanged) await saveSummary(userMsg)
      return
    }
    const fallbackModel = await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID)

    const generateTitle = async (): Promise<string | undefined> => {
      if (!needsTitle || !textPart) return undefined
      const agent = await Agent.get("title")
      const agentModel = await Agent.getAvailableModel(agent)
      const stream = await LLM.stream({
        agent,
        user: userMsg,
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
      const result = await LLM.collectText(stream).catch((err) => {
        log.error("failed to generate summary title", { error: err })
        return undefined
      })
      if (result) log.info("title", { title: result })
      return result
    }

    const generateBody = async (): Promise<string | undefined> => {
      if (!needsBody) return undefined
      const prunedMessages = structuredClone(messages)
      for (const msg of prunedMessages) {
        for (const part of msg.parts) {
          if (part.type === "tool" && part.state.status === "completed") {
            part.state.output = "[TOOL OUTPUT PRUNED]"
          }
        }
      }
      const summaryAgent = await Agent.get("summary")
      const summaryAgentModel = await Agent.getAvailableModel(summaryAgent)
      const stream = await LLM.stream({
        agent: summaryAgent,
        user: userMsg,
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
      return LLM.collectText(stream).catch((err) => {
        log.error("failed to generate summary body", { error: err })
        return undefined
      })
    }

    const [title, body] = await Promise.all([generateTitle(), generateBody()])

    if (title) userMsg.summary.title = title
    if (body) userMsg.summary.body = body

    // Only persist when summary content changed. Diffs are included because
    // session-turn diff cards read them from the persisted user message summary.
    if (title || body || diffsChanged) {
      await saveSummary(userMsg)
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
    return computeSnapshotDiff(range, input.sessionID, input.cache)
  }

  function computeSnapshotDiff(
    range: { from: string; to: string },
    sessionID: string,
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>,
  ) {
    const key = `${range.from}:${range.to}`
    let cached = cache.get(key)
    if (!cached) {
      cached = Snapshot.diffSummary(range.from, range.to, sessionID)
      cache.set(key, cached)
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
    await SessionSummary.summarizeFromLoop({
      sessionID: ctx.sessionID,
      messageID: ctx.lastUser.id,
      messages: ctx.messages,
    })
    return "pass"
  },
})
