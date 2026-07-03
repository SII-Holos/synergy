import fs from "fs/promises"
import path from "path"

export namespace DesktopInstallation {
  export interface Context {
    platform: NodeJS.Platform
    execPath: string
    realExecPath: string
    env?: NodeJS.ProcessEnv
  }

  export interface CliLinkStatus {
    path: string | null
    status: "healthy" | "missing" | "broken" | "conflict" | "not-applicable"
    target: string | null
    message: string
  }

  export interface PathCandidate {
    path: string
    isCurrent: boolean
  }

  export function normalizePath(value: string) {
    return value.replace(/\\/g, "/").toLowerCase()
  }

  export function isRuntimePath(platform: NodeJS.Platform, realExecPath: string) {
    const normalized = normalizePath(realExecPath)
    if (platform === "darwin") return normalized.endsWith(".app/contents/resources/synergy/bin/synergy")
    if (platform === "win32") return normalized.endsWith("/resources/synergy/bin/synergy.exe")
    if (platform === "linux") return normalized === "/opt/synergy/resources/synergy/bin/synergy"
    return false
  }

  export function detectDesktopInstall(input: Context) {
    return isRuntimePath(input.platform, input.realExecPath)
  }

  export function expectedRuntimePath(platform: NodeJS.Platform) {
    if (platform === "darwin") return "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy"
    if (platform === "linux") return "/opt/Synergy/resources/synergy/bin/synergy"
    return null
  }

  export function launcherDirectory(context: Context) {
    if (context.platform !== "win32") return null
    const normalized = context.realExecPath.replace(/\\/g, path.win32.sep)
    const installRoot = path.win32.resolve(normalized, "..", "..", "..", "..")
    return path.win32.join(installRoot, "bin")
  }

  export function linkPath(context: Context) {
    if (context.platform === "darwin") return "/usr/local/bin/synergy"
    if (context.platform === "linux") return "/usr/bin/synergy"
    if (context.platform === "win32") {
      const launcherDir = launcherDirectory(context)
      return launcherDir ? path.win32.join(launcherDir, "synergy.cmd") : null
    }
    return null
  }

  export async function inspectCliLink(context: Context): Promise<CliLinkStatus> {
    const publicPath = linkPath(context)
    if (!publicPath) {
      return {
        path: null,
        status: "not-applicable",
        target: null,
        message: "Desktop CLI links are not configured on this platform.",
      }
    }

    if (context.platform === "win32") return inspectWindowsLauncher(context, publicPath)
    return inspectSymlink(context, publicPath)
  }

  async function inspectSymlink(context: Context, publicPath: string): Promise<CliLinkStatus> {
    const stat = await fs.lstat(publicPath).catch(() => null)
    if (!stat)
      return { path: publicPath, status: "missing", target: null, message: "Desktop CLI link is not installed." }
    if (!stat.isSymbolicLink()) {
      return {
        path: publicPath,
        status: "conflict",
        target: null,
        message: "Desktop CLI link path exists but is not a symlink.",
      }
    }

    const target = await fs.readlink(publicPath).catch(() => null)
    const realTarget = await fs.realpath(publicPath).catch(() => null)
    if (!realTarget) return { path: publicPath, status: "broken", target, message: "Desktop CLI link is broken." }
    if (!isRuntimePath(context.platform, realTarget)) {
      return {
        path: publicPath,
        status: "conflict",
        target: realTarget,
        message: "Desktop CLI link points to a different command.",
      }
    }

    const executable = await fs
      .access(realTarget, fs.constants.X_OK)
      .then(() => true)
      .catch(() => false)
    if (!executable) {
      return {
        path: publicPath,
        status: "broken",
        target: realTarget,
        message: "Desktop CLI target is not executable.",
      }
    }
    return {
      path: publicPath,
      status: "healthy",
      target: realTarget,
      message: "Desktop CLI link points to the embedded runtime.",
    }
  }

  async function inspectWindowsLauncher(context: Context, publicPath: string): Promise<CliLinkStatus> {
    const exists = await fs
      .access(publicPath)
      .then(() => true)
      .catch(() => false)
    const launcherDir = launcherDirectory(context)
    const pathContainsLauncher = launcherDir
      ? userPathEntries(context.env, context.platform).some((entry) => samePath(entry, launcherDir, "win32"))
      : false
    if (!exists)
      return { path: publicPath, status: "missing", target: null, message: "Desktop CLI launcher is not installed." }
    if (!pathContainsLauncher) {
      return {
        path: publicPath,
        status: "broken",
        target: context.realExecPath,
        message: "Desktop CLI launcher directory is not in the user PATH.",
      }
    }
    return {
      path: publicPath,
      status: "healthy",
      target: context.realExecPath,
      message: "Desktop CLI launcher forwards to the embedded runtime.",
    }
  }

  export function userPathEntries(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
    const delimiter = platform === "win32" ? ";" : path.delimiter
    return (env.Path ?? env.PATH ?? "").split(delimiter).filter(Boolean)
  }

  export async function pathCandidates(context: Context): Promise<PathCandidate[]> {
    const commandNames = context.platform === "win32" ? ["synergy.cmd", "synergy.exe", "synergy.bat"] : ["synergy"]
    const candidates: PathCandidate[] = []
    const seen = new Set<string>()
    for (const dir of userPathEntries(context.env, context.platform)) {
      for (const commandName of commandNames) {
        const candidate = context.platform === "win32" ? path.win32.join(dir, commandName) : path.join(dir, commandName)
        const key = normalizePath(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        const exists = await fs
          .access(candidate)
          .then(() => true)
          .catch(() => false)
        if (!exists) continue
        const realCandidate = await fs.realpath(candidate).catch(() => candidate)
        candidates.push({ path: candidate, isCurrent: samePath(realCandidate, context.realExecPath, context.platform) })
      }
    }
    return candidates
  }

  export function samePath(a: string, b: string, platform: NodeJS.Platform) {
    if (platform === "win32" || platform === "darwin") return normalizePath(a) === normalizePath(b)
    return a === b
  }

  export function desktopRemovalHint(platform: NodeJS.Platform) {
    if (platform === "darwin")
      return "To remove the Desktop app, move Synergy.app to Trash or rerun the Desktop installer."
    if (platform === "win32") return "To remove the Desktop app, uninstall Synergy from Windows Apps & Features."
    if (platform === "linux")
      return "To remove the Desktop app, run apt remove or your Linux package manager for Synergy."
    return "Remove the Desktop app with your platform package manager."
  }
}
