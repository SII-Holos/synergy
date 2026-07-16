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
import { LoopJob } from "./loop-job"
import { SessionProgress } from "./progress"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })
  const { asScopeID, asSessionID, asMessageID } = Identifier
  type SummaryInput = {
    sessionID: string
    messageID: string
    revisionID?: string
    messages?: MessageV2.WithParts[]
  }
  type ActiveSummary = { promise: Promise<void>; pending: SummaryInput[] }
  const active = new Map<string, ActiveSummary>()

  // Snapshot and LLM work receive the per-run abort signal so the queue only
  // advances after the active worker has fully settled.
  const SUMMARY_LLM_TIMEOUT_MS = 60_000
  const DEFAULT_SUMMARY_RUN_TIMEOUT_MS = 120_000
  function summaryRunTimeoutMs() {
    const env = Number.parseInt(process.env.SYNERGY_SUMMARY_TIMEOUT_MS ?? "", 10)
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_SUMMARY_RUN_TIMEOUT_MS
  }

  function abortError(signal: AbortSignal) {
    if (signal.reason instanceof Error) return signal.reason
    return new DOMException("Summary aborted", "AbortError")
  }

  function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      promise.catch(() => {})
      return Promise.reject(abortError(signal))
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        promise.catch(() => {})
        reject(abortError(signal))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  function collectRootTurn(messages: MessageV2.WithParts[], rootMessageID: string) {
    const rootIndex = messages.findIndex((message) => message.info.role === "user" && message.info.id === rootMessageID)
    if (rootIndex < 0) return
    const user = messages[rootIndex]
    const assistants: MessageV2.WithParts[] = []
    for (let index = rootIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      if (message.info.role === "user" && message.info.isRoot === true) break
      if (message.info.role === "assistant" && message.info.rootID === rootMessageID) assistants.push(message)
    }
    return { user, assistants }
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      revisionID: z.string().optional(),
      messages: z.custom<MessageV2.WithParts[]>().optional(),
    }),
    async (input) => {
      const current = active.get(input.sessionID)
      if (current) {
        const key = input.revisionID ?? input.messageID
        const queued = current.pending.some((item) => (item.revisionID ?? item.messageID) === key)
        if (!queued) {
          current.pending.push({
            sessionID: input.sessionID,
            messageID: input.messageID,
            revisionID: input.revisionID,
          })
        }
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
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          summaryRunTimeoutMs(),
        )
        try {
          await summarizeNow(current, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) await markPendingSummaryTimedOut(current)
          log.error("summarize failed", { sessionID, error })
        } finally {
          clearTimeout(timeout)
        }
        state.pending.shift()
      }
    } finally {
      active.delete(sessionID)
    }
  }

  async function summarizeNow(input: SummaryInput, abort: AbortSignal) {
    const all = input.messages ?? (await Session.messages({ sessionID: input.sessionID }))
    abort.throwIfAborted()
    const diffCache = new Map<string, Promise<SnapshotSchema.FileDiff[]>>()
    const pendingWritten = Promise.withResolvers<void>()
    const messageSummary = summarizeMessage({
      messageID: input.messageID,
      messages: all,
      sessionID: input.sessionID,
      diffCache,
      abort,
      onPending: pendingWritten.resolve,
    })
    await pendingWritten.promise
    const settled = await Promise.allSettled([
      summarizeSession({ sessionID: input.sessionID, messages: all, diffCache, abort }),
      messageSummary,
    ])
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw failed.reason
  }

  async function summarizeSession(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
    abort: AbortSignal
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
      abort: input.abort,
    }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    input.abort.throwIfAborted()
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    input.abort.throwIfAborted()
    await Storage.write(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)), diffs)
    input.abort.throwIfAborted()
    Bus.publish(SessionEvent.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  type UserSummary = NonNullable<MessageV2.User["summary"]>

  async function markPendingSummaryTimedOut(input: SummaryInput) {
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const fresh = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)),
    )
    if (!fresh || fresh.role !== "user" || fresh.summary?.diffState?.status !== "pending") return
    fresh.summary = {
      ...fresh.summary,
      diffState: { status: "error", code: "timeout" },
    }
    await Session.updateMessage(fresh)
  }

  async function updateSummary(input: SummaryInput, patch: Partial<UserSummary>, abort?: AbortSignal) {
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    const fresh = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(scopeID, asSessionID(input.sessionID), asMessageID(input.messageID)),
    )
    if (!fresh || fresh.role !== "user") return
    abort?.throwIfAborted()
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
    abort: AbortSignal
    onPending: () => void
  }) {
    let pendingNotified = false
    const notifyPending = () => {
      if (pendingNotified) return
      pendingNotified = true
      input.onPending()
    }

    try {
      const turn = collectRootTurn(input.messages, input.messageID)
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
        input.abort,
      )
      notifyPending()

      let diffs: SnapshotSchema.FileDiff[] | undefined
      try {
        diffs = await computeDiff({
          messages,
          sessionID: input.sessionID,
          cache: input.diffCache,
          abort: input.abort,
        })
        latestUser = await updateSummary(
          { sessionID: input.sessionID, messageID: input.messageID },
          { diffs, diffState: { status: "ready" } },
          input.abort,
        )
      } catch (error) {
        if (input.abort.aborted) throw abortError(input.abort)
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
          abort: AbortSignal.any([input.abort, AbortSignal.timeout(SUMMARY_LLM_TIMEOUT_MS)]),
          sessionID: userMsg.sessionID,
          system: [],
          retries: 3,
        })
        const result = await LLM.collectText(stream).catch((error) => {
          if (input.abort.aborted) throw abortError(input.abort)
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
          abort: AbortSignal.any([input.abort, AbortSignal.timeout(SUMMARY_LLM_TIMEOUT_MS)]),
          sessionID: userMsg.sessionID,
          system: [],
          retries: 3,
        })
        return LLM.collectText(stream).catch((error) => {
          if (input.abort.aborted) throw abortError(input.abort)
          log.error("failed to generate summary body", { error })
          return undefined
        })
      }

      const [title, body] = await Promise.all([
        abortable(generateTitle(), input.abort),
        abortable(generateBody(), input.abort),
      ])
      if (!title && !body) return
      await updateSummary(
        { sessionID: input.sessionID, messageID: input.messageID },
        {
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
        },
        input.abort,
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
      const diffs = await Storage.read<SnapshotSchema.FileDiff[]>(
        StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)),
      ).catch(() => [])
      return SnapshotSchema.normalizeArray(diffs) ?? []
    },
  )

  async function computeDiff(input: {
    messages: MessageV2.WithParts[]
    sessionID: string
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
    abort: AbortSignal
  }) {
    const range = diffRange(input.messages)
    if (!range) return []
    const key = `${range.from}:${range.to}`
    let cached = input.cache.get(key)
    if (!cached) {
      cached = Snapshot.diffSummary(range.from, range.to, input.sessionID, input.abort)
      input.cache.set(key, cached)
    }
    return abortable(cached, input.abort)
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
      revisionID: ctx.lastAssistant?.id,
      messages: ctx.messages.slice(),
    })
    return "pass"
  },
})
