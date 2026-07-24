import type { ChildProcess } from "child_process"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { Observability } from "../observability"
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityRedaction } from "@/observability/redaction"
import { ProcessInspection as OwnedProcessInspection } from "./inspection"

const log = Log.create({ service: "process.registry" })

const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_OUTPUT_CHARS = 200_000
const TAIL_CHARS = 2000

const OUTPUT_SEGMENT_CHARS = 4096

class BoundedTextBuffer {
  private segments: string[] = []
  private head = 0
  private headOffset = 0
  private pending: string[] = []
  private pendingLength = 0
  private retainedLength = 0

  get length() {
    return this.retainedLength
  }

  append(input: string, maxChars: number) {
    if (input.length === 0) return false

    let offset = 0
    while (offset < input.length) {
      const available = OUTPUT_SEGMENT_CHARS - this.pendingLength
      const take = Math.min(available, input.length - offset)
      this.pending.push(input.slice(offset, offset + take))
      this.pendingLength += take
      this.retainedLength += take
      offset += take
      if (this.pendingLength === OUTPUT_SEGMENT_CHARS) this.flushPending()
    }

    const limit = Math.max(0, Math.floor(maxChars))
    let overflow = this.retainedLength - limit
    if (overflow <= 0) return false

    while (overflow > 0 && this.head < this.segments.length) {
      const segment = this.segments[this.head]
      const available = segment.length - this.headOffset
      const removed = Math.min(available, overflow)
      this.headOffset += removed
      this.retainedLength -= removed
      overflow -= removed
      if (this.headOffset === segment.length) {
        this.head++
        this.headOffset = 0
      }
    }

    if (overflow > 0) {
      const pending = this.pending.join("").slice(overflow)
      this.pending = pending ? [pending] : []
      this.pendingLength = pending.length
      this.retainedLength -= overflow
    }

    this.compactSegments()
    return true
  }

  text() {
    if (this.retainedLength === 0) return ""
    const result: string[] = []
    for (let index = this.head; index < this.segments.length; index++) {
      const segment = this.segments[index]
      result.push(index === this.head && this.headOffset > 0 ? segment.slice(this.headOffset) : segment)
    }
    if (this.pendingLength > 0) result.push(this.pending.join(""))
    return result.join("")
  }

  tail(maxChars: number) {
    let remaining = Math.min(maxChars, this.retainedLength)
    if (remaining === 0) return ""

    const result: string[] = []
    if (this.pendingLength > 0) {
      const pending = this.pending.join("")
      result.push(pending.slice(-remaining))
      remaining -= Math.min(remaining, pending.length)
    }
    for (let index = this.segments.length - 1; index >= this.head && remaining > 0; index--) {
      const segment =
        index === this.head && this.headOffset > 0 ? this.segments[index].slice(this.headOffset) : this.segments[index]
      result.push(segment.slice(-remaining))
      remaining -= Math.min(remaining, segment.length)
    }
    return result.reverse().join("")
  }

  stats() {
    return {
      segments: this.segments.length - this.head + (this.pendingLength > 0 ? 1 : 0),
      allocatedSegments: this.segments.length + (this.pendingLength > 0 ? 1 : 0),
    }
  }

  private flushPending() {
    if (this.pendingLength === 0) return
    this.segments.push(this.pending.join(""))
    this.pending = []
    this.pendingLength = 0
  }

  private compactSegments() {
    if (this.head >= this.segments.length) {
      this.segments = []
      this.head = 0
      this.headOffset = 0
      return
    }
    if (this.head < 64 || this.head * 2 < this.segments.length) return
    this.segments.splice(0, this.head)
    this.head = 0
  }
}

export namespace ProcessRegistry {
  export type Status = "running" | "completed" | "failed" | "killed"

  export interface Stdin {
    write: (data: string, cb?: (err?: Error | null) => void) => void
    end: () => void
    destroyed?: boolean
  }

  export interface Process {
    id: string
    command: string
    description?: string
    cwd?: string
    pid?: number
    child?: ChildProcess
    stdin?: Stdin
    startedAt: number
    maxOutputChars: number
    output: string
    tail: string
    truncated: boolean
    exitCode?: number | null
    exitSignal?: NodeJS.Signals | number | null
    exited: boolean
    backgrounded: boolean
    lastOutputAt?: number
    stdioState: "open" | "draining" | "closed"
    exitObservedAt?: number
    stdioClosedAt?: number
    drainTimedOut?: boolean
    drainGraceMs?: number
    timedOut?: boolean
    currentRssBytes?: number
    baselineRssBytes?: number
    peakRssBytes?: number
  }

  export interface FinishedProcess {
    id: string
    command: string
    description?: string
    cwd?: string
    status: Status
    startedAt: number
    endedAt: number
    exitCode?: number | null
    exitSignal?: NodeJS.Signals | number | null
    output: string
    tail: string
    truncated: boolean
    stdioState: "closed"
    exitObservedAt?: number
    stdioClosedAt?: number
    drainTimedOut?: boolean
    drainGraceMs?: number
    timedOut?: boolean
    baselineRssBytes?: number
    peakRssBytes?: number
  }

  export interface ProcessInspection {
    alive?: boolean
    rssBytes?: number
  }

  export interface ResourceSnapshot {
    id: string
    command: string
    description?: string
    cwd?: string
    pid?: number
    startedAt: number
    ageMs: number
    backgrounded: boolean
    outputChars: number
    truncated: boolean
    lastOutputAt?: number
    alive?: boolean
    rssBytes?: number
    stdioState: "open" | "draining" | "closed"
    exitObservedAt?: number
    stdioClosedAt?: number
    drainTimedOut?: boolean
    drainGraceMs?: number
    timedOut?: boolean
  }

  export type ProcessInspector = (pid: number, proc: Process) => ProcessInspection

  const running = new Map<string, Process>()
  const finished = new Map<string, FinishedProcess>()
  const outputBuffers = new WeakMap<Process, BoundedTextBuffer>()
  const terminators = new WeakMap<Process, () => void | Promise<void>>()
  let sweeper: Timer | null = null
  let ttlMs = DEFAULT_TTL_MS
  let processInspector: ProcessInspector = defaultProcessInspector
  let lastRecovery:
    | {
        action: "close"
        reason: "process_exit"
        at: number
        beforeBytes?: number
        afterBytes: number
        reclaimedBytes?: number
        timedOut: boolean
      }
    | undefined

  export function create(opts: {
    command: string
    description?: string
    cwd?: string
    child?: ChildProcess
    stdin?: Stdin
  }): Process {
    const id = Identifier.short("process")
    const outputBuffer = new BoundedTextBuffer()
    const proc: Process = {
      id,
      command: opts.command,
      description: opts.description,
      cwd: opts.cwd,
      child: opts.child,
      stdin: opts.stdin,
      pid: opts.child?.pid,
      startedAt: Date.now(),
      maxOutputChars: MAX_OUTPUT_CHARS,
      get output() {
        return outputBuffer.text()
      },
      get tail() {
        return outputBuffer.tail(TAIL_CHARS)
      },
      truncated: false,
      exited: false,
      backgrounded: false,
      stdioState: "open",
    }
    outputBuffers.set(proc, outputBuffer)
    running.set(id, proc)
    startSweeper()
    log.info("process created", { id, commandFamily: ObservabilityRedaction.commandFamily(opts.command) })
    void Observability.emit("process.created", {
      processId: id,
      pid: proc.pid,
      cwd: opts.cwd,
      data: {
        command: ObservabilityRedaction.commandSummary(opts.command),
        description: opts.description,
      },
    })
    return proc
  }

  export function get(id: string): Process | undefined {
    return running.get(id)
  }

  export function getFinished(id: string): FinishedProcess | undefined {
    return finished.get(id)
  }

  export function setTerminator(proc: Process, terminate: (() => void | Promise<void>) | undefined) {
    if (terminate) terminators.set(proc, terminate)
    else terminators.delete(proc)
  }

  export async function terminate(proc: Process, opts?: { allowExitedParent?: boolean }) {
    const terminate = terminators.get(proc)
    if (terminate) {
      await terminate()
      return
    }
    if (!proc.child) return
    const { Shell } = await import("../util/shell")
    await Shell.killTree(proc.child, {
      exited: () => proc.exited,
      allowExitedParent: opts?.allowExitedParent,
    })
  }
  export function appendOutput(proc: Process, chunk: string) {
    const outputBuffer = outputBuffers.get(proc)
    if (!outputBuffer) throw new Error(`Process output buffer is unavailable: ${proc.id}`)
    proc.truncated = outputBuffer.append(chunk, proc.maxOutputChars) || proc.truncated
    proc.lastOutputAt = Date.now()
    ObservabilityMetrics.record({
      name: "process.output.chars",
      value: chunk.length,
      unit: "count",
      module: "process",
      source: "process",
      processId: proc.id,
      pid: proc.pid,
      labels: { backgrounded: proc.backgrounded, truncated: proc.truncated },
    })
  }

  export function markBackgrounded(proc: Process) {
    proc.backgrounded = true
    log.info("process backgrounded", { id: proc.id })
    void Observability.emit("process.backgrounded", {
      processId: proc.id,
      pid: proc.pid,
      cwd: proc.cwd,
      data: {
        command: ObservabilityRedaction.commandSummary(proc.command),
      },
    })
  }

  export function markExitObserved(proc: Process, input: { drainGraceMs: number; timedOut: boolean }) {
    proc.stdioState = "draining"
    proc.exitObservedAt = Date.now()
    proc.drainGraceMs = input.drainGraceMs
    proc.timedOut = input.timedOut
  }

  export function markStdioClosed(proc: Process, input: { drainTimedOut: boolean }) {
    proc.stdioState = "closed"
    proc.stdioClosedAt = Date.now()
    proc.drainTimedOut = input.drainTimedOut
  }

  export function markExited(proc: Process, exitCode: number | null, exitSignal: NodeJS.Signals | number | null) {
    proc.exited = true
    proc.exitCode = exitCode
    proc.exitSignal = exitSignal
    terminators.delete(proc)

    const status: Status =
      exitSignal === "SIGKILL" || exitSignal === "SIGTERM" ? "killed" : exitCode === 0 ? "completed" : "failed"

    // A fast-exiting process may finish before the auto-background timer fires.
    // Always persist the completed process in the finished registry so callers
    // scanning both registries can find it even without the backgrounded flag.
    running.delete(proc.id)
    finished.set(proc.id, {
      id: proc.id,
      command: proc.command,
      description: proc.description,
      cwd: proc.cwd,
      status,
      startedAt: proc.startedAt,
      endedAt: Date.now(),
      exitCode,
      exitSignal,
      output: proc.output,
      tail: proc.tail,
      truncated: proc.truncated,
      stdioState: "closed",
      exitObservedAt: proc.exitObservedAt,
      stdioClosedAt: proc.stdioClosedAt,
      drainTimedOut: proc.drainTimedOut,
      drainGraceMs: proc.drainGraceMs,
      timedOut: proc.timedOut,
      baselineRssBytes: proc.baselineRssBytes,
      peakRssBytes: proc.peakRssBytes,
    })
    lastRecovery = {
      action: "close",
      reason: "process_exit",
      at: Date.now(),
      beforeBytes: proc.currentRssBytes,
      afterBytes: 0,
      reclaimedBytes: proc.currentRssBytes,
      timedOut: proc.timedOut ?? false,
    }

    ObservabilityMetrics.record({
      name: "process.duration",
      value: Date.now() - proc.startedAt,
      unit: "ms",
      module: "process",
      source: "process",
      processId: proc.id,
      pid: proc.pid,
      labels: { status, exitCode: exitCode ?? null, exitSignal: exitSignal ? String(exitSignal) : null },
    })
    log.info("process exited", { id: proc.id, status, exitCode, exitSignal })
    void Observability.emit("process.exit", {
      processId: proc.id,
      pid: proc.pid,
      cwd: proc.cwd,
      level: status === "failed" ? "error" : "info",
      data: {
        status,
        command: ObservabilityRedaction.commandSummary(proc.command),
        exitCode,
        exitSignal,
        outputChars: outputChars(proc),
      },
    })
  }

  export function remove(id: string) {
    const proc = running.get(id)
    running.delete(id)
    if (proc) terminators.delete(proc)
    finished.delete(id)
    if (proc) {
      void Observability.emit("process.removed", {
        processId: proc.id,
        pid: proc.pid,
        cwd: proc.cwd,
        data: {
          command: ObservabilityRedaction.commandSummary(proc.command),
          outputChars: outputChars(proc),
        },
      })
    }
  }

  export function listRunning(): Process[] {
    return Array.from(running.values()).filter((s) => s.backgrounded)
  }

  export function listActive(): Process[] {
    return Array.from(running.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  export function listFinished(): FinishedProcess[] {
    return Array.from(finished.values())
  }

  export function listAll(): Array<Process | FinishedProcess> {
    return [...listRunning(), ...listFinished()].sort((a, b) => b.startedAt - a.startedAt)
  }

  export function resourceSnapshot(opts: { now?: number; settleStale?: boolean } = {}): ResourceSnapshot[] {
    const now = opts.now ?? Date.now()
    const result: ResourceSnapshot[] = []
    for (const proc of Array.from(running.values())) {
      if (proc.exited) continue
      const inspection = inspect(proc)
      if (inspection.rssBytes !== undefined) {
        proc.currentRssBytes = inspection.rssBytes
        proc.baselineRssBytes =
          proc.baselineRssBytes === undefined
            ? inspection.rssBytes
            : Math.min(proc.baselineRssBytes, inspection.rssBytes)
        proc.peakRssBytes = Math.max(proc.peakRssBytes ?? 0, inspection.rssBytes)
      }
      if (opts.settleStale && proc.pid !== undefined && inspection.alive === false) {
        markStale(proc)
        continue
      }
      result.push({
        id: proc.id,
        command: proc.command,
        description: proc.description,
        cwd: proc.cwd,
        pid: proc.pid,
        startedAt: proc.startedAt,
        ageMs: now - proc.startedAt,
        backgrounded: proc.backgrounded,
        outputChars: outputChars(proc),
        truncated: proc.truncated,
        lastOutputAt: proc.lastOutputAt,
        alive: inspection.alive,
        rssBytes: inspection.rssBytes,
        stdioState: proc.stdioState,
        exitObservedAt: proc.exitObservedAt,
        stdioClosedAt: proc.stdioClosedAt,
        drainTimedOut: proc.drainTimedOut,
        drainGraceMs: proc.drainGraceMs,
        timedOut: proc.timedOut,
      })
    }
    return result.sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1) || b.startedAt - a.startedAt)
  }

  export function settleStaleProcesses() {
    resourceSnapshot({ settleStale: true })
  }

  export function resourceStats() {
    const processes = resourceSnapshot()
    const measured = processes.filter((entry) => entry.rssBytes !== undefined)
    const owned = [...running.values()].filter((entry) => !entry.exited)
    return {
      processCount: processes.length,
      measuredProcessCount: measured.length,
      currentBytes: measured.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0),
      baselineBytes: owned.reduce((sum, entry) => sum + (entry.baselineRssBytes ?? 0), 0),
      peakBytes: owned.reduce((sum, entry) => sum + (entry.peakRssBytes ?? 0), 0),
      retainedBytes: owned.reduce(
        (sum, entry) =>
          sum + Math.max(0, (entry.currentRssBytes ?? 0) - (entry.baselineRssBytes ?? entry.currentRssBytes ?? 0)),
        0,
      ),
      stdio: {
        open: owned.filter((entry) => entry.stdioState === "open").length,
        draining: owned.filter((entry) => entry.stdioState === "draining").length,
        closed: owned.filter((entry) => entry.stdioState === "closed").length,
        timedOut: owned.filter((entry) => entry.timedOut).length,
        drainTimedOut: owned.filter((entry) => entry.drainTimedOut).length,
        descendantPipeGraceMs: Math.max(0, ...owned.map((entry) => entry.drainGraceMs ?? 0)),
      },
      lastRecovery,
    }
  }

  export function setProcessInspector(inspector: ProcessInspector) {
    const previous = processInspector
    processInspector = inspector
    return () => {
      processInspector = previous
    }
  }

  function pruneExpired() {
    const cutoff = Date.now() - ttlMs
    for (const [id, proc] of finished.entries()) {
      if (proc.endedAt < cutoff) {
        finished.delete(id)
        log.info("process pruned", { id })
      }
    }
  }

  function startSweeper() {
    if (sweeper) return
    sweeper = setInterval(pruneExpired, Math.max(30_000, ttlMs / 6))
    if (typeof sweeper === "object" && "unref" in sweeper) {
      sweeper.unref()
    }
  }

  export function setTtl(ms: number) {
    ttlMs = Math.max(60_000, Math.min(ms, 3 * 60 * 60 * 1000))
  }

  export function outputChars(proc: Process) {
    return outputBuffers.get(proc)?.length ?? 0
  }

  export function outputBufferStats(proc: Process) {
    const outputBuffer = outputBuffers.get(proc)
    if (!outputBuffer) return { segments: 0, allocatedSegments: 0 }
    return outputBuffer.stats()
  }

  // For testing
  export function reset() {
    running.clear()
    finished.clear()
    lastRecovery = undefined
    if (sweeper) {
      clearInterval(sweeper)
      sweeper = null
    }
  }

  export async function killAllRunning() {
    const procs = Array.from(running.values()).filter((proc) => !proc.exited && (proc.child || terminators.has(proc)))
    if (procs.length === 0) return
    log.info("killing all running processes", { count: procs.length })
    void Observability.emit("process.kill_all.start", {
      data: {
        count: procs.length,
        processIds: procs.map((proc) => proc.id),
      },
    })
    await Promise.all(
      procs.map(async (proc) => {
        try {
          await Observability.emit("process.kill", {
            processId: proc.id,
            pid: proc.pid,
            cwd: proc.cwd,
            data: {
              command: ObservabilityRedaction.commandSummary(proc.command),
            },
          })
          await terminate(proc)
        } catch (err) {
          log.error("failed to kill process", { id: proc.id, error: err })
          void Observability.emit("process.kill.error", {
            processId: proc.id,
            pid: proc.pid,
            cwd: proc.cwd,
            level: "error",
            data: {
              error: ObservabilityRedaction.errorInfo(err),
            },
          })
        }
      }),
    )
    void Observability.emit("process.kill_all.end", {
      data: {
        count: procs.length,
      },
    })
  }

  function inspect(proc: Process): ProcessInspection {
    if (proc.pid === undefined) return {}
    try {
      return processInspector(proc.pid, proc)
    } catch (error) {
      log.warn("failed to inspect process", { id: proc.id, pid: proc.pid, error })
      return {}
    }
  }

  function markStale(proc: Process) {
    void Observability.emit("process.stale_settled", {
      processId: proc.id,
      pid: proc.pid,
      cwd: proc.cwd,
      level: "warn",
      data: {
        command: ObservabilityRedaction.commandSummary(proc.command),
        outputChars: outputChars(proc),
      },
    })
    markExited(proc, null, null)
  }

  function defaultProcessInspector(pid: number): ProcessInspection {
    const alive = OwnedProcessInspection.alive(pid)
    return {
      alive,
      rssBytes: alive ? OwnedProcessInspection.rssBytes(pid) : undefined,
    }
  }
}
