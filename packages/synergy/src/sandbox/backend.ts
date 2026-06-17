import * as os from "os"
import * as path from "path"
import * as fs from "fs"

// ---------------------------------------------------------------------------
// SandboxBackend — real sandbox execution backend
//
// macOS:  sandbox-exec + Seatbelt profile (argv-based, not shell string)
// Linux:  bwrap (bubblewrap), individual bind mounts, no --ro-bind /
// Windows: unsupported
//
// Design invariants:
// - prepareWrapper writes a temp .sb profile; execute cleans it in finally.
// - Seatbelt uses allow-default for OS viability, then explicitly denies user-data roots
//   and re-allows the active workspace / controlled temp paths.
// - Protected paths (deny file-write*) follow write-allow rules (last-match-wins).
// - bwrap never --ro-bind /; only runtime roots + workspace + controlled tmp.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface PlatformInfo {
  platform: string
  available: boolean
  backend: string | null
}

export interface PrepareWrapperOpts {
  command: string
  args: string[]
  workspace: string
  sandboxMode: "none" | "read_only" | "workspace_write"
  forcePlatform?: string
  runtimeReadRoots?: string[]
  writableRoots?: string[]
  protectedPaths?: string[]
  dataDenyRoots?: string[]
}

export interface PrepareLinuxWrapperOpts {
  command: string
  args: string[]
  workspace: string
  sandboxMode: "none" | "read_only" | "workspace_write"
  runtimeReadRoots?: string[]
  forcePlatform?: string
}

export interface SeatbeltProfileOpts {
  workspace: string
  sandboxMode: "read_only" | "workspace_write"
  runtimeReadRoots: string[]
  writableRoots: string[]
  protectedPaths: string[]
  dataDenyRoots: string[]
}
export interface SandboxExecutionWrapper {
  command: string
  args: string[]
  sandboxed: boolean
  skipReason?: string
  tempPath?: string
}

export interface ExecuteOpts {
  fallbackPolicy?: "warn" | "allow" | "deny"
}

export interface ExecuteResult {
  exitCode: number | null
  stdout: string
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const DEFAULT_RUNTIME_READ_ROOTS = ["/usr/lib", "/System/Library", "/bin", "/usr/bin"]

const DEFAULT_PROTECTED_PATHS = (homedir: string, workspace: string): string[] => [
  path.join(workspace, ".git"),
  path.join(homedir, ".synergy", "config"),
  path.join(homedir, ".synergy", "data", "auth", "api-key.json"),
]

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function detectPlatform(): string {
  const p = os.platform()
  if (p === "darwin") return "macos"
  if (p === "linux") return "linux"
  if (p === "win32") return "windows"
  return p
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}
function writeTempProfile(profileLines: string[]): string {
  const filePath = path.join("/tmp", `synergy-sandbox-${randomId()}.sb`)
  fs.writeFileSync(filePath, profileLines.join("\n"), "utf-8")
  return filePath
}

// ------------------------------------------------------------------
// SandboxBackend
// ------------------------------------------------------------------

export namespace SandboxBackend {
  /**
   * Return platform detection info without side effects.
   */
  export function platformInfo(): PlatformInfo {
    const platform = detectPlatform()
    const available = platform === "macos"
    return {
      platform,
      available,
      backend: available ? "sandbox-exec" : null,
    }
  }

  /**
   * Check whether a given os.platform() string is supported.
   * "win32" → false, "darwin" → true, "linux" → true (bwrap).
   */
  export function isPlatformSupported(rawPlatform: string): boolean {
    if (rawPlatform === "darwin" || rawPlatform === "macos") return true
    if (rawPlatform === "linux") return true
    return false
  }

  // ----------------------------------------------------------------
  // Profile generation
  // ----------------------------------------------------------------

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
    const lines: string[] = []

    lines.push("(version 1)")
    lines.push("(allow default)")
    lines.push("(allow process-exec)")

    // 3. Runtime read roots are documented explicitly even though allow-default
    // makes them available. They are useful for audit/debugging and keep the
    // generated profile's intent clear.
    for (const root of runtimeReadRoots) {
      lines.push(`(allow file-read* (subpath "${root}"))`)
    }

    // 4. Deny broad user-data roots, then re-allow the active workspace below.
    // If the workspace is under the user's home directory, last-match-wins keeps
    // that workspace accessible while sibling checkouts remain blocked.
    for (const root of dataDenyRoots) {
      lines.push(`(deny file-read* file-write* (subpath "${root}"))`)
    }

    lines.push(`(allow file-read* (subpath "${workspace}"))`)

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

  // ----------------------------------------------------------------
  // Wrapper preparation
  // ----------------------------------------------------------------

  /**
   * Prepare a sandbox execution wrapper for the current platform.
   *
   * macOS → sandbox-exec -f <tmpProfile> <command> <args...>
   * linux → not implemented here (use prepareLinuxWrapper)
   * other → returns unwrapped with skipReason
   * none  → returns unwrapped, sandboxed=false
   */
  export function prepareWrapper(opts: PrepareWrapperOpts): SandboxExecutionWrapper {
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

    const runtimeReadRoots = opts.runtimeReadRoots ?? DEFAULT_RUNTIME_READ_ROOTS
    const writableRoots = opts.writableRoots ?? [workspace]
    const protectedPaths = opts.protectedPaths ?? DEFAULT_PROTECTED_PATHS(os.homedir(), workspace)
    const dataDenyRoots = opts.dataDenyRoots ?? [os.homedir()]

    const profile = generateSeatbeltProfile({
      workspace,
      sandboxMode,
      runtimeReadRoots,
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
   * Prepare a Linux bwrap (bubblewrap) sandbox wrapper.
   *
   * Key design:
   * - NEVER --ro-bind / /  (full root filesystem exposure)
   * - Bind runtime read roots individually with --bind (read-write, minimal)
   * - Bind active workspace with --bind
   * - Use --bind for controlled tmp
   * - Final args: bwrap <mounts> -- <command> <args...>
   */
  export function prepareLinuxWrapper(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
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

  // ----------------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------------

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

  // ----------------------------------------------------------------
  // Execution
  // ----------------------------------------------------------------

  /**
   * Execute the sandbox wrapper.
   *
   * If sandbox is unavailable (skipReason set):
   *   - deny  → throws immediately
   *   - warn  → runs command directly (unsandboxed)
   *   - allow → runs command directly (unsandboxed)
   *
   * If sandbox is active:
   *   - Spawns the wrapper command (e.g. sandbox-exec)
   *   - Cleans up the temp profile in a finally block
   *   - Throws on non-zero exit code
   */
  export function execute(wrapper: SandboxExecutionWrapper, opts?: ExecuteOpts): ExecuteResult {
    // --- unsandboxed fallback path ---
    if (wrapper.skipReason) {
      const policy = opts?.fallbackPolicy ?? "warn"
      if (policy === "deny") {
        throw new Error(`Sandbox execution denied: ${wrapper.skipReason}`)
      }
      // warn / allow: run directly
      const result = Bun.spawnSync({
        cmd: [wrapper.command, ...wrapper.args],
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) {
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ""
        throw new Error(`Command failed (unsandboxed) with exit code ${result.exitCode}: ${stderr.trim()}`)
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "",
      }
    }

    // --- sandboxed path ---
    const tempPath = wrapper.tempPath
    try {
      const result = Bun.spawnSync({
        cmd: [wrapper.command, ...wrapper.args],
        stdout: "pipe",
        stderr: "pipe",
      })

      if (result.exitCode !== 0) {
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ""
        throw new Error(`Sandbox command failed with exit code ${result.exitCode}: ${stderr.trim()}`)
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "",
      }
    } finally {
      // Clean up temp profile even on failure
      if (tempPath) {
        cleanupTemp(tempPath)
      }
    }
  }
}
