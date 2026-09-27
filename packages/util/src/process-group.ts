import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200
const TASKKILL_TIMEOUT_MS = 2_000

interface ProcessHandle {
  readonly pid?: number
  stop?(): Promise<void>
  kill(signal?: NodeJS.Signals | number): boolean
}

export namespace ProcessGroup {
  interface TaskkillProcess {
    once(event: "exit", listener: (code: number | null) => void): this
    once(event: "error", listener: () => void): this
    kill(): boolean
  }

  export interface KillTreeRuntimeForTest {
    platform: NodeJS.Platform
    taskkill(pid: number): TaskkillProcess
    isPidAlive(pid: number): boolean
    signalProcessGroup?(pid: number, signal: NodeJS.Signals | number): void
    taskkillTimeoutMs: number
  }

  export type ProcessInvocation = {
    command: string
    args: string[]
  }

  /**
   * Wrap an invocation so it leads its own process group and keeps that group
   * alive briefly after exit, without inserting a process between the caller
   * and `invocation.command`.
   *
   * `exec` is load-bearing: callers correlate kernel-side facts with
   * `child.pid` — the macOS sandbox audit record that names a denied path and
   * access is attributed to the exec'd image — and an intermediate shell would
   * be a different pid, silently detaching that evidence from the child. The
   * ownership anchor therefore cannot be a fixed `sleep` started up front; it
   * polls the pid it shares with the exec'd image and anchors the group only
   * once that image has exited.
   */
  export function prepareOwnedProcessGroup(
    invocation: ProcessInvocation,
    platform: NodeJS.Platform = process.platform,
  ): ProcessInvocation {
    if (platform === "win32") return invocation
    return {
      command: "/bin/sh",
      args: [
        "-c",
        '(while kill -0 $$ 2>/dev/null; do sleep 0.2; done; sleep 5) </dev/null >/dev/null 2>&1 & exec "$0" "$@"',
        invocation.command,
        ...invocation.args,
      ],
    }
  }

  export function releaseOwnedProcessGroup(proc: ProcessHandle): void {
    if (process.platform === "win32" || !proc.pid) return
    try {
      process.kill(-proc.pid, "SIGTERM")
    } catch {}
  }

  export async function killTree(
    proc: ProcessHandle,
    opts?: { exited?: () => boolean; allowExitedParent?: boolean; runtime?: KillTreeRuntimeForTest },
  ): Promise<void> {
    try {
      if (proc.stop) await proc.stop()
      else await killTreeOnce(proc, opts)
    } catch {}
  }

  async function killTreeOnce(
    proc: ProcessHandle,
    opts?: { exited?: () => boolean; allowExitedParent?: boolean; runtime?: KillTreeRuntimeForTest },
  ): Promise<void> {
    const pid = proc.pid
    if (!pid || (!opts?.allowExitedParent && didExit(opts?.exited))) return
    const runtime = opts?.runtime ?? killTreeRuntime

    if (runtime.platform === "win32") {
      if (didExit(opts?.exited)) return
      const succeeded = await runTaskkill(runtime, pid)
      if (didExit(opts?.exited) || (succeeded && !isPidAlive(runtime, pid))) return
      try {
        proc.kill("SIGKILL")
      } catch {}
      return
    }

    const signalProcessGroup = runtime.signalProcessGroup ?? ((target, signal) => process.kill(-target, signal))
    try {
      signalProcessGroup(pid, "SIGTERM")
    } catch (_e) {
      if (didExit(opts?.exited)) return
      try {
        proc.kill("SIGTERM")
      } catch {}
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!didExit(opts?.exited)) {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
      return
    }

    await sleep(SIGKILL_TIMEOUT_MS)
    try {
      signalProcessGroup(pid, 0)
      signalProcessGroup(pid, "SIGKILL")
    } catch {}
  }

  function didExit(exited: (() => boolean) | undefined) {
    try {
      return exited?.() ?? false
    } catch {
      return false
    }
  }

  function isPidAlive(runtime: KillTreeRuntimeForTest, pid: number) {
    try {
      return runtime.isPidAlive(pid)
    } catch {
      return true
    }
  }

  const killTreeRuntime: KillTreeRuntimeForTest = {
    platform: process.platform,
    taskkill: (pid) => spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" }),
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
      }
    },
    taskkillTimeoutMs: TASKKILL_TIMEOUT_MS,
  }

  function runTaskkill(runtime: KillTreeRuntimeForTest, pid: number): Promise<boolean> {
    return new Promise((resolve) => {
      let killer: TaskkillProcess
      try {
        killer = runtime.taskkill(pid)
      } catch {
        resolve(false)
        return
      }
      let settled = false
      const finish = (succeeded: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(succeeded)
      }
      const timer = setTimeout(() => {
        try {
          killer.kill()
        } catch {}
        finish(false)
      }, runtime.taskkillTimeoutMs)
      killer.once("exit", (code) => finish(code === 0))
      killer.once("error", () => finish(false))
    })
  }
}
