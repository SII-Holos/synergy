import type { ChildProcess } from "child_process"
import { Log } from "../util/log"
import { Identifier } from "../id/id"

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

  const running = new Map<string, Process>()
  const finished = new Map<string, FinishedProcess>()
  let sweeper: Timer | null = null
  let ttlMs = DEFAULT_TTL_MS

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
    log.info("process created", { id, command: opts.command })
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
  }

  export function markBackgrounded(proc: Process) {
    proc.backgrounded = true
    log.info("process backgrounded", { id: proc.id })
  }

  export function markExited(proc: Process, exitCode: number | null, exitSignal: NodeJS.Signals | number | null) {
    proc.exited = true
    proc.exitCode = exitCode
    proc.exitSignal = exitSignal
    proc.tail = proc.output.slice(-TAIL_CHARS)

    const status: Status =
      exitSignal === "SIGKILL" || exitSignal === "SIGTERM" ? "killed" : exitCode === 0 ? "completed" : "failed"

    running.delete(proc.id)

    if (proc.backgrounded) {
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
    }

    log.info("process exited", { id: proc.id, status, exitCode, exitSignal })
  }

  export function remove(id: string) {
    running.delete(id)
    finished.delete(id)
  }

  export function listRunning(): Process[] {
    return Array.from(running.values()).filter((s) => s.backgrounded)
  }

  export function listFinished(): FinishedProcess[] {
    return Array.from(finished.values())
  }

  export function listAll(): Array<Process | FinishedProcess> {
    return [...listRunning(), ...listFinished()].sort((a, b) => b.startedAt - a.startedAt)
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
    await Promise.all(
      procs.map(async (proc) => {
        if (!proc.child) return
        try {
          const { Shell } = await import("../util/shell")
          await Shell.killTree(proc.child, { exited: () => proc.exited })
        } catch (err) {
          log.error("failed to kill process", { id: proc.id, error: err })
        }
      }),
    )
  }
}
