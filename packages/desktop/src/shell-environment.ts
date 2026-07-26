import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const LOGIN_PATH_START = "\0SYNERGY_PATH_START\0"
const LOGIN_PATH_END = "\0SYNERGY_PATH_END\0"
const LOGIN_PATH_COMMAND = `/bin/sh -c 'printf "\\0SYNERGY_PATH_START\\0%s\\0SYNERGY_PATH_END\\0" "$PATH"'`
const LOGIN_SHELL_TIMEOUT_MS = 3_000
const LOGIN_SHELL_MAX_BUFFER = 64 * 1024
const MAX_PATH_ENTRIES = 256
const MAX_PATH_ENTRY_LENGTH = 4_096
const DIAGNOSTIC_COMMANDS = ["bun", "node", "npm", "pnpm", "git", "gh", "python3", "python", "cargo", "go", "docker"]

export type DesktopShellEnvironmentSource = "login-shell" | "inherited"

export type DesktopShellCommandResolution = {
  command: string
  path: string | null
}

export type DesktopShellEnvironmentDiagnostics = {
  source: DesktopShellEnvironmentSource
  shell: string | null
  path: string
  commands: DesktopShellCommandResolution[]
  warning: "login-shell-unavailable" | null
}

type RunLoginShell = (shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>
type ResolveCommands = (pathValue: string) => DesktopShellCommandResolution[]

export type DesktopShellEnvironmentOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  userShell?: string | null
  runLoginShell?: RunLoginShell
  resolveCommands?: ResolveCommands
}

export class DesktopShellEnvironment {
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly userShell: string | null
  private readonly runLoginShell: RunLoginShell
  private readonly resolveCommands: ResolveCommands
  private resolution: Promise<DesktopShellEnvironmentDiagnostics> | null = null

  constructor(options: DesktopShellEnvironmentOptions = {}) {
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.userShell = options.userShell === undefined ? systemLoginShell(this.platform) : options.userShell
    this.runLoginShell = options.runLoginShell ?? runLoginShell
    this.resolveCommands =
      options.resolveCommands ??
      ((pathValue) =>
        resolvePathCommands(pathValue, DIAGNOSTIC_COMMANDS, {
          platform: this.platform,
          pathExt: this.env.PATHEXT,
        }))
  }

  resolve(): Promise<DesktopShellEnvironmentDiagnostics> {
    this.resolution ??= this.resolveOnce()
    return this.resolution
  }

  private async resolveOnce(): Promise<DesktopShellEnvironmentDiagnostics> {
    const inheritedPath = normalizePathValue(this.env.PATH ?? "", this.platform)
    if (this.platform === "win32") return this.diagnostics("inherited", null, inheritedPath, null)
    const shell = resolveLoginShell(this.userShell, this.env, this.platform)
    if (!shell) return this.diagnostics("inherited", null, inheritedPath, "login-shell-unavailable")

    try {
      const output = await this.runLoginShell(shell, ["-ilc", LOGIN_PATH_COMMAND], this.env)
      const loginPath = parseLoginShellPath(output, this.platform)
      if (!loginPath) return this.diagnostics("inherited", shell, inheritedPath, "login-shell-unavailable")
      return this.diagnostics("login-shell", shell, mergePathValues(loginPath, inheritedPath, this.platform), null)
    } catch {
      return this.diagnostics("inherited", shell, inheritedPath, "login-shell-unavailable")
    }
  }

  private diagnostics(
    source: DesktopShellEnvironmentSource,
    shell: string | null,
    pathValue: string,
    warning: "login-shell-unavailable" | null,
  ): DesktopShellEnvironmentDiagnostics {
    return {
      source,
      shell,
      path: pathValue,
      commands: this.resolveCommands(pathValue),
      warning,
    }
  }
}

export function parseLoginShellPath(output: string, platform: NodeJS.Platform = process.platform): string | null {
  const start = output.lastIndexOf(LOGIN_PATH_START)
  if (start < 0) return null
  const valueStart = start + LOGIN_PATH_START.length
  const end = output.indexOf(LOGIN_PATH_END, valueStart)
  if (end < 0) return null
  const value = normalizePathValue(output.slice(valueStart, end), platform)
  return value || null
}

export function normalizePathValue(value: string, platform: NodeJS.Platform = process.platform): string {
  const entries: string[] = []
  const seen = new Set<string>()
  const pathApi = platform === "win32" ? path.win32 : path.posix
  for (const rawEntry of value.split(pathApi.delimiter)) {
    if (entries.length >= MAX_PATH_ENTRIES) break
    const entry = rawEntry.trim()
    if (entry.length > MAX_PATH_ENTRY_LENGTH || /[\x00-\x1f\x7f]/.test(entry) || !pathApi.isAbsolute(entry)) continue
    const normalized = pathApi.normalize(entry)
    const key = platform === "win32" ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(normalized)
  }
  return entries.join(pathApi.delimiter)
}

export function mergePathValues(
  primary: string,
  fallback: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter
  return normalizePathValue([primary, fallback].filter(Boolean).join(delimiter), platform)
}

export function resolvePathCommands(
  pathValue: string,
  commands: string[] = DIAGNOSTIC_COMMANDS,
  options: {
    isExecutable?: (candidate: string) => boolean
    platform?: NodeJS.Platform
    pathExt?: string
  } = {},
): DesktopShellCommandResolution[] {
  const isExecutable = options.isExecutable ?? executableFile
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const pathEntries = normalizePathValue(pathValue, platform).split(pathApi.delimiter).filter(Boolean)
  const extensions = executableExtensions(platform, options.pathExt)
  return commands.map((command) => ({
    command,
    path:
      pathEntries
        .flatMap((entry) => commandCandidates(pathApi.join(entry, command), pathApi, extensions))
        .find(isExecutable) ?? null,
  }))
}

function executableExtensions(platform: NodeJS.Platform, pathExt: string | undefined): string[] {
  if (platform !== "win32") return [""]
  return (pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
}

function commandCandidates(candidate: string, pathApi: typeof path.posix, extensions: string[]): string[] {
  if (pathApi.extname(candidate)) return [candidate]
  return extensions.map((extension) => `${candidate}${extension}`)
}

function resolveLoginShell(userShell: string | null, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null
  const candidates = [userShell, env.SHELL, platform === "darwin" ? "/bin/zsh" : "/bin/bash", "/bin/sh"]
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && path.isAbsolute(candidate) && executableFile(candidate)),
    ) ?? null
  )
}

function systemLoginShell(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null
  try {
    return os.userInfo().shell || null
  } catch {
    return null
  }
}

async function runLoginShell(shell: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(shell, args, {
    env,
    timeout: LOGIN_SHELL_TIMEOUT_MS,
    maxBuffer: LOGIN_SHELL_MAX_BUFFER,
    encoding: "utf8",
  })
  return result.stdout
}

function executableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}
