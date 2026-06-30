import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { DesktopChannel, DesktopServerMode } from "./identity.js"

export type DesktopServerState = "stopped" | "starting" | "running" | "failed" | "external"

export interface DesktopServerStatus {
  mode: DesktopServerMode
  state: DesktopServerState
  url: string | null
  port: number | null
  pid: number | null
  lastError: string | null
  logFile: string | null
}

export interface DesktopServerManagerOptions {
  channel: DesktopChannel
  mode: DesktopServerMode
  resourcesPath: string
  logDir: string
  externalUrl?: string
}

const dirname = path.dirname(fileURLToPath(import.meta.url))
const HEALTH_PATH = "/global/health"
const SHUTDOWN_TIMEOUT_MS = 5_000

export class DesktopServerManager {
  private child: ChildProcess | null = null
  private state: DesktopServerState
  private port: number | null = null
  private url: string | null = null
  private lastError: string | null = null
  private logFile: string | null = null
  private startPromise: Promise<string> | null = null

  constructor(private options: DesktopServerManagerOptions) {
    this.state = options.mode === "external" ? "external" : "stopped"
    this.url = options.mode === "external" ? (options.externalUrl ?? null) : null
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
    }
  }

  async start(): Promise<string> {
    if (this.options.mode === "external") {
      if (!this.url) throw new Error("SYNERGY_DESKTOP_APP_URL is required when using external desktop server mode")
      return this.url
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
    return this.start()
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.state = this.options.mode === "external" ? "external" : "stopped"
      return
    }
    const child = this.child
    this.child = null
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
    })
    child.kill("SIGTERM")
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
    this.state = "stopped"
    this.port = null
    this.url = null
  }

  private async startManaged(): Promise<string> {
    this.state = "starting"
    this.lastError = null
    this.port = await findAvailablePort()
    this.url = `http://127.0.0.1:${this.port}`
    await fsp.mkdir(this.options.logDir, { recursive: true })
    this.logFile = path.join(this.options.logDir, "server.log")

    const command = await this.resolveServerCommand(this.port)
    const logStream = fs.createWriteStream(this.logFile, { flags: "a" })
    logStream.write(`\n[${new Date().toISOString()}] starting ${command.command} ${command.args.join(" ")}\n`)

    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        SYNERGY_CWD: process.env.SYNERGY_CWD ?? os.homedir(),
        SYNERGY_DESKTOP_CHANNEL: this.options.channel,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    child.once("exit", (code, signal) => {
      logStream.write(`[${new Date().toISOString()}] exited code=${code ?? ""} signal=${signal ?? ""}\n`)
      logStream.end()
      if (this.child === child) {
        this.child = null
        this.state = "failed"
        this.lastError = `Synergy server exited unexpectedly with code ${code ?? "null"} signal ${signal ?? "null"}`
      }
    })

    try {
      await waitForHealth(`${this.url}${HEALTH_PATH}`, child)
      this.state = "running"
      return this.url
    } catch (error) {
      this.state = "failed"
      this.lastError = error instanceof Error ? error.message : String(error)
      await this.stop()
      throw error
    }
  }

  private async resolveServerCommand(port: number): Promise<{ command: string; args: string[]; cwd: string }> {
    const packaged = packagedServerBinary(this.options.resourcesPath)
    if (packaged && fs.existsSync(packaged)) {
      return {
        command: packaged,
        args: ["server", "--port", String(port)],
        cwd: path.dirname(packaged),
      }
    }

    const sourceRoot = sourceSynergyRoot()
    if (!sourceRoot) {
      throw new Error("Packaged Synergy runtime was not found and source fallback is unavailable")
    }
    return {
      command: process.env.BUN_BIN ?? "bun",
      args: ["run", "--conditions=browser", "./src/index.ts", "server", "--port", String(port)],
      cwd: sourceRoot,
    }
  }
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

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  let lastError: unknown
  while (child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`health responded ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Synergy server exited before health became ready (code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
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
