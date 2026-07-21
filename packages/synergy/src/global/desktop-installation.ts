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

  export interface PathCandidateFilesystem {
    access(path: string): Promise<void>
    realpath(path: string): Promise<string>
  }

  export interface DesktopPackageVersionStatus {
    status: "matching" | "mismatch" | "unavailable" | "not-applicable"
    runtimeVersion: string
    packageVersion: string | null
    metadataPath: string | null
    message: string
  }

  export interface WindowsUserPathStore {
    read(): Promise<string | null>
    write(value: string): Promise<void>
    broadcast?(): Promise<void>
  }

  export interface WindowsUserPathRemovalResult {
    removed: boolean
    previousValue: string
    nextValue: string
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

  export function runtimeRoot(realExecPath: string, platform: NodeJS.Platform) {
    const pathModule = platform === "win32" ? path.win32 : path
    return pathModule.resolve(realExecPath, "..", "..")
  }

  export function packageVersionMetadataPath(realExecPath: string, platform: NodeJS.Platform) {
    if (!isRuntimePath(platform, realExecPath)) return null
    const pathModule = platform === "win32" ? path.win32 : path
    return pathModule.join(runtimeRoot(realExecPath, platform), "desktop-package.json")
  }

  export async function packageVersionStatus(
    context: Context,
    runtimeVersion: string,
  ): Promise<DesktopPackageVersionStatus> {
    if (!detectDesktopInstall(context)) {
      return {
        status: "not-applicable",
        runtimeVersion,
        packageVersion: null,
        metadataPath: null,
        message: "Desktop package version is only checked for Desktop-managed runtimes.",
      }
    }

    const metadataPath = packageVersionMetadataPath(context.realExecPath, context.platform)
    if (!metadataPath) {
      return {
        status: "unavailable",
        runtimeVersion,
        packageVersion: null,
        metadataPath: null,
        message: "Desktop package version metadata is unavailable.",
      }
    }

    const metadata = await readPackageVersionMetadata(metadataPath)
    if (!metadata) {
      return {
        status: "unavailable",
        runtimeVersion,
        packageVersion: null,
        metadataPath,
        message: "Desktop package version metadata could not be read.",
      }
    }

    if (metadata.version !== runtimeVersion) {
      return {
        status: "mismatch",
        runtimeVersion,
        packageVersion: metadata.version,
        metadataPath,
        message: `Desktop package version ${metadata.version} does not match runtime version ${runtimeVersion}.`,
      }
    }

    return {
      status: "matching",
      runtimeVersion,
      packageVersion: metadata.version,
      metadataPath,
      message: `Desktop package version ${metadata.version} matches runtime version ${runtimeVersion}.`,
    }
  }

  async function readPackageVersionMetadata(metadataPath: string) {
    const text = await fs.readFile(metadataPath, "utf8").catch(() => null)
    if (!text) return null
    const parsed = parseJsonObject(text)
    if (!parsed || typeof parsed.version !== "string" || parsed.version.length === 0) return null
    return { version: parsed.version }
  }

  function parseJsonObject(text: string) {
    try {
      return JSON.parse(text) as { version?: unknown }
    } catch {
      return null
    }
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

  export function removePathEntry(pathValue: string, entryToRemove: string, platform: NodeJS.Platform) {
    const delimiter = platform === "win32" ? ";" : path.delimiter
    return pathValue
      .split(delimiter)
      .filter((entry) => entry.length > 0 && !samePath(entry, entryToRemove, platform))
      .join(delimiter)
  }

  export async function removeWindowsUserPathEntry(
    entryToRemove: string,
    store: WindowsUserPathStore = windowsUserPathStore(),
  ): Promise<WindowsUserPathRemovalResult> {
    const previousValue = (await store.read()) ?? ""
    const nextValue = removePathEntry(previousValue, entryToRemove, "win32")
    if (nextValue === previousValue) return { removed: false, previousValue, nextValue }
    await store.write(nextValue)
    await store.broadcast?.()
    return { removed: true, previousValue, nextValue }
  }

  function windowsUserPathStore(): WindowsUserPathStore {
    return {
      async read() {
        const proc = Bun.spawn(["reg.exe", "query", "HKCU\\Environment", "/v", "Path"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
        if (exitCode !== 0) return ""
        const line = output
          .split(/\r?\n/)
          .map((item) => item.trim())
          .find((item) => item.toLowerCase().startsWith("path"))
        if (!line) return ""
        const parts = line.split(/\s{2,}/)
        return parts.at(-1) ?? ""
      },
      async write(value) {
        await Bun.spawn(
          ["reg.exe", "add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", value, "/f"],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        ).exited
      },
      async broadcast() {
        await Bun.spawn([
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          '[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User"), "User")',
        ]).exited
      },
    }
  }

  export async function pathCandidates(
    context: Context,
    filesystem: PathCandidateFilesystem = fs,
  ): Promise<PathCandidate[]> {
    const commandNames = context.platform === "win32" ? ["synergy.cmd", "synergy.exe", "synergy.bat"] : ["synergy"]
    const candidates: PathCandidate[] = []
    const seen = new Set<string>()
    for (const dir of userPathEntries(context.env, context.platform)) {
      for (const commandName of commandNames) {
        const candidate = context.platform === "win32" ? path.win32.join(dir, commandName) : path.join(dir, commandName)
        const key = normalizePath(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        const exists = await filesystem
          .access(candidate)
          .then(() => true)
          .catch(() => false)
        if (!exists) continue
        const isCurrent = await isCurrentPathCandidate(context, candidate, filesystem)
        candidates.push({ path: candidate, isCurrent })
      }
    }
    return candidates
  }

  async function isCurrentPathCandidate(context: Context, candidate: string, filesystem: PathCandidateFilesystem) {
    if (isDesktopWindowsLauncherCandidate(context, candidate)) return true
    const realCandidate = await filesystem.realpath(candidate).catch(() => candidate)
    return samePath(realCandidate, context.realExecPath, context.platform)
  }

  function isDesktopWindowsLauncherCandidate(context: Context, candidate: string) {
    if (context.platform !== "win32") return false
    if (!detectDesktopInstall(context)) return false
    const expectedLink = linkPath(context)
    if (!expectedLink) return false
    return samePath(candidate, expectedLink, "win32")
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
