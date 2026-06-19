import * as path from "path"
import type { PrepareLinuxWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./platform"

export namespace LinuxBackend {
  /**
   * Prepare a Linux bwrap (bubblewrap) sandbox wrapper.
   *
   * Key design invariants:
   * - NEVER --ro-bind / /  (full root filesystem exposure)
   * - Bind runtime read roots individually
   * - Bind active workspace
   * - Controlled tmp via workspace .synergy/tmp
   * - Final args: bwrap <mounts> -- <command> <args...>
   */
  export function prepare(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
    const { command, args, workspace, sandboxMode, runtimeReadRoots, forcePlatform } = opts

    if (sandboxMode === "none") {
      return { command, args, sandboxed: false }
    }

    const platform = forcePlatform ?? detectPlatform()
    if (platform !== "linux") {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Linux sandbox (bwrap) not available on platform "${platform}"`,
      }
    }

    const roots = runtimeReadRoots ?? []
    const bwrapArgs: string[] = []

    // Bind each runtime root
    for (const root of roots) {
      bwrapArgs.push("--bind", root, root)
    }

    // Bind workspace (read-write)
    bwrapArgs.push("--bind", workspace, workspace)

    // Controlled tmp
    const tmpDir = path.join(workspace, ".synergy", "tmp")
    bwrapArgs.push("--bind", tmpDir, "/tmp")

    // Separator for command
    bwrapArgs.push("--")

    return {
      command: "bwrap",
      args: [...bwrapArgs, command, ...args],
      sandboxed: true,
    }
  }
}
