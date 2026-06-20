import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import type { PrepareWrapperOpts, SandboxExecutionWrapper, SeatbeltProfileOpts } from "./types"
import { DEFAULT_PROTECTED_PATHS, uniqueRoots, traversalLiterals, defaultRuntimeReadRoots } from "./policy"
import { detectPlatform } from "./detect"
import { getTempDir } from "./platform"
import { MacOSPolicy } from "./macos-policy"
import { buildPermissionProfile } from "./policy-engine"

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export namespace MacBackend {
  /**
   * Generate a macOS Seatbelt profile as an ordered array of lines.
   *
   * macOS `sandbox-exec` is not usable for normal shell commands with a pure
   * `(deny default)` baseline without a very large platform-specific allowlist.
   * This backend therefore uses `(allow default)` for process viability, then
   * denies broad user-data roots (for example the home directory) and re-allows
   * only the active workspace / controlled temp paths. This preserves the
   * important Synergy boundary: commands cannot read or write sibling worktrees,
   * the original checkout, or other user data under home unless the active
   * workspace explicitly covers them.
   *
   * Order matters (last-match-wins): broad user-data denies come before active
   * workspace allows; protected write denies come last.
   */
  export function generateSeatbeltProfile(opts: SeatbeltProfileOpts): string[] {
    const { workspace, sandboxMode, runtimeReadRoots, writableRoots, protectedPaths } = opts
    const dataDenyRoots = opts.dataDenyRoots ?? []
    const literalReadRoots =
      opts.literalReadRoots ?? traversalLiterals([workspace, ...runtimeReadRoots, ...writableRoots])
    const lines: string[] = []

    lines.push("(version 1)")
    lines.push("(allow default)")
    lines.push("(allow process-exec)")

    for (const root of dataDenyRoots) {
      lines.push(`(deny file-read* file-write* (subpath "${root}"))`)
    }

    for (const root of runtimeReadRoots) {
      lines.push(`(allow file-read* (subpath "${root}") (literal "${root}"))`)
    }

    for (const root of literalReadRoots) {
      lines.push(`(allow file-read* (literal "${root}"))`)
    }

    lines.push(`(allow file-read* (subpath "${workspace}") (literal "${workspace}"))`)

    if (sandboxMode === "workspace_write") {
      const writeRoots = [...writableRoots]
      writeRoots.push(path.join(workspace, ".synergy", "tmp"))

      for (const root of writeRoots) {
        lines.push(`(allow file-read* file-write* (subpath "${root}"))`)
      }
    }

    // 6. Protected path deny rules (after allows — last-match-wins)
    for (const pp of protectedPaths) {
      lines.push(`(deny file-write* (subpath "${pp}"))`)
    }

    return lines
  }

  /**
   * Prepare a macOS sandbox execution wrapper.
   *
   * macOS → sandbox-exec -f <tmpProfile> <command> <args...>
   * none  → returns unwrapped, sandboxed=false
   * other → returns unwrapped with skipReason
   */
  export function prepare(opts: PrepareWrapperOpts): SandboxExecutionWrapper {
    const { command, args, workspace, sandboxMode, forcePlatform } = opts

    if (sandboxMode === "none") {
      return { command, args, sandboxed: false }
    }

    const platform = forcePlatform ?? detectPlatform()

    if (platform !== "macos") {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Sandbox not available on platform "${platform}"`,
      }
    }

    // ── Deny-default (Codex parity) SBPL path ────────────────────────
    // When the backend is explicitly set to "seatbelt-deny-default",
    // use the parameterized (deny default) profile compiler instead of
    // the legacy (allow default) approach. This produces stricter
    // sandbox profiles that match Codex's macOS sandbox behavior.
    if (opts.backend === "seatbelt-deny-default") {
      const policyProfile = buildPermissionProfile({
        workspace,
        executionCwd: opts.executionCwd ?? workspace,
        sandboxMode,
        approvedReadPaths: [],
        approvedWritePaths: [],
        approvedNetwork: false,
        approvedUnixSockets: [],
      })
      const sbplContent = MacOSPolicy.compileProfile(policyProfile)
      const params = MacOSPolicy.generateParams(policyProfile)
      const tempPath = writeTempString(sbplContent)

      const dArgs = Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`])

      return {
        command: "sandbox-exec",
        args: ["-f", tempPath, ...dArgs, command, ...args],
        sandboxed: true,
        tempPath,
      }
    }

    // ── Legacy allow-default path ─────────────────────────────────────
    const runtimeReadRoots = uniqueRoots([
      ...(opts.runtimeReadRoots ?? defaultRuntimeReadRoots(os.homedir())),
      ...(opts.extraReadRoots ?? []),
    ])
    const writableRoots = uniqueRoots([...(opts.writableRoots ?? [workspace]), ...(opts.extraWritableRoots ?? [])])
    const protectedPaths = opts.protectedPaths ?? DEFAULT_PROTECTED_PATHS(os.homedir(), workspace)
    const dataDenyRoots = opts.dataDenyRoots ?? [os.homedir()]
    const literalReadRoots = traversalLiterals([
      workspace,
      opts.executionCwd ?? workspace,
      ...runtimeReadRoots,
      ...writableRoots,
    ])

    const profile = generateSeatbeltProfile({
      workspace,
      sandboxMode,
      runtimeReadRoots,
      literalReadRoots,
      writableRoots,
      protectedPaths,
      dataDenyRoots,
    })

    const tempPath = writeTempProfile(profile)

    return {
      command: "sandbox-exec",
      args: ["-f", tempPath, command, ...args],
      sandboxed: true,
      tempPath,
    }
  }

  /**
   * Clean up a sandbox temp profile file by exact path.
   * Best-effort; errors are silently swallowed.
   */
  export function cleanupTemp(tempPath: string): void {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // best-effort cleanup
    }
  }

  function writeTempProfile(profileLines: string[]): string {
    const filePath = path.join(getTempDir(), `synergy-sandbox-${randomId()}.sb`)
    fs.writeFileSync(filePath, profileLines.join("\n"), "utf-8")
    return filePath
  }

  function writeTempString(content: string): string {
    const filePath = path.join(getTempDir(), `synergy-sandbox-${randomId()}.sb`)
    fs.writeFileSync(filePath, content, "utf-8")
    return filePath
  }
}
