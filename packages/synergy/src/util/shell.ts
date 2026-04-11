import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import { accessSync, constants } from "fs"
import path from "path"
import { spawn, type ChildProcess } from "child_process"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch (_e) {
      proc.kill("SIGTERM")
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
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
        const bash = path.join(git, "..", "..", "bin", "bash.exe")
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
