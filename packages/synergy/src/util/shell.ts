import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
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
    taskkillTimeoutMs: number
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
      const succeeded = await runTaskkill(runtime, pid)
      if ((!opts?.allowExitedParent && didExit(opts?.exited)) || (succeeded && !isPidAlive(runtime, pid))) return
      try {
        proc.kill("SIGKILL")
      } catch {}
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
    } catch (_e) {
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
      process.kill(-pid, 0)
      process.kill(-pid, "SIGKILL")
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
    const shell = process.env.SHELL
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
      return process.env.COMSPEC || "cmd.exe"
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

  export const preferred = lazy(() => resolve())

  export const acceptable = lazy(() => resolve({ allowBlacklisted: false }))
}
