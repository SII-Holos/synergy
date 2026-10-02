import { RuntimeContext } from "../lifecycle/context"
import { Provider } from "../provider/provider"

import { fn } from "../util/fn"
import z from "zod"
import { Session } from "."
import { SessionEvent } from "./event"

import { MessageV2 } from "./message-v2"
import { Identifier } from "../id/id"
import { Snapshot } from "./snapshot"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotRanges } from "./snapshot-ranges"

import { Log } from "../util/log"
import { SessionManager } from "./manager"
import { Scope } from "../scope"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Bus } from "../bus"

import { AgentCall } from "../agent/call"
import { LoopJob } from "./loop-job"
import { SessionProgress } from "./progress"
import { RolloutRecordingError } from "./rollout/error"
import { SessionHistory } from "./history"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })
  const { asScopeID, asSessionID, asMessageID } = Identifier
  type SummaryInput = {
    sessionID: string
    messageID: string
    revisionID?: string
    diffOnly?: boolean
    messages?: MessageV2.WithParts[]
    signal?: AbortSignal
  }
  type QueuedSummaryInput = SummaryInput & { historyRevision: number }
  type ActiveSummary = { promise: Promise<void>; pending: QueuedSummaryInput[] }
  const SummaryCursor = z.object({
    version: z.literal(4),
    ranges: z.array(SnapshotRanges.Range),
  })
  type SummaryCursor = z.infer<typeof SummaryCursor>
  const runtimeState = RuntimeContext.state(() => ({
    active: new Map<string, ActiveSummary>(),
  }))

  // Snapshot and LLM work receive the per-run abort signal so the queue only
  // advances after the active worker has fully settled.
  const SUMMARY_LLM_TIMEOUT_MS = 60_000
  const DEFAULT_SUMMARY_RUN_TIMEOUT_MS = 120_000
  function summaryRunTimeoutMs() {
    const env = Number.parseInt(RuntimeContext.current().host.env.SYNERGY_SUMMARY_TIMEOUT_MS ?? "", 10)
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

  function compactQueuedMessages(messages: MessageV2.WithParts[], rootMessageID: string) {
    const turn = collectRootTurn(messages, rootMessageID)
    if (!turn) return
    return [turn.user, ...turn.assistants]
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      revisionID: z.string().optional(),
      diffOnly: z.boolean().optional(),
      messages: z.custom<MessageV2.WithParts[]>().optional(),
      signal: z.instanceof(AbortSignal).optional(),
    }),
    async (input) => {
      const instanceState = runtimeState()

      const historyRevision = SessionManager.historyRevision(input.sessionID)
      const current = instanceState.active.get(input.sessionID)
      if (current) {
        const key = input.revisionID ?? input.messageID
        const queued = current.pending.some(
          (item) => (item.revisionID ?? item.messageID) === key && !!item.diffOnly === !!input.diffOnly,
        )
        if (!queued) {
          current.pending.push({
            sessionID: input.sessionID,
            messageID: input.messageID,
            revisionID: input.revisionID,
            diffOnly: input.diffOnly,
            messages: input.messages ? compactQueuedMessages(input.messages, input.messageID) : undefined,
            signal: input.signal,
            historyRevision,
          })
        }
        return current.promise
      }

      const pending: QueuedSummaryInput[] = [{ ...input, historyRevision }]
      const promise = Promise.resolve().then(() => runSummaries(input.sessionID))
      instanceState.active.set(input.sessionID, { promise, pending })
      return promise
    },
  )

  async function runSummaries(sessionID: string) {
    const instanceState = runtimeState()

    try {
      while (true) {
        const state = instanceState.active.get(sessionID)
        const current = state?.pending[0]
        if (!current) return
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          summaryRunTimeoutMs(),
        )
        timeout.unref()
        const abort = current.signal ? AbortSignal.any([controller.signal, current.signal]) : controller.signal
        try {
          await summarizeNow(current, abort)
        } catch (error) {
          if (RolloutRecordingError.isInstance(error)) {
            SessionManager.signalAbort(sessionID, { rootID: current.messageID })
            throw error
          }
          if (abort.aborted && abort.reason instanceof DOMException && abort.reason.name === "TimeoutError") {
            await markPendingSummaryTimedOut(current)
          }
          log.error("summarize failed", { sessionID, error })
        } finally {
          clearTimeout(timeout)
        }
        state.pending.shift()
      }
    } finally {
      instanceState.active.delete(sessionID)
    }
  }

  async function summarizeNow(input: QueuedSummaryInput, abort: AbortSignal) {
    const completeHistory = input.messages === undefined
    const all = input.messages
      ? await Promise.all(
          input.messages.map(async (message) => {
            if (
              !message.parts.some(
                (part) =>
                  part.type === "patch" &&
                  (part.operation?.status === "pending" || part.checkpoint?.status === "pending"),
              )
            )
              return message
            return MessageV2.get({ sessionID: input.sessionID, messageID: message.info.id })
          }),
        )
      : input.diffOnly
        ? await SessionHistory.rawMessages({ sessionID: input.sessionID })
        : await SessionHistory.detachedModelMessages({ sessionID: input.sessionID, signal: abort })
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
      diffOnly: input.diffOnly,
    })
    await pendingWritten.promise
    const settled = await Promise.allSettled([
      summarizeSession({
        sessionID: input.sessionID,
        messages: all,
        completeHistory,
        diffCache,
        historyRevision: input.historyRevision,
        abort,
      }),
      messageSummary,
    ])
    throwRejected(settled)
  }

  function throwRejected(results: PromiseSettledResult<unknown>[]) {
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    const failure = failures.find((result) => RolloutRecordingError.isInstance(result.reason)) ?? failures[0]
    if (failure) throw failure.reason
  }

  async function summarizeSession(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
    completeHistory: boolean
    diffCache: Map<string, Promise<SnapshotSchema.FileDiff[]>>
    historyRevision: number
    abort: AbortSignal
  }) {
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) return
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = asScopeID((session.scope as Scope).id)
    let cursor = await readSummaryCursor(scopeID, input.sessionID)
    if (!cursor) {
      const history = await cursorHistory(input, session)
      cursor = cursorFromMessages(history)
    }
    cursor = mergeSummaryCursor(cursor, input.messages)
    const compared = await compareRanges(cursor.ranges, input.sessionID, input.diffCache, input.abort)
    const previous = await Storage.read<SnapshotSchema.FileDiff[]>(
      StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)),
    ).catch(() => [])
    const diffs = retainAvailable(compared, previous)
    input.abort.throwIfAborted()
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) return
    let applied = false
    await Session.update(input.sessionID, (draft) => {
      if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) return
      draft.summary = {
        diffState: compared.state,
        diffIssues: compared.issues,
        additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
        deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
        files: new Set(diffs.map((diff) => JSON.stringify([SnapshotRanges.key(diff), diff.file]))).size,
      }
      applied = true
    })
    if (!applied) return
    input.abort.throwIfAborted()
    await Promise.all([
      Storage.write(StoragePath.sessionSummary(scopeID, asSessionID(input.sessionID)), diffs),
      Storage.write(StoragePath.sessionSummaryCursor(scopeID, asSessionID(input.sessionID)), cursor),
    ])
    input.abort.throwIfAborted()
    if (input.historyRevision !== SessionManager.historyRevision(input.sessionID)) {
      await invalidateDerivedState(input.sessionID, scopeID)
      return
    }
    Bus.publish(SessionEvent.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function cursorHistory(
    input: Pick<Parameters<typeof summarizeSession>[0], "sessionID" | "messages" | "completeHistory">,
    session: Session.Info,
  ) {
    if (input.completeHistory) return input.messages
    if (session.summary !== undefined) return SessionHistory.rawMessages({ sessionID: input.sessionID })
    const snapshotIDs = new Set(input.messages.map((message) => message.info.id))
    const infos = await SessionHistory.messageInfos(input.sessionID)
    if (infos.some((info) => !snapshotIDs.has(info.id))) {
      return SessionHistory.rawMessages({ sessionID: input.sessionID })
    }
    return input.messages
  }

  function cursorFromMessages(messages: MessageV2.WithParts[]): SummaryCursor {
    return { version: 4, ranges: SnapshotRanges.fromMessages(messages) }
  }

  function mergeSummaryCursor(cursor: SummaryCursor, messages: MessageV2.WithParts[]): SummaryCursor {
    return { version: 4, ranges: SnapshotRanges.merge(cursor.ranges, SnapshotRanges.fromMessages(messages)) }
  }

  export async function invalidateDerivedState(sessionID: string, scopeID?: Identifier.ScopeID) {
    const resolvedScopeID = scopeID ?? asScopeID(((await SessionManager.requireSession(sessionID)).scope as Scope).id)
    await Promise.all([
      Session.update(sessionID, (draft) => {
        draft.summary = undefined
      }),
      Storage.remove(StoragePath.sessionSummary(resolvedScopeID, asSessionID(sessionID))),
      Storage.remove(StoragePath.sessionSummaryCursor(resolvedScopeID, asSessionID(sessionID))),
    ])
  }

  async function readSummaryCursor(scopeID: Identifier.ScopeID, sessionID: string) {
    return Storage.read<unknown>(StoragePath.sessionSummaryCursor(scopeID, asSessionID(sessionID)))
      .then((value) => SummaryCursor.parse(value))
      .catch(() => undefined)
  }

  async function compareRanges(
    ranges: SnapshotRanges.Range[],
    sessionID: string,
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>,
    abort: AbortSignal,
  ) {
    const diffs: SnapshotSchema.FileDiff[] = []
    const issues: z.infer<typeof SnapshotSchema.Issue>[] = []
    const unavailable = new Set<string>()
    let valid = 0
    let pending = false
    for (const range of SnapshotRanges.net(ranges)) {
      pending ||= range.pending === true
      if (range.incomplete && !range.pending)
        issues.push({ workspace: range.workspace, code: range.issue ?? "capture_failed" })
      if (!range.from || !range.to) {
        unavailable.add(SnapshotRanges.key(range))
        if (!range.pending && !range.incomplete)
          issues.push({ workspace: range.workspace, code: "baseline_unavailable" })
        continue
      }
      try {
        const candidates = await computeSnapshotDiff(range, sessionID, cache, abort)
        const omitted = new Set(range.omissions?.map((item) => item.file))
        for (const item of range.omissions ?? []) {
          if (item.reason === "read_failed" || candidates.some((diff) => diff.file === item.file)) {
            if (
              !issues.some(
                (issue) =>
                  issue.file === item.file &&
                  issue.workspace?.id === range.workspace?.id &&
                  issue.workspace?.generation === range.workspace?.generation,
              )
            )
              issues.push({ workspace: range.workspace, file: item.file, code: item.reason })
          }
        }
        diffs.push(...candidates.filter((diff) => !omitted.has(diff.file)))
        valid++
      } catch (error) {
        abort.throwIfAborted()
        log.warn("workspace comparison failed", { workspaceID: range.workspace?.id, error })
        issues.push({ workspace: range.workspace, code: "comparison_failed" })
        unavailable.add(SnapshotRanges.key(range))
      }
    }
    const state: z.infer<typeof SnapshotSchema.DiffState> = pending
      ? { status: "pending", deadlineAt: Date.now() + summaryRunTimeoutMs() }
      : issues.length
        ? {
            status: valid ? "partial" : "error",
            code: issues.every((issue) => issue.code === "comparison_failed") ? "git_failure" : "incomplete",
          }
        : { status: "ready" }
    return { diffs: SnapshotSchema.boundArray(diffs), issues, unavailable, state }
  }

  function retainAvailable(compared: Awaited<ReturnType<typeof compareRanges>>, previous: SnapshotSchema.FileDiff[]) {
    return SnapshotSchema.boundArray([
      ...compared.diffs,
      ...previous.filter((diff) => compared.unavailable.has(SnapshotRanges.key(diff))),
    ])
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
    diffOnly?: boolean
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
        const compared = await compareRanges(
          SnapshotRanges.fromMessages(messages),
          input.sessionID,
          input.diffCache,
          input.abort,
        )
        diffs = retainAvailable(compared, latestUser?.summary?.diffs ?? [])
        latestUser = await updateSummary(
          { sessionID: input.sessionID, messageID: input.messageID },
          { diffs, diffState: compared.state, diffIssues: compared.issues },
          input.abort,
        )
      } catch (error) {
        if (input.abort.aborted) throw abortError(input.abort)
        latestUser = await updateSummary(
          { sessionID: input.sessionID, messageID: input.messageID },
          { diffState: { status: "error", code: diffErrorCode(error) } },
        )
      }

      if (input.diffOnly) return
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
      const needsBody =
        diffs !== undefined && hasStepFinish && diffs.length > 0 && latestUser?.summary?.diffState?.status === "ready"
      const needsTitle = Boolean(textPart && !latestUser?.summary?.title)
      if (!needsTitle && !needsBody) return

      const fallbackModel = await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID)
      const llmUser = latestUser ?? userMsg

      const generateTitle = async (): Promise<string | undefined> => {
        if (!needsTitle || !textPart) return undefined
        const result = await AgentCall.text({
          agent: "title",
          user: llmUser,
          sessionId: userMsg.sessionID,
          fallbackModel,
          signal: input.abort,
          timeoutMs: SUMMARY_LLM_TIMEOUT_MS,
          retries: 3,
          maxOutputChars: 200,
          messages: [
            {
              role: "user" as const,
              content: `The following is the text to summarize:\n<text>\n${textPart.text ?? ""}\n</text>`,
            },
          ],
        }).catch((error) => {
          if (RolloutRecordingError.isInstance(error)) {
            SessionManager.signalAbort(input.sessionID, { rootID: input.messageID })
            throw error
          }
          if (input.abort.aborted) throw abortError(input.abort)
          log.error("failed to generate summary title", { error })
          return undefined
        })
        const title = result?.text
        if (title) log.info("title", { title })
        return title
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
        const result = await AgentCall.text({
          agent: "summary",
          user: llmUser,
          sessionId: userMsg.sessionID,
          fallbackModel,
          signal: input.abort,
          timeoutMs: SUMMARY_LLM_TIMEOUT_MS,
          retries: 3,
          maxOutputChars: 20_000,
          messages: [
            ...MessageV2.toModelMessage(prunedMessages),
            {
              role: "user" as const,
              content: `Summarize the above conversation according to your system prompts.`,
            },
          ],
        }).catch((error) => {
          if (RolloutRecordingError.isInstance(error)) {
            SessionManager.signalAbort(input.sessionID, { rootID: input.messageID })
            throw error
          }
          if (input.abort.aborted) throw abortError(input.abort)
          log.error("failed to generate summary body", { error })
          return undefined
        })
        return result?.text
      }

      const results = await Promise.allSettled([generateTitle(), generateBody()])
      throwRejected(results)
      const [title, body] = results.map((result) => (result.status === "fulfilled" ? result.value : undefined))
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

  function computeSnapshotDiff(
    range: SnapshotRanges.Range,
    sessionID: string,
    cache: Map<string, Promise<SnapshotSchema.FileDiff[]>>,
    abort: AbortSignal,
  ) {
    if (!range.from || !range.to) return Promise.resolve([])
    const key = JSON.stringify([SnapshotRanges.key(range), range.operationID, range.from, range.to])
    let cached = cache.get(key)
    if (!cached) {
      cached = Snapshot.diffSummary(range.from, range.to, sessionID, abort).then((diffs) =>
        diffs
          .filter((diff) => !range.operationID || range.files.includes(diff.file))
          .map((diff) => ({
            ...diff,
            ...(range.operationID ? { operationID: range.operationID } : {}),
            ...(range.workspace
              ? { workspace: range.workspace }
              : range.legacyRoot
                ? { legacyRoot: range.legacyRoot }
                : {}),
          })),
      )
      cache.set(key, cached)
    }
    return abortable(cached, abort)
  }
}

export function registerSummaryJob() {
  LoopJob.register({
    type: "summarize",
    phase: "post",
    blocking: false,
    detached: true,
    collect(ctx) {
      if (!ctx.lastAssistant || !SessionProgress.isTerminalAssistant(ctx.lastAssistant)) return []
      return [{ type: "summarize" }]
    },
    capture(ctx) {
      return {
        type: "summarize",
        sessionID: ctx.sessionID,
        messageID: ctx.lastUser.id,
        revisionID: ctx.lastAssistant?.id,
        diffOnly: false,
      }
    },
    timeoutMs: 180_000,
    async execute(input, signal) {
      await SessionSummary.summarize({
        sessionID: input.sessionID,
        messageID: input.messageID,
        revisionID: input.revisionID,
        diffOnly: input.diffOnly,
        signal,
      })
      return "pass"
    },
  })
}
