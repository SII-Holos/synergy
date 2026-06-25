import fs from "fs/promises"
import { DaemonPaths } from "./paths"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export namespace ServerProcessLock {
  export interface LockInfo {
    pid: number
    startedAt: number
    command: string[]
    cwd: string
    mode: "server" | "daemon"
  }

  export class AlreadyRunningError extends Error {
    constructor(readonly lock: LockInfo) {
      super(`Another Synergy server process is already running (pid ${lock.pid})`)
      this.name = "AlreadyRunningError"
    }
  }

  export interface ProcessInspection {
    alive: boolean
    pid: number
    ppid?: number
    pgid?: number
    stat?: string
    cpu?: number
    memory?: number
    elapsed?: string
    command?: string
    listeningPorts?: number[]
    healthy?: boolean
    healthUrl?: string
    error?: string
  }

  export async function acquire() {
    const lockPath = DaemonPaths.runtimeLock()
    await fs.mkdir(DaemonPaths.root(), { recursive: true })

    const existing = await read().catch(() => undefined)
    if (existing && (await isPidAlive(existing.pid))) {
      throw new AlreadyRunningError(existing)
    }

    const payload: LockInfo = {
      pid: process.pid,
      startedAt: Date.now(),
      command: process.argv.slice(),
      cwd: process.cwd(),
      mode: process.env.SYNERGY_DAEMON === "1" ? "daemon" : "server",
    }
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2) + "\n")

    let released = false
    const release = async () => {
      if (released) return
      released = true
      const current = await read().catch(() => undefined)
      if (current?.pid === process.pid) {
        await fs.rm(lockPath, { force: true }).catch(() => {})
      }
    }

    return { release }
  }

  export function path() {
    return DaemonPaths.runtimeLock()
  }

  export async function read(): Promise<LockInfo | undefined> {
    const file = Bun.file(DaemonPaths.runtimeLock())
    if (!(await file.exists().catch(() => false))) return undefined
    return (await file.json()) as LockInfo
  }

  async function isPidAlive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  export async function inspect(lock: LockInfo, input?: { healthUrl?: string }): Promise<ProcessInspection> {
    if (!(await isPidAlive(lock.pid))) {
      return { alive: false, pid: lock.pid }
    }
    const result: ProcessInspection = { alive: true, pid: lock.pid }
    if (process.platform !== "win32") {
      const ps = await execFileAsync("ps", [
        "-p",
        String(lock.pid),
        "-o",
        "pid=,ppid=,pgid=,stat=,%cpu=,%mem=,etime=,command=",
      ]).catch((error) => ({ stdout: "", stderr: String(error) }))
      const line = ps.stdout.trim()
      if (line) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/)
        if (match) {
          result.ppid = Number(match[2])
          result.pgid = Number(match[3])
          result.stat = match[4]
          result.cpu = Number(match[5])
          result.memory = Number(match[6])
          result.elapsed = match[7]
          result.command = match[8]
        }
      }
      const lsof = await execFileAsync("lsof", ["-nP", "-Pan", "-p", String(lock.pid), "-iTCP", "-sTCP:LISTEN"]).catch(
        () => ({ stdout: "" }),
      )
      result.listeningPorts = Array.from(lsof.stdout.matchAll(/TCP [^:]+:(\d+) \(LISTEN\)/g)).map((m) => Number(m[1]))
    }
    if (input?.healthUrl) {
      result.healthUrl = input.healthUrl
      result.healthy = await health(input.healthUrl)
    }
    return result
  }

  async function health(url: string) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1200)
    try {
      const res = await fetch(new URL("/global/health", url), { signal: controller.signal })
      if (!res.ok) return false
      const payload = (await res.json().catch(() => undefined)) as { healthy?: boolean } | undefined
      return payload?.healthy === true
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
}
