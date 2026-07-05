import process from "node:process"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { SynergyLinkBash, SynergyLinkIdentity, SynergyLinkProcess } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkHost } from "../host"
import { Platform } from "../platform"

const MAX_OUTPUT_CHARS = 200_000
const TAIL_CHARS = 2_000
const DEFAULT_TTL_MS = 30 * 60 * 1000

interface ProcessRecord {
  processId: SynergyLinkIdentity.ProcessID
  command: string
  description?: string
  cwd?: string
  child: ChildProcess
  stdin?: NodeJS.WritableStream
  startedAt: number
  output: string
  tail: string
  truncated: boolean
  exitCode?: number | null
  exitSignal?: NodeJS.Signals | number | null
  exited: boolean
  backgrounded: boolean
}

interface FinishedRecord {
  processId: SynergyLinkIdentity.ProcessID
  command: string
  description?: string
  cwd?: string
  status: SynergyLinkProcess.ProcessState
  startedAt: number
  endedAt: number
  output: string
  tail: string
  truncated: boolean
  exitCode?: number | null
  exitSignal?: NodeJS.Signals | number | null
}

type CurrentOrFinished = {
  processId: string
  command: string
  description?: string
  output: string
  tail: string
  exitCode?: number | null
  exitSignal?: NodeJS.Signals | number | null
  status: SynergyLinkProcess.ProcessState
  startedAt: number
  endedAt?: number
}

export class ProcessRegistry {
  readonly #running = new Map<SynergyLinkIdentity.ProcessID, ProcessRecord>()
  readonly #finished = new Map<SynergyLinkIdentity.ProcessID, FinishedRecord>()
  readonly #waiters = new Map<SynergyLinkIdentity.ProcessID, Set<() => void>>()
  readonly #ttlMs: number
  readonly #host: SynergyLinkHost
  #sweeper?: ReturnType<typeof setInterval>

  constructor(host: SynergyLinkHost, options?: { ttlMs?: number }) {
    this.#host = host
    this.#ttlMs = Math.max(60_000, options?.ttlMs ?? DEFAULT_TTL_MS)
  }

  async executeBash(request: SynergyLinkBash.ExecutePayload, linkID: string): Promise<SynergyLinkBash.Result> {
    this.#host.assertLink(linkID)
    const launched = this.#launchShellProcess({
      command: request.command,
      description: request.description,
      workdir: Platform.resolveWorkdir(request.workdir),
    })

    if (request.background) {
      launched.record.backgrounded = true
      return this.#backgroundResult(launched.record, linkID, request.description, "Background")
    }

    if (request.yieldSeconds && request.yieldSeconds > 0) {
      const yieldMs = request.yieldSeconds * 1000
      const autoBackground = await Promise.race([
        this.#waitForExit(launched.record.processId).then(() => false),
        Platform.sleep(yieldMs).then(() => !launched.record.exited),
      ])
      if (autoBackground) {
        launched.record.backgrounded = true
        return this.#backgroundResult(
          launched.record,
          linkID,
          request.description,
          "Auto-Background",
          request.yieldSeconds,
        )
      }
    }

    await this.#waitForExit(launched.record.processId)
    const current = this.#getCurrentOrFinished(launched.record.processId)
    const runtimeMs = this.#runtimeMs(current ?? launched.record)
    const output = current?.output ?? launched.record.output
    const exitCode = current?.exitCode ?? launched.record.exitCode ?? null

    return {
      title: request.description,
      metadata: {
        output,
        description: request.description,
        exit: typeof exitCode === "number" ? exitCode : null,
        durationMs: runtimeMs,
        hostSessionID: this.#host.hostSessionID,
        linkID,
        backend: "remote",
      },
      output,
    }
  }

  async execute(request: SynergyLinkProcess.ExecutePayload, linkID: string): Promise<SynergyLinkProcess.Result> {
    this.#host.assertLink(linkID)

    if (request.action === "list") {
      const processes = this.#listAll()
      return {
        title: "Process list",
        metadata: {
          action: "list",
          processes,
          hostSessionID: this.#host.hostSessionID,
          linkID,
          backend: "remote",
        },
        output: processes.length > 0 ? processes.map(renderProcessLine).join("\n") : "No running or recent processes.",
      }
    }

    const processId = request.processId
    if (!processId) {
      return this.#result({
        action: request.action,
        title: "Process not found",
        output: "processId is required for this action",
        status: "not_found",
        linkID,
      })
    }

    switch (request.action) {
      case "poll":
        return this.#poll(processId, linkID, request.block, request.timeout)
      case "log":
        return this.#log(processId, linkID, request.offset, request.limit)
      case "write":
        return this.#write(processId, linkID, request.data ?? "")
      case "send-keys":
        return this.#sendKeys(processId, linkID, request.keys ?? [])
      case "kill":
        return this.#kill(processId, linkID)
      case "clear":
        return this.#clear(processId, linkID)
      case "remove":
        return this.#remove(processId, linkID)
    }
  }

  reset() {
    for (const record of this.#running.values()) {
      void Platform.killTree(record.child, () => record.exited)
    }
    this.#running.clear()
    this.#finished.clear()
    this.#waiters.clear()
    if (this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
  }

  #launchShellProcess(input: { command: string; description?: string; workdir: string }) {
    const launch = Platform.resolveShellLaunch(input.command)
    const options: SpawnOptions = {
      cwd: input.workdir,
      env: Platform.normalizeEnv({ ...process.env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    }
    const child = spawn(launch.file, launch.args, options)
    const processId = crypto.randomUUID()
    const record: ProcessRecord = {
      processId,
      command: input.command,
      description: input.description,
      cwd: input.workdir,
      child,
      stdin: child.stdin || undefined,
      startedAt: Date.now(),
      output: "",
      tail: "",
      truncated: false,
      exited: false,
      backgrounded: false,
    }

    const append = (chunk?: Uint8Array | string | null) => {
      if (chunk == null) return
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      const next = record.output + text
      if (next.length > MAX_OUTPUT_CHARS) {
        record.output = next.slice(next.length - MAX_OUTPUT_CHARS)
        record.truncated = true
      } else {
        record.output = next
      }
      record.tail = record.output.slice(-TAIL_CHARS)
    }

    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.#markExited(record, code, signal)
    })

    child.once("error", (error: Error) => {
      append(String(error))
      this.#markExited(record, 1, null)
    })

    this.#running.set(processId, record)
    this.#startSweeper()
    return { record }
  }

  async #poll(
    processId: string,
    linkID: string,
    block?: boolean,
    timeoutSeconds?: number,
  ): Promise<SynergyLinkProcess.Result> {
    const running = this.#running.get(processId)
    const finished = this.#finished.get(processId)
    if (!running && !finished) {
      return this.#result({
        action: "poll",
        title: "Process not found",
        output: `No process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    if (running && block) {
      await this.#waitForExit(processId, (timeoutSeconds ?? 30) * 1000)
    }

    const currentRunning = this.#running.get(processId)
    if (currentRunning) {
      return this.#result({
        action: "poll",
        title: `Process ${processId}`,
        output: (currentRunning.tail || "(no output yet)") + "\n\nProcess still running.",
        processId,
        status: "running",
        command: currentRunning.command,
        description: currentRunning.description,
        linkID,
      })
    }

    const currentFinished = this.#finished.get(processId)
    if (!currentFinished) {
      return this.#result({
        action: "poll",
        title: "Process not found",
        output: `No process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    return this.#result({
      action: "poll",
      title: `Process ${processId}`,
      output:
        (currentFinished.tail || "(no output recorded)") +
        `\n\nProcess exited with ${currentFinished.exitSignal ? `signal ${currentFinished.exitSignal}` : `code ${currentFinished.exitCode ?? 0}`}.`,
      processId,
      status: currentFinished.status,
      command: currentFinished.command,
      description: currentFinished.description,
      exitCode: typeof currentFinished.exitCode === "number" ? currentFinished.exitCode : undefined,
      linkID,
    })
  }

  async #log(processId: string, linkID: string, offset = 0, limit?: number): Promise<SynergyLinkProcess.Result> {
    const target = this.#getCurrentOrFinished(processId)
    if (!target) {
      return this.#result({
        action: "log",
        title: "Process not found",
        output: `No process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    const lines = target.output.split("\n")
    const count = limit ?? lines.length
    return this.#result({
      action: "log",
      title: `Log: ${processId}`,
      output: lines.slice(offset, offset + count).join("\n") || "(no output)",
      processId,
      status: target.status,
      command: target.command,
      description: target.description,
      nextOffset: Math.min(offset + count, lines.length),
      linkID,
    })
  }

  async #write(processId: string, linkID: string, data: string): Promise<SynergyLinkProcess.Result> {
    const record = this.#running.get(processId)
    if (!record) {
      return this.#result({
        action: "write",
        title: "Process not found",
        output: `No active process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    if (!record.backgrounded) {
      return this.#result({
        action: "write",
        title: "Process not backgrounded",
        output: `Process ${processId} is not a background process.`,
        processId,
        status: "error",
        command: record.command,
        description: record.description,
        linkID,
      })
    }

    const stdin = record.stdin
    if (!stdin || (stdin as NodeJS.WritableStream & { destroyed?: boolean }).destroyed) {
      return this.#result({
        action: "write",
        title: "Stdin not writable",
        output: `Process ${processId} stdin is not writable.`,
        processId,
        status: "error",
        command: record.command,
        description: record.description,
        linkID,
      })
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error?: Error | null) => {
        if (error) reject(error)
        else resolve()
      })
    })

    return this.#result({
      action: "write",
      title: `Wrote to ${processId}`,
      output: `Wrote ${data.length} bytes to process ${processId}.`,
      processId,
      status: "running",
      command: record.command,
      description: record.description,
      linkID,
    })
  }

  async #sendKeys(processId: string, linkID: string, keys: string[]): Promise<SynergyLinkProcess.Result> {
    if (keys.length === 0) {
      return this.#result({
        action: "send-keys",
        title: "No keys provided",
        output: "No key tokens provided for send-keys.",
        processId,
        status: "error",
        linkID,
      })
    }

    const encoded = Platform.encodeKeySequence(keys)
    const result = await this.#write(processId, linkID, encoded.data)
    return {
      title: `Sent keys to ${processId}`,
      metadata: {
        ...result.metadata,
        action: "send-keys",
      },
      output:
        `Sent ${encoded.data.length} bytes to process ${processId}.` +
        (encoded.warnings.length > 0 ? `\nWarnings: ${encoded.warnings.join(", ")}` : ""),
    }
  }

  async #kill(processId: string, linkID: string): Promise<SynergyLinkProcess.Result> {
    const record = this.#running.get(processId)
    if (!record) {
      return this.#result({
        action: "kill",
        title: "Process not found",
        output: `No active process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    await Platform.killTree(record.child, () => record.exited)
    return this.#result({
      action: "kill",
      title: `Killed ${processId}`,
      output: `Killed process ${processId}.`,
      processId,
      status: "killed",
      command: record.command,
      description: record.description,
      linkID,
    })
  }

  async #clear(processId: string, linkID: string): Promise<SynergyLinkProcess.Result> {
    const finished = this.#finished.get(processId)
    if (!finished) {
      if (this.#running.has(processId)) {
        return this.#result({
          action: "clear",
          title: "Process still running",
          output: `Process ${processId} is still running. Use kill or remove instead.`,
          processId,
          status: "error",
          linkID,
        })
      }
      return this.#result({
        action: "clear",
        title: "Process not found",
        output: `No finished process found for ${processId}`,
        processId,
        status: "not_found",
        linkID,
      })
    }

    this.#finished.delete(processId)
    return this.#result({
      action: "clear",
      title: `Cleared ${processId}`,
      output: `Cleared process ${processId} from history.`,
      processId,
      status: "cleared",
      command: finished.command,
      description: finished.description,
      linkID,
    })
  }

  async #remove(processId: string, linkID: string): Promise<SynergyLinkProcess.Result> {
    const running = this.#running.get(processId)
    const finished = this.#finished.get(processId)
    if (running) {
      await Platform.killTree(running.child, () => running.exited)
      this.#running.delete(processId)
    }
    this.#finished.delete(processId)

    return this.#result({
      action: "remove",
      title: `Removed ${processId}`,
      output: `Removed process ${processId}.`,
      processId,
      status: "removed",
      command: running?.command || finished?.command,
      description: running?.description || finished?.description,
      linkID,
    })
  }

  #result(input: {
    action: SynergyLinkProcess.Action
    title: string
    output: string
    status?: SynergyLinkProcess.ActionStatus
    processId?: string
    command?: string
    description?: string
    exitCode?: number
    nextOffset?: number
    linkID: string
    processes?: SynergyLinkProcess.ProcessInfo[]
  }): SynergyLinkProcess.Result {
    return {
      title: input.title,
      metadata: {
        action: input.action,
        processId: input.processId,
        status: input.status,
        exitCode: input.exitCode,
        command: input.command,
        description: input.description,
        nextOffset: input.nextOffset,
        hostSessionID: this.#host.hostSessionID,
        linkID: input.linkID,
        backend: "remote",
        processes: input.processes,
      },
      output: input.output,
    }
  }

  #backgroundResult(
    record: ProcessRecord,
    linkID: string,
    description: string,
    mode: "Background" | "Auto-Background",
    yieldSeconds?: number,
  ): SynergyLinkBash.Result {
    const prefix =
      mode === "Auto-Background"
        ? `Command auto-backgrounded after ${yieldSeconds}s.`
        : "Command started in background."
    return {
      title: `[${mode}] ${description}`,
      metadata: {
        output: record.tail,
        description,
        processId: record.processId,
        background: true,
        durationMs: this.#runtimeMs(record),
        hostSessionID: this.#host.hostSessionID,
        linkID,
        backend: "remote",
      },
      output:
        `${prefix}\n\n` +
        `Process ID: ${record.processId}\n` +
        `Command: ${record.command}\n` +
        `Status: running\n\n` +
        `Recent output:\n${record.tail || "(no output yet)"}\n\n` +
        `Use process(action: \"poll\", processId: \"${record.processId}\", linkID: \"${linkID}\") to check status.\n` +
        `Use process(action: \"log\", processId: \"${record.processId}\", linkID: \"${linkID}\") to get full output.\n` +
        `Use process(action: \"kill\", processId: \"${record.processId}\", linkID: \"${linkID}\") to terminate.`,
    }
  }

  #markExited(record: ProcessRecord, exitCode: number | null, exitSignal: NodeJS.Signals | number | null) {
    if (record.exited) return
    record.exited = true
    record.exitCode = exitCode
    record.exitSignal = exitSignal
    record.tail = record.output.slice(-TAIL_CHARS)
    this.#running.delete(record.processId)

    if (record.backgrounded) {
      this.#finished.set(record.processId, {
        processId: record.processId,
        command: record.command,
        description: record.description,
        cwd: record.cwd,
        status: classifyExit(exitCode, exitSignal),
        startedAt: record.startedAt,
        endedAt: Date.now(),
        output: record.output,
        tail: record.tail,
        truncated: record.truncated,
        exitCode,
        exitSignal,
      })
    }

    const waiters = this.#waiters.get(record.processId)
    if (waiters) {
      this.#waiters.delete(record.processId)
      for (const resolve of waiters) resolve()
    }
  }

  #waitForExit(processId: string, timeoutMs?: number): Promise<void> {
    const running = this.#running.get(processId)
    if (!running || running.exited) return Promise.resolve()

    return new Promise((resolve) => {
      const waiters = this.#waiters.get(processId) || new Set<() => void>()
      const done = () => resolve()
      waiters.add(done)
      this.#waiters.set(processId, waiters)

      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {
          waiters.delete(done)
          resolve()
        }, timeoutMs)
        unrefTimer(timer)
      }
    })
  }

  #getCurrentOrFinished(processId: string): CurrentOrFinished | undefined {
    const running = this.#running.get(processId)
    if (running) {
      return {
        processId: running.processId,
        command: running.command,
        description: running.description,
        output: running.output,
        tail: running.tail,
        exitCode: running.exitCode,
        exitSignal: running.exitSignal,
        status: "running",
        startedAt: running.startedAt,
      }
    }

    const finished = this.#finished.get(processId)
    if (!finished) return undefined
    return finished
  }

  #listAll(): SynergyLinkProcess.ProcessInfo[] {
    const running = [...this.#running.values()]
      .filter((record) => record.backgrounded)
      .map((record) => ({
        processId: record.processId,
        status: "running" as const,
        command: trimCommand(record.command),
        description: record.description,
        runtimeMs: this.#runtimeMs(record),
      }))

    const finished = [...this.#finished.values()].map((record) => ({
      processId: record.processId,
      status: record.status,
      command: trimCommand(record.command),
      description: record.description,
      runtimeMs: record.endedAt - record.startedAt,
    }))

    return [...running, ...finished].sort((left, right) => right.runtimeMs - left.runtimeMs)
  }

  #runtimeMs(record: { startedAt: number; endedAt?: number }): number {
    return (record.endedAt ?? Date.now()) - record.startedAt
  }

  #startSweeper() {
    if (this.#sweeper) return
    this.#sweeper = setInterval(
      () => {
        const cutoff = Date.now() - this.#ttlMs
        for (const [processId, record] of this.#finished.entries()) {
          if (record.endedAt < cutoff) this.#finished.delete(processId)
        }
      },
      Math.max(30_000, Math.floor(this.#ttlMs / 6)),
    )
    unrefTimer(this.#sweeper)
  }
}
function classifyExit(
  exitCode: number | null | undefined,
  exitSignal: NodeJS.Signals | number | null | undefined,
): SynergyLinkProcess.ProcessState {
  if (exitSignal === "SIGKILL" || exitSignal === "SIGTERM") return "killed"
  return (exitCode ?? 0) === 0 ? "completed" : "failed"
}

function trimCommand(command: string): string {
  return command.length > 80 ? `${command.slice(0, 77)}...` : command
}

function renderProcessLine(processInfo: SynergyLinkProcess.ProcessInfo): string {
  const label = processInfo.description || processInfo.command
  return `${processInfo.processId} ${processInfo.status.padEnd(9)} ${formatDuration(processInfo.runtimeMs)} :: ${label}`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`.padStart(6)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m${remainder}s`.padStart(6)
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref()
  }
}
