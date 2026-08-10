import type { ChildProcess } from "node:child_process"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS } from "@ericsanchezok/synergy-util/runtime-shutdown"
import type { DesktopChannel, DesktopServerMode } from "./identity.js"
import { DesktopShellEnvironment, type DesktopShellEnvironmentDiagnostics } from "./shell-environment.js"

export type DesktopServerState = "stopped" | "starting" | "running" | "failed" | "external"

export interface DesktopServerStatus {
  mode: DesktopServerMode
  state: DesktopServerState
  url: string | null
  port: number | null
  pid: number | null
  lastError: string | null
  logFile: string | null
  shellEnvironment: DesktopShellEnvironmentDiagnostics | null
}

export interface DesktopServerManagerOptions {
  channel: DesktopChannel
  mode: DesktopServerMode
  resourcesPath: string
  logDir: string
  externalUrl?: string
  shellEnvironment?: DesktopShellEnvironment
}

const dirname = path.dirname(fileURLToPath(import.meta.url))
const HEALTH_PATH = "/global/health"
const SHUTDOWN_TIMEOUT_MS = DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_INTERVAL_MS = 250
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000
const execFileAsync = promisify(execFile)

export class DesktopServerManager {
  private child: ChildProcess | null = null
  private state: DesktopServerState
  private port: number | null = null
  private url: string | null = null
  private lastError: string | null = null
  private logFile: string | null = null
  private startPromise: Promise<string> | null = null
  private shellEnvironment: DesktopShellEnvironmentDiagnostics | null = null
  private readonly shellEnvironmentPromise: Promise<DesktopShellEnvironmentDiagnostics | null>

  constructor(private options: DesktopServerManagerOptions) {
    this.state = options.mode === "external" ? "external" : "stopped"
    this.url = options.mode === "external" ? (options.externalUrl ?? null) : null
    if (options.mode === "external") {
      this.shellEnvironmentPromise = Promise.resolve(null)
    } else {
      const shellEnvironment = options.shellEnvironment ?? new DesktopShellEnvironment()
      this.shellEnvironmentPromise = shellEnvironment.resolve().then((diagnostics) => {
        this.shellEnvironment = diagnostics
        return diagnostics
      })
    }
  }

  status(): DesktopServerStatus {
    return {
      mode: this.options.mode,
      state: this.state,
      url: this.url,
      port: this.port,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
      logFile: this.logFile,
      shellEnvironment: this.shellEnvironment,
    }
  }

  async start(): Promise<string> {
    if (this.options.mode === "external") {
      if (!this.url) throw new Error("SYNERGY_DESKTOP_APP_URL is required when using external desktop server mode")
      return this.url
    }
    if (this.child && this.state === "failed") {
      throw new Error(this.lastError ?? "Synergy server process is still running after termination failed")
    }
    if (this.state === "running" && this.url) return this.url
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startManaged()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async restart(): Promise<string> {
    if (this.options.mode === "external") {
      throw new Error("Cannot restart an externally managed Synergy server")
    }
    await this.stop()
    if (this.child) {
      throw new Error(this.lastError ?? "Synergy server process is still running after termination failed")
    }
    return this.start()
  }

  async stop(): Promise<void> {
    if (!this.child) {
      if (this.state !== "failed") {
        this.state = this.options.mode === "external" ? "external" : "stopped"
      }
      return
    }
    const child = this.child
    const terminated = await terminateServerProcess(child)
    if (!terminated) {
      this.state = "failed"
      this.lastError = `Failed to terminate Synergy server process tree (pid=${child.pid ?? "unknown"}); a child process may still be running and block restart`
      return
    }
    if (this.child === child) this.child = null
    this.state = "stopped"
    this.port = null
    this.url = null
  }

  private async startManaged(): Promise<string> {
    this.state = "starting"
    this.lastError = null
    const requestedPort = process.platform === "win32" ? 0 : await findAvailablePort()
    this.port = requestedPort === 0 ? null : requestedPort
    this.url = requestedPort === 0 ? null : `http://127.0.0.1:${requestedPort}`
    await fsp.mkdir(this.options.logDir, { recursive: true })
    this.logFile = path.join(this.options.logDir, "server.log")
    const shellEnvironment = await this.shellEnvironmentPromise

    const command = await this.resolveServerCommand(requestedPort)
    const logStream = fs.createWriteStream(this.logFile, { flags: "a" })
    logStream.write(`\n[${new Date().toISOString()}] starting ${command.command} ${command.args.join(" ")}\n`)

    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: buildManagedServerEnv(process.env, shellEnvironment, {
        channel: this.options.channel,
        parentPid: process.pid,
        cwd: process.env.SYNERGY_CWD ?? os.homedir(),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    attachManagedServerExitHandlers(child, logStream, (details) => {
      if (this.child === child) {
        this.child = null
        this.state = "failed"
        this.lastError = `Synergy server ${details}`
      }
    })

    try {
      if (process.platform === "win32") {
        const health = await waitForWindowsServerHealth(child)
        this.port = health.port
        this.url = health.url
      } else {
        await waitForHealth(`${this.url}${HEALTH_PATH}`, child, HEALTH_TIMEOUT_MS)
      }
      this.state = "running"
      return this.url!
    } catch (error) {
      this.state = "failed"
      const message = error instanceof Error ? error.message : String(error)
      const logTail = await readLogTail(this.logFile)
      const detail = logTail ? `${message}\n\nServer log tail:\n${logTail}` : message
      this.lastError = detail
      await this.stop()
      throw new Error(detail, { cause: error instanceof Error ? error : undefined })
    }
  }

  private async resolveServerCommand(port: number): Promise<{ command: string; args: string[]; cwd: string }> {
    const packaged = packagedServerBinary(this.options.resourcesPath)
    if (packaged && fs.existsSync(packaged)) {
      return {
        command: packaged,
        args: managedServerArgs(port),
        cwd: path.dirname(packaged),
      }
    }

    const sourceRoot = sourceSynergyRoot()
    if (!sourceRoot) {
      throw new Error("Packaged Synergy runtime was not found and source fallback is unavailable")
    }
    return {
      command: process.env.BUN_BIN ?? "bun",
      args: ["run", "--conditions=browser", "./src/index.ts", ...managedServerArgs(port)],
      cwd: sourceRoot,
    }
  }
}

export function managedServerArgs(port: number): string[] {
  return ["server", "--port", String(port), "--hostname", "127.0.0.1"]
}

export function buildManagedServerEnv(
  inherited: NodeJS.ProcessEnv,
  shellEnvironment: DesktopShellEnvironmentDiagnostics | null,
  input: { channel: DesktopChannel; parentPid: number; cwd: string },
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    ...(shellEnvironment ? { PATH: shellEnvironment.path } : {}),
    SYNERGY_CWD: input.cwd,
    SYNERGY_DESKTOP_CHANNEL: input.channel,
    SYNERGY_DESKTOP_PARENT_PID: String(input.parentPid),
  }
}

export async function terminateServerProcess(
  child: ChildProcess,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  options: ServerProcessTerminationOptions = {},
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true

  const exitWaiter = watchChildExit(child)
  const deadline = Date.now() + Math.max(0, shutdownTimeoutMs)
  try {
    if ((options.platform ?? process.platform) === "win32") {
      return await terminateWindowsProcessTree(child, exitWaiter.promise, deadline, options.spawnTaskkill)
    }

    child.kill("SIGTERM")
    const graceful = await waitForExit(exitWaiter.promise, deadline)
    if (graceful) return true
    if (child.exitCode !== null || child.signalCode !== null) return true

    child.kill("SIGKILL")
    await exitWaiter.promise
    return true
  } finally {
    exitWaiter.dispose()
  }
}

export interface ServerProcessTerminationOptions {
  platform?: NodeJS.Platform
  spawnTaskkill?: (pid: number) => ChildProcess
}

export function attachManagedServerExitHandlers(
  child: ChildProcess,
  logStream: Pick<fs.WriteStream, "write" | "end">,
  onUnexpectedExit: (details: string) => void,
): void {
  let exitHandled = false
  let onError: (error: Error) => void = () => {}
  let onClose: (code: number | null, signal: NodeJS.Signals | null) => void = () => {}
  const handleExit = (details: string) => {
    if (exitHandled) return
    exitHandled = true
    child.removeListener("error", onError)
    child.removeListener("close", onClose)
    logStream.write(`[${new Date().toISOString()}] ${details}\n`)
    logStream.end()
    onUnexpectedExit(details)
  }
  onError = (error) => handleExit(`spawn error: ${error.message}`)
  onClose = (code, signal) => handleExit(`exited code=${code ?? ""} signal=${signal ?? ""}`)
  child.once("error", onError)
  child.once("close", onClose)
}

export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local TCP port")))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export async function waitForHealth(
  url: string,
  child: ChildProcess,
  timeoutMs = Number.POSITIVE_INFINITY,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  const childFailure = watchChildFailure(child)
  try {
    while (child.exitCode === null && child.signalCode === null) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const requestController = new AbortController()
      try {
        const response = await raceWithChildFailure(
          fetchWithTimeout(url, remainingMs, requestController.signal),
          childFailure.promise,
          () => lastError,
          () => requestController.abort(),
        )
        if (response.ok) return
        lastError = new Error(`health responded ${response.status}`)
      } catch (error) {
        if (error instanceof ChildProcessHealthError) throw error
        lastError = error
      }
      const delayMs = Math.min(pollIntervalMs, deadline - Date.now())
      if (delayMs > 0) {
        await raceWithChildFailure(
          new Promise((resolve) => setTimeout(resolve, delayMs)),
          childFailure.promise,
          () => lastError,
        )
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Synergy server health check timed out after ${timeoutMs}ms${
          lastError instanceof Error ? `: ${lastError.message}` : ""
        }`,
      )
    }
    throw new Error(
      `Synergy server exited before health became ready (code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  } finally {
    childFailure.dispose()
  }
}

export async function waitForWindowsServerHealth(
  child: ChildProcess,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{ url: string; port: number }> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  const childFailure = watchChildFailure(child)
  try {
    while (child.exitCode === null && child.signalCode === null) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break

      let port: number | null
      try {
        port = await raceWithChildFailure(
          child.pid ? findListeningPort(child.pid, Math.min(remainingMs, 1_000)) : Promise.resolve(null),
          childFailure.promise,
          () => lastError,
        )
      } catch (error) {
        if (error instanceof ChildProcessHealthError) throw error
        lastError = error
        port = null
      }
      if (port !== null) {
        const url = `http://127.0.0.1:${port}`
        const requestController = new AbortController()
        try {
          const response = await raceWithChildFailure(
            fetchWithTimeout(`${url}${HEALTH_PATH}`, deadline - Date.now(), requestController.signal),
            childFailure.promise,
            () => lastError,
            () => requestController.abort(),
          )
          if (response.ok) return { url, port }
          lastError = new Error(`health responded ${response.status}`)
        } catch (error) {
          if (error instanceof ChildProcessHealthError) throw error
          lastError = error
        }
      }

      const delayMs = Math.min(HEALTH_POLL_INTERVAL_MS, deadline - Date.now())
      if (delayMs > 0) {
        await raceWithChildFailure(
          new Promise((resolve) => setTimeout(resolve, delayMs)),
          childFailure.promise,
          () => lastError,
        )
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Synergy server health check timed out after ${timeoutMs}ms${
          lastError instanceof Error ? `: ${lastError.message}` : ""
        }`,
      )
    }
    throw new Error(
      `Synergy server exited before health became ready (code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  } finally {
    childFailure.dispose()
  }
}

export async function findListeningPort(pid: number, timeoutMs = 1_000): Promise<number | null> {
  if (process.platform !== "win32") return null
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return parseListeningPort(stdout, pid)
  } catch {}
  return null
}

export function parseListeningPort(stdout: string, pid: number): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue
    const stateIndex = columns.findIndex((column) => column.toUpperCase() === "LISTENING")
    if (stateIndex < 2 || Number(columns[stateIndex + 1]) !== pid) continue

    const localAddress = columns[1] ?? ""
    const separator = localAddress.lastIndexOf(":")
    const port = Number(localAddress.slice(separator + 1))
    if (separator >= 0 && Number.isInteger(port) && port > 0 && port <= 65_535) return port
  }
  return null
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  if (!Number.isFinite(timeoutMs)) return fetch(url, signal ? { signal } : undefined)
  if (timeoutMs <= 0) throw new Error("health request timed out")
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) throw new Error("health request aborted")
    signal.addEventListener("abort", abort, { once: true })
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("health request timed out"))
    }, timeoutMs)
  })
  try {
    return await Promise.race([fetch(url, { signal: controller.signal }), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

type ChildProcessFailure =
  | { kind: "error"; error: Error }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }

class ChildProcessHealthError extends Error {
  constructor(failure: ChildProcessFailure, lastError: unknown) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : ""
    const message =
      failure.kind === "error"
        ? `Synergy server process error before health became ready: ${failure.error.message}${detail}`
        : `Synergy server exited before health became ready (code=${failure.code ?? "null"} signal=${failure.signal ?? "null"}): ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`
    super(message, { cause: failure.kind === "error" ? failure.error : undefined })
    this.name = "ChildProcessHealthError"
  }
}

function watchChildFailure(child: ChildProcess): {
  promise: Promise<ChildProcessFailure>
  dispose: () => void
} {
  let settled = false
  let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {}
  let onError: (error: Error) => void = () => {}
  let cleanup = () => {}

  const promise = new Promise<ChildProcessFailure>((resolve) => {
    const finish = (failure: ChildProcessFailure) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(failure)
    }

    onExit = (code, signal) => finish({ kind: "exit", code, signal })
    onError = (error) => finish({ kind: "error", error })
    cleanup = () => {
      child.removeListener("exit", onExit)
      child.removeListener("error", onError)
    }

    child.once("exit", onExit)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ kind: "exit", code: child.exitCode, signal: child.signalCode })
    }
  })

  return { promise, dispose: cleanup }
}

async function raceWithChildFailure<T>(
  operation: Promise<T>,
  childFailure: Promise<ChildProcessFailure>,
  lastError: () => unknown,
  onChildFailure?: () => void,
): Promise<T> {
  const result = await Promise.race([
    operation.then((value) => ({ kind: "result" as const, value })),
    childFailure.then((failure) => {
      onChildFailure?.()
      return { kind: "failure" as const, failure }
    }),
  ])
  if (result.kind === "failure") throw new ChildProcessHealthError(result.failure, lastError())
  return result.value
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  exited: Promise<void>,
  deadline: number,
  spawnTaskkill: (pid: number) => ChildProcess = spawnTaskkillProcess,
): Promise<boolean> {
  if (!child.pid) return false

  const taskkillDeadline = Math.min(deadline, Date.now() + WINDOWS_TASKKILL_TIMEOUT_MS)
  await runTaskkill(child.pid, taskkillDeadline, spawnTaskkill)
  if (await waitForExit(exited, taskkillDeadline)) return true

  // A successful taskkill can race the ChildProcess exit event. Retry only when
  // there is still time in the caller's single shutdown budget.
  if (Date.now() < deadline) {
    await runTaskkill(child.pid, Math.min(deadline, Date.now() + WINDOWS_TASKKILL_TIMEOUT_MS), spawnTaskkill)
    if (await waitForExit(exited, deadline)) return true
  }

  try {
    child.kill("SIGKILL")
  } catch {}
  return await waitForExit(exited, deadline)
}

function spawnTaskkillProcess(pid: number): ChildProcess {
  return spawn("taskkill.exe", ["/pid", String(pid), "/f", "/t"], {
    stdio: "ignore",
    windowsHide: true,
  })
}

async function runTaskkill(
  pid: number,
  deadline: number,
  spawnTaskkill: (pid: number) => ChildProcess,
): Promise<boolean> {
  let taskkill: ChildProcess
  try {
    taskkill = spawnTaskkill(pid)
  } catch {
    return false
  }

  const result = await waitForExitCode(taskkill, deadline)
  if (result === null) {
    try {
      taskkill.kill()
    } catch {}
    return false
  }
  return result === 0
}

function watchChildExit(child: ChildProcess): {
  promise: Promise<void>
  dispose: () => void
} {
  let settled = false
  let onExit: () => void = () => {}
  let onClose: () => void = () => {}
  let onError: () => void = () => {}
  let cleanup = () => {}

  const promise = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    onExit = finish
    onClose = finish
    onError = finish
    cleanup = () => {
      child.removeListener("exit", onExit)
      child.removeListener("close", onClose)
      child.removeListener("error", onError)
    }
    child.once("exit", onExit)
    child.once("close", onClose)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })

  return { promise, dispose: cleanup }
}

function waitForExit(exited: Promise<void>, deadline: number): Promise<boolean> {
  return waitForDeadline(
    exited.then(() => true),
    deadline,
  )
}

function waitForExitCode(child: ChildProcess, deadline: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onExit: (code: number | null) => void = () => {}
    let onError: () => void = () => {}
    const cleanup = () => {
      child.removeListener("exit", onExit)
      child.removeListener("error", onError)
    }
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      cleanup()
      resolve(value)
    }

    onExit = (code) => finish(code)
    onError = () => finish(null)
    child.once("exit", onExit)
    child.once("error", onError)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      finish(null)
      return
    }
    timeout = setTimeout(() => finish(null), remainingMs)
    timeout.unref()
  })
}

function waitForDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | false> {
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | false) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(value)
    }

    void promise.then(
      (value) => finish(value),
      () => finish(false),
    )
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      finish(false)
      return
    }
    timeout = setTimeout(() => finish(false), remainingMs)
    timeout.unref()
  })
}

function packagedServerBinary(resourcesPath: string): string | null {
  const binaryName = process.platform === "win32" ? "synergy.exe" : "synergy"
  return path.join(resourcesPath, "synergy", "bin", binaryName)
}

function sourceSynergyRoot(): string | null {
  const candidates = [
    path.resolve(dirname, "../../synergy"),
    path.resolve(dirname, "../../packages/synergy"),
    path.resolve(dirname, "../../../packages/synergy"),
  ]
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "src/index.ts"))) ?? null
}

async function readLogTail(logFile: string | null): Promise<string | null> {
  if (!logFile) return null
  try {
    const stat = await fsp.stat(logFile)
    if (stat.size === 0) return "(empty)"
    const fd = await fsp.open(logFile, "r")
    const maxBytes = 8192
    const start = Math.max(0, stat.size - maxBytes)
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fd.read(buf, 0, maxBytes, start)
    await fd.close()
    return buf.subarray(0, bytesRead).toString("utf-8")
  } catch {
    return null
  }
}
