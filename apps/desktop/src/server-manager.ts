import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS } from "@ericsanchezok/synergy-util/runtime-shutdown"
import type { DesktopChannel, DesktopServerMode } from "./identity.js"
import { loadServerPort, saveServerPort } from "./server-port-state.js"
import { DesktopShellEnvironment, type DesktopShellEnvironmentDiagnostics } from "./shell-environment.js"
import { DesktopServerStartup } from "./server-startup.js"
import type { DesktopStartupStatus } from "./startup-page.js"

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
  userDataPath: string
  externalUrl?: string
  shellEnvironment?: DesktopShellEnvironment
  onStartupStatus?: (status: DesktopStartupStatus) => void
}

type ManagedServerLaunch = { ok: true } | { ok: false; portConflict: boolean; detail: string; error: unknown }

type ManagedServerLaunchFailure = Extract<ManagedServerLaunch, { ok: false }>

const dirname = path.dirname(fileURLToPath(import.meta.url))
const HEALTH_PATH = "/global/health"
const SHUTDOWN_TIMEOUT_MS = DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS
const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_INTERVAL_MS = 250
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000
const MANAGED_SERVER_PORT_SCAN_LENGTH = 4
const DEFAULT_MANAGED_SERVER_PORT = 4096
const MANAGED_SERVER_STDERR_LIMIT = 8_192
const MANAGED_SERVER_STDERR_DRAIN_MS = 1_000
const SYNERGY_DESKTOP_SERVER_PORT_ENV = "SYNERGY_DESKTOP_SERVER_PORT"

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
    await fsp.mkdir(this.options.logDir, { recursive: true })
    const logFile = path.join(this.options.logDir, "server.log")
    this.logFile = logFile
    const shellEnvironment = await this.shellEnvironmentPromise
    const candidates = managedServerPortCandidates({
      envPort: managedServerPortFromEnv(process.env),
      stickyPort: await loadServerPort(this.options.userDataPath, this.options.channel),
    })

    for (const port of candidates) {
      if (!(await isPortAvailable(port))) continue
      const launch = await this.launchManagedServer(port, logFile, shellEnvironment)
      if (launch.ok) return await this.acceptManagedServer(port, true)
      if (!launch.portConflict) this.rejectManagedServer(launch)
    }

    // A random port keeps Desktop usable when every deterministic candidate is taken, but it is
    // never persisted so the next launch retries the stable chain first.
    const fallbackPort = await findAvailablePort()
    const fallback = await this.launchManagedServer(fallbackPort, logFile, shellEnvironment)
    if (fallback.ok) return await this.acceptManagedServer(fallbackPort, false)
    this.rejectManagedServer(fallback)
  }

  private async acceptManagedServer(port: number, persist: boolean): Promise<string> {
    if (persist) {
      await saveServerPort(this.options.userDataPath, this.options.channel, port).catch(() => undefined)
    }
    this.state = "running"
    this.lastError = null
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    return this.url
  }

  private rejectManagedServer(launch: ManagedServerLaunchFailure): never {
    this.state = "failed"
    this.lastError = launch.detail
    throw new Error(launch.detail, { cause: launch.error instanceof Error ? launch.error : undefined })
  }

  private async launchManagedServer(
    port: number,
    logFile: string,
    shellEnvironment: DesktopShellEnvironmentDiagnostics | null,
  ): Promise<ManagedServerLaunch> {
    const url = `http://127.0.0.1:${port}`
    const command = await this.resolveServerCommand(port)
    const logStream = fs.createWriteStream(logFile, { flags: "a" })
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
    const startup = new DesktopServerStartup({ onStatus: this.options.onStartupStatus })
    const onOutput = (chunk: Buffer) => startup.receive(chunk.toString("utf8"))
    let stderr = ""
    const onStderr = (chunk: Buffer) => {
      if (stderr.length >= MANAGED_SERVER_STDERR_LIMIT) return
      stderr += chunk.toString("utf8").slice(0, MANAGED_SERVER_STDERR_LIMIT - stderr.length)
    }
    child.stdout?.on("data", onOutput)
    child.stderr?.on("data", onStderr)
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
      await waitForHealth(`${url}${HEALTH_PATH}`, child, HEALTH_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS, startup)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const logTail = await readLogTail(logFile)
      const detail = logTail ? `${message}\n\nServer log tail:\n${logTail}` : message
      // `waitForHealth` can reject on the child's exit event before piped stderr is delivered.
      if (child.exitCode !== null || child.signalCode !== null) {
        await waitForStreamEnd(child.stderr, MANAGED_SERVER_STDERR_DRAIN_MS)
      }
      const portConflict = isPortBindFailure(stderr)
      await this.stop()
      return { ok: false, portConflict, detail, error }
    } finally {
      child.stdout?.off("data", onOutput)
      child.stderr?.off("data", onStderr)
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

    const sourceRoot = sourceProductRoot()
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
    SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
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

export function managedServerPortFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[SYNERGY_DESKTOP_SERVER_PORT_ENV]
  if (!raw) return undefined
  const port = Number(raw)
  return isAssignablePort(port) ? port : undefined
}

export function managedServerPortCandidates(input: {
  envPort?: number
  stickyPort?: number
  defaultPort?: number
  scanLength?: number
}): number[] {
  const defaultPort = input.defaultPort ?? DEFAULT_MANAGED_SERVER_PORT
  const scanLength = input.scanLength ?? MANAGED_SERVER_PORT_SCAN_LENGTH
  const scan = Array.from({ length: scanLength }, (_, index) => defaultPort + index)
  const seen = new Set<number>()
  const candidates: number[] = []
  for (const port of [input.envPort, input.stickyPort, ...scan]) {
    if (!isAssignablePort(port) || seen.has(port)) continue
    seen.add(port)
    candidates.push(port)
  }
  return candidates
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

function isAssignablePort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= 1024 && port <= 65_535
}

function isPortBindFailure(stderr: string): boolean {
  return stderr.includes("Failed to start server on port")
}

function waitForStreamEnd(stream: NodeJS.ReadableStream | null, timeoutMs: number): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.off("end", finish)
      stream.off("close", finish)
      stream.off("error", finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref()
    stream.once("end", finish)
    stream.once("close", finish)
    stream.once("error", finish)
  })
}

export async function waitForHealth(
  url: string,
  child: ChildProcess,
  timeoutMs = Number.POSITIVE_INFINITY,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
  startup?: DesktopServerStartup,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const remaining = () => startup?.remainingMs() ?? deadline - Date.now()
  let lastError: unknown
  const childFailure = watchChildFailure(child)
  try {
    while (child.exitCode === null && child.signalCode === null) {
      const remainingMs = remaining()
      if (remainingMs <= 0) break
      const requestController = new AbortController()
      try {
        const response = await raceWithChildFailure(
          fetchWithTimeout(url, Math.min(remainingMs, 1000), requestController.signal),
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
      const delayMs = Math.min(pollIntervalMs, remaining())
      if (delayMs > 0) {
        await raceWithChildFailure(
          new Promise((resolve) => setTimeout(resolve, delayMs)),
          childFailure.promise,
          () => lastError,
        )
      }
    }
    if (remaining() <= 0) {
      throw new Error(
        `${startup?.timeoutError().message ?? `Synergy server health check timed out after ${timeoutMs}ms`}${
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
  const taskkillSucceeded = await runTaskkill(child.pid, taskkillDeadline, spawnTaskkill)
  if (taskkillSucceeded && (await waitForExit(exited, taskkillDeadline))) return true

  // Retry a failed taskkill once while preserving the caller's single shutdown
  // budget for the final process kill and exit observation.
  if (!taskkillSucceeded && Date.now() < deadline) {
    const retryDeadline = Math.min(deadline, Date.now() + WINDOWS_TASKKILL_TIMEOUT_MS)
    const retrySucceeded = await runTaskkill(child.pid, retryDeadline, spawnTaskkill)
    if (retrySucceeded && (await waitForExit(exited, retryDeadline))) return true
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

export function sourceProductRoot(directory = dirname): string | null {
  const candidate = path.resolve(directory, "../../../packages/product-runtime")
  return fs.existsSync(path.join(candidate, "src/index.ts")) ? candidate : null
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
