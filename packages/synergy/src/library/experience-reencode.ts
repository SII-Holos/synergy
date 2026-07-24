import { randomUUID } from "crypto"
import type { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { Turn } from "../session/turn"
import { SessionMemoryPressure } from "../session/memory-pressure"
import { Config } from "../config/config"
import { Global } from "../global"
import { Log } from "../util/log"
import { LibraryDB } from "./database"
import { detect, type Candidate } from "./experience-detect"
import { ExperienceEncoder } from "./experience-encoder"
import { TurnDigest } from "./turn-digest"

export namespace ExperienceReencode {
  export type JobType = LibraryDB.ReencodeJob.Type
  export type JobStatus = LibraryDB.ReencodeJob.Status
  export type ItemStatus = LibraryDB.ReencodeJob.ItemStatus

  export interface JobItem {
    id: string
    sessionID: string
    scopeID: string
    status: ItemStatus
    reason?: string
  }

  export interface JobState {
    id: string
    status: JobStatus
    type: JobType
    reason: string | null
    totalCount: number
    okCount: number
    skippedCount: number
    failedCount: number
    completedCount: number
    startedAt: number
    completedAt: number | null
    error: string | null
    items: JobItem[]
  }

  export type JobSummary = Omit<JobState, "items">

  export interface JobItemUpdate extends JobItem {
    updatedAt: number
  }

  const controllers = new Map<string, AbortController>()
  const running = new Map<string, Promise<void>>()
  const cancelling = new Set<string>()
  const log = Log.create({ service: "library.reencode" })
  const DEFAULT_PRESSURE_POLL_MS = 30_000

  function pressurePollMs() {
    const configured = Number(process.env.SYNERGY_REENCODE_PRESSURE_POLL_MS)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PRESSURE_POLL_MS
  }

  function toSummary(row: LibraryDB.ReencodeJob.Row): JobSummary {
    return {
      id: row.id,
      status: row.status,
      type: row.type,
      reason: row.reason,
      totalCount: row.total_count,
      okCount: row.ok_count,
      skippedCount: row.skipped_count,
      failedCount: row.failed_count,
      completedCount: row.ok_count + row.skipped_count + row.failed_count,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
    }
  }

  function toState(row: LibraryDB.ReencodeJob.Row): JobState {
    const items = LibraryDB.ReencodeJob.items(row.id).map(
      (item): JobItem => ({
        id: item.experience_id,
        sessionID: item.session_id,
        scopeID: item.scope_id,
        status: item.status,
        ...(item.result_reason ? { reason: item.result_reason } : {}),
      }),
    )
    return { ...toSummary(row), items }
  }

  export function createJob(input: { type: JobType; reason?: string; candidates: Candidate[] }): JobState {
    const startedAt = Date.now()
    const row = LibraryDB.ReencodeJob.create({
      id: randomUUID(),
      type: input.type,
      reason: input.reason,
      candidates: input.candidates,
      startedAt,
    })
    if (input.candidates.length === 0) {
      LibraryDB.ReencodeJob.finish(row.id, "completed")
      return get(row.id)!
    }
    return toState(row)
  }
  export function start(input: { type: JobType; reason?: string }): JobSummary {
    const result = detect(Global.Path.libraryDB)
    const candidates = (input.type === "intent" ? result.intent : result.script).filter(
      (candidate) => !input.reason || candidate.reason === input.reason,
    )
    const state = createJob({ ...input, candidates })
    if (state.status === "running") launch(state.id)
    const { items: _, ...summary } = state
    return summary
  }

  export function get(id: string): JobState | undefined {
    const row = LibraryDB.ReencodeJob.get(id)
    return row ? toState(row) : undefined
  }

  export function getSummary(id: string): JobSummary | undefined {
    const row = LibraryDB.ReencodeJob.get(id)
    return row ? toSummary(row) : undefined
  }

  export function current(): JobState | undefined {
    const row = LibraryDB.ReencodeJob.current()
    return row ? toState(row) : undefined
  }

  export function currentSummary(): JobSummary | undefined {
    const row = LibraryDB.ReencodeJob.current()
    return row ? toSummary(row) : undefined
  }

  export function terminalItemsSince(id: string, updatedAt: number): JobItemUpdate[] {
    return LibraryDB.ReencodeJob.terminalItemsSince(id, updatedAt).map((item) => ({
      id: item.experience_id,
      sessionID: item.session_id,
      scopeID: item.scope_id,
      status: item.status,
      ...(item.result_reason ? { reason: item.result_reason } : {}),
      updatedAt: item.updated_at,
    }))
  }

  export async function cancel(id: string): Promise<JobSummary> {
    const row = LibraryDB.ReencodeJob.get(id)
    if (!row) throw new Error(`Experience reencode job not found: ${id}`)
    if (row.status !== "running") throw new Error(`Experience reencode job is not running: ${id}`)
    cancelling.add(id)
    controllers.get(id)?.abort()
    try {
      await running.get(id)
      LibraryDB.ReencodeJob.cancel(id)
      return getSummary(id)!
    } finally {
      cancelling.delete(id)
    }
  }

  function launch(jobID: string) {
    const pending = run(jobID)
    running.set(jobID, pending)
    void pending.finally(() => {
      if (running.get(jobID) === pending) running.delete(jobID)
    })
  }

  type LoadedSession = {
    session: NonNullable<Awaited<ReturnType<typeof Session.get>>>
    messages: MessageV2.WithParts[]
  }

  async function loadSession(sessionID: string): Promise<LoadedSession | undefined> {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session || session.parentID) return undefined
    const messages = await Session.messages({ sessionID })
    return { session, messages }
  }

  async function loadSessionInfo(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => undefined)
    return session && !session.parentID ? session : undefined
  }

  function isCritical(snapshot: SessionMemoryPressure.Snapshot) {
    const thresholds = SessionMemoryPressure.resolveThresholds(process.env, snapshot)
    return (
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersCriticalBytes ||
      (snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes
    )
  }

  type PressureGate = () => Promise<boolean>

  function createPressureGate(jobID: string): PressureGate {
    let paused = false
    return async () => {
      const snapshot = await SessionMemoryPressure.currentSnapshotWithCgroup()
      const thresholds = SessionMemoryPressure.resolveThresholds(process.env, snapshot)
      const decision = SessionMemoryPressure.decide({
        snapshot,
        thresholds,
        now: Date.now(),
        lastGCAt: 0,
        gcAvailable: typeof Bun.gc === "function",
      })
      if (paused !== decision.critical) {
        paused = decision.critical
        log.info(paused ? "reencode paused for memory pressure" : "reencode resumed after memory pressure", {
          jobID,
          memory: snapshot,
          thresholds,
        })
      }
      return decision.critical
    }
  }

  async function relieveMemoryPressure(input: {
    sessionID: string
    signal: AbortSignal
    pressureGate: PressureGate
    pressurePollMs: number
  }) {
    const before = await SessionMemoryPressure.currentSnapshotWithCgroup()
    if (isCritical(before)) {
      await SessionMemoryPressure.maybeCollect({
        sessionID: input.sessionID,
        phase: "library.reencode.after_session",
      })
    }
    return waitForPressureRelief(input)
  }

  type PendingItem = {
    item: LibraryDB.ReencodeJob.ItemRow
    experience: LibraryDB.Experience.Row | null
    content: LibraryDB.Experience.ContentRow | null
  }

  async function processItem(input: {
    job: LibraryDB.ReencodeJob.Row
    pending: PendingItem
    learning: Required<Config.Learning>
    signal: AbortSignal
    loaded?: LoadedSession | null
  }) {
    const { job, pending, learning, signal } = input
    const { item, experience, content } = pending
    const reencodeLearning = { ...learning, encoderRetries: 0 }
    if (signal.aborted) return
    if (!LibraryDB.ReencodeJob.markItemProcessing(job.id, item.experience_id)) return
    try {
      if (!experience) {
        LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "experience-gone")
        return
      }

      const storedUserText =
        content?.user_input ?? (content?.raw ? TurnDigest.userTextFromRendered(content.raw) : undefined)
      const repairingFailedExperience = experience.reward_status === "encoding_failed"
      const requiresHistory = repairingFailedExperience || (job.type === "intent" && !storedUserText)
      let loaded = input.loaded
      if (requiresHistory && loaded === undefined) {
        loaded =
          (await withStageRetry({
            retries: learning.reencodeRetries,
            backoffMs: learning.reencodeRetryBackoffMs,
            signal,
            operation: () => loadSession(item.session_id),
          })) ?? null
      }
      if (requiresHistory) {
        if (!loaded) {
          LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "session-gone")
          return
        }
        if (loaded.messages.length === 0) {
          LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "msg-missing")
          return
        }
      } else if (job.type === "script") {
        const session = await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () => loadSessionInfo(item.session_id),
        })
        if (!session) {
          LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "session-gone")
          return
        }
      }

      const history = loaded ?? undefined
      if (repairingFailedExperience) {
        if (!history) throw new Error("session history unavailable for failed experience repair")
        const outcome = await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () =>
            ExperienceEncoder.repairFailedExperience(item.session_id, item.experience_id, {
              learning: reencodeLearning,
              session: history.session,
              messages: history.messages,
              signal,
            }),
        })
        LibraryDB.ReencodeJob.finishItem(
          job.id,
          item.experience_id,
          outcome.encoded ? "ok" : "skipped",
          outcome.encoded ? undefined : "repair-skipped",
        )
        return
      }

      if (job.type === "intent") {
        const messages = history?.messages ?? []
        const userText = Turn.resolveUserText(messages, item.experience_id) ?? storedUserText
        if (!userText) {
          LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "user-input-unavailable")
          return
        }
        const result = await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () =>
            ExperienceEncoder.reencodeIntent(
              item.session_id,
              item.experience_id,
              messages,
              reencodeLearning,
              signal,
              userText,
            ),
        })
        await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () => LibraryDB.Experience.updateIntent(item.experience_id, result.intent, result.embedding),
        })
      } else {
        if (!content?.raw) {
          LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "skipped", "no-raw-content")
          return
        }
        const result = await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () =>
            ExperienceEncoder.reencodeScript(
              item.session_id,
              item.experience_id,
              content.raw!,
              reencodeLearning,
              signal,
            ),
        })
        await withStageRetry({
          retries: learning.reencodeRetries,
          backoffMs: learning.reencodeRetryBackoffMs,
          signal,
          operation: () =>
            LibraryDB.Experience.updateScript(item.experience_id, result.script, result.embedding, content.raw!),
        })
      }
      LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "ok")
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      LibraryDB.ReencodeJob.finishItem(job.id, item.experience_id, "failed", message)
      log.warn("reencode item failed", { jobID: job.id, experienceID: item.experience_id, error: message })
    }
  }

  function partitionItems(job: LibraryDB.ReencodeJob.Row, items: LibraryDB.ReencodeJob.ItemRow[]) {
    const direct: PendingItem[] = []
    const sessions = new Map<string, PendingItem[]>()
    for (const item of items) {
      const experience = LibraryDB.Experience.get(item.experience_id)
      const content = experience ? LibraryDB.Experience.getContent(item.experience_id) : null
      const pending = { item, experience, content }
      const storedUserText =
        content?.user_input ?? (content?.raw ? TurnDigest.userTextFromRendered(content.raw) : undefined)
      const requiresHistory =
        experience?.reward_status === "encoding_failed" || (job.type === "intent" && !storedUserText)
      if (!experience || !requiresHistory) {
        direct.push(pending)
        continue
      }
      const group = sessions.get(item.session_id)
      if (group) group.push(pending)
      else sessions.set(item.session_id, [pending])
    }
    return { direct, sessions }
  }

  async function run(jobID: string) {
    const job = LibraryDB.ReencodeJob.get(jobID)
    if (!job || job.status !== "running") return
    const controller = new AbortController()
    controllers.set(jobID, controller)
    try {
      const learning = await ExperienceEncoder.loadLearning()
      const { direct, sessions } = partitionItems(job, LibraryDB.ReencodeJob.pendingItems(jobID))
      const pollMs = pressurePollMs()
      const pressureGate = createPressureGate(jobID)
      await runPool({
        items: direct,
        concurrency: learning.reencodeConcurrency,
        signal: controller.signal,
        pressureGate,
        pressurePollMs: pollMs,
        process: (pending) => processItem({ job, pending, learning, signal: controller.signal }),
      })
      for (const [sessionID, items] of sessions) {
        if (!(await waitForPressureRelief({ signal: controller.signal, pressureGate, pressurePollMs: pollMs }))) break
        const loaded =
          (await withStageRetry({
            retries: learning.reencodeRetries,
            backoffMs: learning.reencodeRetryBackoffMs,
            signal: controller.signal,
            operation: () => loadSession(sessionID),
          })) ?? null
        for (const pending of items) {
          if (controller.signal.aborted) break
          await processItem({ job, pending, learning, signal: controller.signal, loaded })
        }
        if (
          !(await relieveMemoryPressure({
            sessionID,
            signal: controller.signal,
            pressureGate,
            pressurePollMs: pollMs,
          }))
        ) {
          break
        }
      }
      const latest = LibraryDB.ReencodeJob.get(jobID)
      if (latest?.status === "running" && !cancelling.has(jobID)) {
        LibraryDB.ReencodeJob.finish(jobID, "completed")
      }
    } catch (error) {
      const latest = LibraryDB.ReencodeJob.get(jobID)
      if (latest?.status === "running" && !cancelling.has(jobID)) {
        LibraryDB.ReencodeJob.finish(jobID, "failed", error instanceof Error ? error.message : String(error))
      }
    } finally {
      controllers.delete(jobID)
    }
  }

  export async function runPool<T>(input: {
    items: T[]
    concurrency: number
    signal: AbortSignal
    pressureGate?: () => boolean | Promise<boolean>
    pressurePollMs?: number
    process: (item: T) => Promise<void>
  }): Promise<void> {
    let cursor = 0
    const workerCount = Math.min(Math.max(1, input.concurrency), input.items.length)
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!input.signal.aborted && cursor < input.items.length) {
          if (!(await waitForPressureRelief(input))) return
          if (input.signal.aborted || cursor >= input.items.length) return
          const index = cursor++
          await input.process(input.items[index])
        }
      }),
    )
  }

  async function waitForPressureRelief(input: {
    signal: AbortSignal
    pressureGate?: () => boolean | Promise<boolean>
    pressurePollMs?: number
  }): Promise<boolean> {
    while (!input.signal.aborted && input.pressureGate && (await input.pressureGate())) {
      try {
        await sleep(Math.max(1, input.pressurePollMs ?? DEFAULT_PRESSURE_POLL_MS), input.signal)
      } catch (error) {
        if (input.signal.aborted) return false
        throw error
      }
    }
    return !input.signal.aborted
  }

  function isTransient(error: unknown) {
    const details = error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown }
    const code = String(details?.code)
    if (details?.name === "TimeoutError") return true
    if (
      [
        "SQLITE_BUSY",
        "SQLITE_LOCKED",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "REENCODE_INVALID_OUTPUT",
        "oversized",
        "timeout",
      ].includes(code)
    ) {
      return true
    }
    const status = Number(details?.status ?? details?.statusCode)
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true
    const message = error instanceof Error ? error.message : String(error)
    return /database is locked|temporarily unavailable|connection reset|connection refused|socket hang up|rate limit|too many requests|service unavailable|bad gateway|gateway timeout|operation timed out|request timed out/i.test(
      message,
    )
  }

  async function sleep(ms: number, signal: AbortSignal) {
    if (ms <= 0) return
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve()
      }, ms)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      timeout.unref?.()
    })
  }

  export async function withStageRetry<T>(input: {
    retries: number
    backoffMs: number
    signal: AbortSignal
    operation: () => T | Promise<T>
  }): Promise<T> {
    let attempt = 0
    while (true) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError")
      try {
        return await input.operation()
      } catch (error) {
        if (!isTransient(error) || attempt >= input.retries) throw error
        attempt++
        await sleep(input.backoffMs * 2 ** (attempt - 1), input.signal)
      }
    }
  }
}
