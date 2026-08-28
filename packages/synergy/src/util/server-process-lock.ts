import fs from "fs/promises"
import { DaemonPaths } from "./daemon-paths"
import { execFile } from "child_process"
import { randomUUID } from "crypto"
import { promisify } from "util"

const execFileAsync = promisify(execFile)
let ownProcessStartIdentity: Promise<string | undefined> | undefined

export namespace ServerProcessLock {
  export interface LockInfo {
    pid: number
    startedAt: number
    ownerToken?: string
    processStartIdentity?: string
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

  export class LockFileUncertainError extends Error {
    constructor(readonly lockPath: string) {
      super(
        `Cannot safely acquire the Synergy server lock because ${lockPath} is malformed, incomplete, or unreadable; verify that no Synergy server is running and remove the lock file before retrying`,
      )
      this.name = "LockFileUncertainError"
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

    const ownerToken = randomUUID()
    const processStartIdentity = (await getProcessStartIdentity(process.pid)) ?? `unknown:${process.pid}`
    const payload: LockInfo = {
      pid: process.pid,
      startedAt: Date.now(),
      ownerToken,
      processStartIdentity,
      command: process.argv.slice(),
      cwd: process.cwd(),
      mode: process.env.SYNERGY_DAEMON === "1" ? "daemon" : "server",
    }

    for (;;) {
      try {
        await createExclusive(lockPath, JSON.stringify(payload, null, 2) + "\n")
        break
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error

        const existing = await readForAcquire()
        if (existing?.lock && (await isProcessOwnerAlive(existing.lock))) {
          throw new AlreadyRunningError(existing.lock)
        }
        if (existing?.uncertain) {
          throw new LockFileUncertainError(lockPath)
        }
        await quarantineStaleLock(lockPath, existing?.contents)
      }
    }

    let released = false
    const release = async () => {
      if (released) return
      released = true
      await removeOwnedLock(lockPath, { pid: process.pid, ownerToken, processStartIdentity })
    }

    return { release }
  }

  export function path() {
    return DaemonPaths.runtimeLock()
  }

  export async function read(): Promise<LockInfo | undefined> {
    try {
      const snapshot = await readSnapshot()
      return snapshot?.lock
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async function createExclusive(lockPath: string, contents: string) {
    const temporaryPath = `${lockPath}.tmp-${randomUUID()}`
    try {
      const handle = await fs.open(temporaryPath, "wx")
      try {
        await handle.writeFile(contents, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.link(temporaryPath, lockPath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  interface LockSnapshot {
    contents?: string
    lock?: LockInfo
    uncertain?: boolean
  }

  async function readSnapshot(): Promise<LockSnapshot | undefined> {
    try {
      const contents = await fs.readFile(DaemonPaths.runtimeLock(), "utf8")
      return { contents, lock: parseLockInfo(contents) }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    }
  }

  async function readForAcquire(): Promise<LockSnapshot | undefined> {
    let lastContents: string | undefined
    let lastUncertain = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const before = await fs.stat(DaemonPaths.runtimeLock())
        const contents = await fs.readFile(DaemonPaths.runtimeLock(), "utf8")
        const contentsAgain = await fs.readFile(DaemonPaths.runtimeLock(), "utf8")
        const after = await fs.stat(DaemonPaths.runtimeLock())
        if (contents !== contentsAgain || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          await Bun.sleep(10)
          continue
        }
        lastContents = contents
        const parsed = parseLockContents(contents)
        if (parsed.lock) return { contents, lock: parsed.lock }
        lastUncertain = parsed.uncertain
        await Bun.sleep(10)
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined
        try {
          await fs.stat(DaemonPaths.runtimeLock())
        } catch (statError) {
          if (errorCode(statError) === "ENOENT") return undefined
        }
        await Bun.sleep(10)
      }
    }
    // An existing lock that never yielded contents cannot be quarantined safely.
    return lastContents === undefined ? { uncertain: true } : { contents: lastContents, uncertain: lastUncertain }
  }

  function parseLockInfo(contents: string): LockInfo | undefined {
    return parseLockContents(contents).lock
  }

  function parseLockContents(contents: string): { lock?: LockInfo; uncertain: boolean } {
    let value: unknown
    try {
      value = JSON.parse(contents)
    } catch {
      return { uncertain: true }
    }
    const lock = isLockInfo(value) ? value : undefined
    return { lock, uncertain: lock === undefined }
  }

  function isLockInfo(value: unknown): value is LockInfo {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const lock = value as Record<string, unknown>
    return (
      typeof lock.pid === "number" &&
      Number.isInteger(lock.pid) &&
      lock.pid > 0 &&
      typeof lock.startedAt === "number" &&
      Number.isFinite(lock.startedAt) &&
      (lock.ownerToken === undefined || typeof lock.ownerToken === "string") &&
      (lock.processStartIdentity === undefined || typeof lock.processStartIdentity === "string") &&
      Array.isArray(lock.command) &&
      lock.command.every((part) => typeof part === "string") &&
      typeof lock.cwd === "string" &&
      (lock.mode === "server" || lock.mode === "daemon")
    )
  }

  async function quarantineStaleLock(lockPath: string, expectedContents: string | undefined) {
    if (expectedContents === undefined) return false
    const quarantinePath = `${lockPath}.stale-${randomUUID()}`
    try {
      await fs.rename(lockPath, quarantinePath)
      const quarantinedContents = await fs.readFile(quarantinePath, "utf8").catch(() => undefined)
      if (quarantinedContents !== expectedContents) {
        await restoreQuarantinedLock(quarantinePath, lockPath)
        return false
      }
      await fs.rm(quarantinePath, { force: true }).catch(() => {})
      return true
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false
      throw error
    }
  }

  async function removeOwnedLock(
    lockPath: string,
    owner: { pid: number; ownerToken: string; processStartIdentity: string },
  ) {
    const quarantinePath = `${lockPath}.release-${randomUUID()}`
    try {
      await fs.rename(lockPath, quarantinePath)
      const current = await fs.readFile(quarantinePath, "utf8").then((contents) => {
        try {
          return JSON.parse(contents) as LockInfo
        } catch {
          return undefined
        }
      })
      if (
        current?.pid === owner.pid &&
        current.ownerToken === owner.ownerToken &&
        current.processStartIdentity === owner.processStartIdentity
      ) {
        await fs.rm(quarantinePath, { force: true }).catch(() => {})
      } else {
        await restoreQuarantinedLock(quarantinePath, lockPath)
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return
    }
  }

  async function restoreQuarantinedLock(quarantinePath: string, lockPath: string) {
    try {
      await fs.rename(quarantinePath, lockPath)
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error
    }
  }

  function errorCode(error: unknown) {
    return (error as { code?: string })?.code
  }

  async function isPidAlive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) === "EPERM"
    }
  }

  async function isProcessOwnerAlive(lock: LockInfo) {
    if (!(await isPidAlive(lock.pid))) return false
    if (!lock.processStartIdentity || lock.processStartIdentity.startsWith("unknown:")) return true
    const current = await getProcessStartIdentity(lock.pid)
    return current === undefined || current === lock.processStartIdentity
  }

  async function getProcessStartIdentity(pid: number) {
    if (pid === process.pid) {
      ownProcessStartIdentity ??= queryProcessStartIdentity(pid)
      return ownProcessStartIdentity
    }
    return queryProcessStartIdentity(pid)
  }

  async function queryProcessStartIdentity(pid: number) {
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
      const closingParen = stat.lastIndexOf(")")
      const fields =
        closingParen < 0
          ? []
          : stat
              .slice(closingParen + 1)
              .trim()
              .split(/\s+/)
      const startTicks = fields[19]
      if (startTicks) return `linux:${startTicks}`
    }

    if (process.platform === "win32") {
      const wmic = await execFileAsync("wmic.exe", [
        "process",
        "where",
        `(ProcessId=${pid})`,
        "get",
        "CreationDate",
        "/value",
      ]).catch(() => ({ stdout: "" }))
      const creationDate = wmic.stdout.match(/CreationDate=(\d+)/)?.[1]
      if (creationDate) return `windows:${creationDate}`

      const result = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]).catch(() => ({ stdout: "" }))
      const ticks = result.stdout.trim()
      if (ticks) return `windows:${ticks}`

      return undefined
    }

    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]).catch(() => ({ stdout: "" }))
    const startedAt = Date.parse(result.stdout.trim())
    return Number.isNaN(startedAt) ? undefined : `unix:${startedAt}`
  }

  export async function inspect(lock: LockInfo, input?: { healthUrl?: string }): Promise<ProcessInspection> {
    if (!(await isProcessOwnerAlive(lock))) {
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
