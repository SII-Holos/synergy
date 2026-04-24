import fs from "fs/promises"
import { DaemonPaths } from "./paths"

export namespace SingleInstance {
  export interface LockInfo {
    pid: number
    startedAt: number
    command: string[]
    cwd: string
    mode: "server" | "daemon"
  }

  export class AlreadyRunningError extends Error {
    constructor(readonly lock: LockInfo) {
      super(`Another Synergy instance is already running (pid ${lock.pid})`)
      this.name = "AlreadyRunningError"
    }
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

    process.once("exit", () => {
      void release()
    })
    process.once("SIGINT", () => {
      void release()
    })
    process.once("SIGTERM", () => {
      void release()
    })

    return { release }
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
}
