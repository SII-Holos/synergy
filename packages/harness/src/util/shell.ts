import { RuntimeContext } from "../lifecycle/context"
import { Flag } from "../flag/flag"
import { lazy } from "./lazy"
import { accessSync, constants } from "fs"
import path from "path"
import { ProcessGroup } from "@ericsanchezok/synergy-util/process-group"

export namespace Shell {
  export type KillTreeRuntimeForTest = ProcessGroup.KillTreeRuntimeForTest
  export type ProcessInvocation = ProcessGroup.ProcessInvocation
  export const prepareOwnedProcessGroup = ProcessGroup.prepareOwnedProcessGroup
  export const releaseOwnedProcessGroup = ProcessGroup.releaseOwnedProcessGroup
  export const killTree = ProcessGroup.killTree

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
