import { RuntimeContext } from "../lifecycle/context"
import { Flag } from "../flag/flag"
import { lazy } from "./lazy"
import { accessSync, constants } from "fs"
import path from "path"
import { spawn, type ChildProcess } from "child_process"

const SIGKILL_TIMEOUT_MS = 200
const TASKKILL_TIMEOUT_MS = 2_000

export namespace Shell {
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

  export function releaseOwnedProcessGroup(proc: ChildProcess): void {
    if (process.platform === "win32" || !proc.pid) return
    try {
      process.kill(-proc.pid, "SIGTERM")
    } catch {}
  }

  export async function killTree(
    proc: ChildProcess,
    opts?: { exited?: () => boolean; allowExitedParent?: boolean; runtime?: KillTreeRuntimeForTest },
  ): Promise<void> {
    try {
      await killTreeOnce(proc, opts)
    } catch {}
  }

  async function killTreeOnce(
    proc: ChildProcess,
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
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!didExit(opts?.exited)) {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
      return
    }

    await Bun.sleep(SIGKILL_TIMEOUT_MS)
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
  const BLACKLIST = new Set(["fish", "nu"])

  function basename(filepath: string) {
    return process.platform === "win32" ? path.win32.basename(filepath, ".exe") : path.basename(filepath)
  }

  function isValid(filepath?: string) {
    if (!filepath) return false
    try {
      accessSync(filepath, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  function resolve({ allowBlacklisted = true }: { allowBlacklisted?: boolean } = {}) {
    const shell = RuntimeContext.current().host.env.SHELL
    if (!shell || !isValid(shell)) return fallback()
    if (!allowBlacklisted && BLACKLIST.has(basename(shell).toLowerCase())) return fallback()
    return shell
  }

  function fallback() {
    if (process.platform === "win32") {
      if (Flag.SYNERGY_GIT_BASH_PATH) return Flag.SYNERGY_GIT_BASH_PATH
      const git = Bun.which("git")
      if (git) {
        // git.exe is typically at: C:\Program Files\Git\cmd\git.exe
        // bash.exe is at: C:\Program Files\Git\bin\bash.exe
        const bash = path.join(path.dirname(git), "..", "bin", "bash.exe")
        if (Bun.file(bash).size) return bash
      }
      return RuntimeContext.current().host.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") {
      const candidates = ["/bin/zsh", "/bin/bash", "/bin/sh"]
      for (const shell of candidates) {
        if (isValid(shell)) return shell
      }
      return "/bin/sh"
    }
    // Linux: Test multiple shell candidates with validation
    const bashCandidates = [Bun.which("bash"), "/bin/bash", "/usr/bin/bash"]
    for (const shell of bashCandidates) {
      if (shell && isValid(shell)) return shell
    }
    return "/bin/sh"
  }

  const choices = RuntimeContext.state(() => ({
    preferred: lazy(() => resolve()),
    acceptable: lazy(() => resolve({ allowBlacklisted: false })),
  }))

  export const preferred = Object.assign(() => choices().preferred(), { reset: () => choices().preferred.reset() })
  export const acceptable = Object.assign(() => choices().acceptable(), { reset: () => choices().acceptable.reset() })
}
