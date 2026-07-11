import type { ChildProcess } from "child_process"
import { readFileSync } from "fs"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { Observability } from "../observability"
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityRedaction } from "@/observability/redaction"

const log = Log.create({ service: "process.registry" })

const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_OUTPUT_CHARS = 200_000
const TAIL_CHARS = 2000

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
  }

  export type ProcessInspector = (pid: number, proc: Process) => ProcessInspection

  const running = new Map<string, Process>()
  const finished = new Map<string, FinishedProcess>()
  let sweeper: Timer | null = null
  let ttlMs = DEFAULT_TTL_MS
  let processInspector: ProcessInspector = defaultProcessInspector

  export function create(opts: {
    command: string
    description?: string
    cwd?: string
    child?: ChildProcess
    stdin?: Stdin
  }): Process {
    const id = Identifier.short("process")
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
      output: "",
      tail: "",
      truncated: false,
      exited: false,
      backgrounded: false,
    }
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

  export function appendOutput(proc: Process, chunk: string) {
    const newOutput = proc.output + chunk
    if (newOutput.length > proc.maxOutputChars) {
      proc.output = newOutput.slice(newOutput.length - proc.maxOutputChars)
      proc.truncated = true
    } else {
      proc.output = newOutput
    }
    proc.tail = proc.output.slice(-TAIL_CHARS)
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

  export function markExited(proc: Process, exitCode: number | null, exitSignal: NodeJS.Signals | number | null) {
    proc.exited = true
    proc.exitCode = exitCode
    proc.exitSignal = exitSignal
    proc.tail = proc.output.slice(-TAIL_CHARS)

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
    })

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
        outputChars: proc.output.length,
      },
    })
  }

  export function remove(id: string) {
    const proc = running.get(id)
    running.delete(id)
    finished.delete(id)
    if (proc) {
      void Observability.emit("process.removed", {
        processId: proc.id,
        pid: proc.pid,
        cwd: proc.cwd,
        data: {
          command: ObservabilityRedaction.commandSummary(proc.command),
          outputChars: proc.output.length,
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
        outputChars: proc.output.length,
        truncated: proc.truncated,
        lastOutputAt: proc.lastOutputAt,
        alive: inspection.alive,
        rssBytes: inspection.rssBytes,
      })
    }
    return result.sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1) || b.startedAt - a.startedAt)
  }

  export function settleStaleProcesses() {
    resourceSnapshot({ settleStale: true })
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

  // For testing
  export function reset() {
    running.clear()
    finished.clear()
    if (sweeper) {
      clearInterval(sweeper)
      sweeper = null
    }
  }

  export async function killAllRunning() {
    const procs = Array.from(running.values()).filter((p) => !p.exited && p.child)
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
        if (!proc.child) return
        try {
          const { Shell } = await import("../util/shell")
          await Observability.emit("process.kill", {
            processId: proc.id,
            pid: proc.pid,
            cwd: proc.cwd,
            data: {
              command: ObservabilityRedaction.commandSummary(proc.command),
            },
          })
          await Shell.killTree(proc.child, { exited: () => proc.exited })
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
        outputChars: proc.output.length,
      },
    })
    markExited(proc, null, null)
  }

  function defaultProcessInspector(pid: number): ProcessInspection {
    const alive = isPidAlive(pid)
    return {
      alive,
      rssBytes: alive ? readLinuxRssBytes(pid) : undefined,
    }
  }

  function isPidAlive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  function readLinuxRssBytes(pid: number) {
    if (process.platform !== "linux") return undefined
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8")
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      if (!match) return undefined
      return Number(match[1]) * 1024
    } catch {
      return undefined
    }
  }
}
