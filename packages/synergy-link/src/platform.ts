import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawn, spawnSync } from "node:child_process"
import { SynergyLinkHost } from "@ericsanchezok/synergy-link-protocol"

const SIGTERM_GRACE_MS = 1_000
const SIGKILL_TIMEOUT_MS = 1_000
const PROCESS_GROUP_EXIT_POLL_MS = 25
const PROCESS_LIST_MAX_BUFFER = 8 * 1024 * 1024
const PROCESS_LIST_TIMEOUT_MS = 5_000
// Keep raw process command/environment text inside the child pipeline so Link receives only
// numeric process topology and marker matches; never simplify this into JS-side env parsing.
const PROCESS_OWNER_SCAN_SCRIPT = String.raw`
include_no_tty=$1
shift
ps eww "$include_no_tty" -o pid=,ppid=,pgid=,command= 2>/dev/null |
  awk '
    BEGIN {
      for (argumentIndex = 1; argumentIndex < ARGC; argumentIndex += 1) {
        markers[argumentIndex] = "SYNERGY_LINK_PROCESS_OWNER=" ARGV[argumentIndex]
        delete ARGV[argumentIndex]
      }
    }
    {
      pid = $1
      parentPid = $2
      processGroupId = $3
      command = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", command)
      owned = 0
      for (markerIndex in markers) {
        start = index(command, markers[markerIndex])
        if (start == 0) continue
        nextCharacter = substr(command, start + length(markers[markerIndex]), 1)
        if (nextCharacter == "" || nextCharacter ~ /[[:space:]]/) {
          owned = 1
          break
        }
      }
      print pid, parentPid, processGroupId, owned
    }
  ' "$@"
`
const PROCESS_SCAN_PATH = "/usr/bin:/bin"
const ESC = "\u001b"

export type ProcessEnv = Record<string, string | undefined>
export type ChildLike = { pid?: number; kill(signal?: number | NodeJS.Signals): boolean }
export const SYNERGY_LINK_PROCESS_OWNER_ENV = "SYNERGY_LINK_PROCESS_OWNER"
export interface KillTreeOptions {
  ownerMarker?: string
}

export namespace Platform {
  export function runtime(): SynergyLinkHost.Runtime {
    if (typeof process.versions?.bun === "string") return "bun"
    if (typeof process.versions?.node === "string") return "node"
    return "unknown"
  }

  export function defaultShell(): SynergyLinkHost.Shell {
    if (process.platform === "win32") {
      const comspec = (process.env.ComSpec || process.env.COMSPEC || "").toLowerCase()
      if (comspec.includes("pwsh")) return "pwsh"
      if (comspec.includes("powershell")) return "powershell"
      return "cmd"
    }
    return "sh"
  }

  export function supportedShells(): SynergyLinkHost.Shell[] {
    return process.platform === "win32" ? ["cmd", "powershell", "pwsh"] : ["sh"]
  }

  export function detectCapabilities(): SynergyLinkHost.Capabilities {
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: safeHostname(),
      runtime: runtime(),
      defaultShell: defaultShell(),
      supportedShells: supportedShells(),
      supportsPty: false,
      supportsSendKeys: true,
      supportsSoftKill: process.platform !== "win32",
      supportsProcessGroups: process.platform !== "win32",
      envCaseInsensitive: process.platform === "win32",
      lineEndings: process.platform === "win32" ? "crlf" : "lf",
    }
  }

  export function normalizeEnv(env: ProcessEnv): ProcessEnv {
    if (process.platform !== "win32") {
      return { ...env }
    }

    const result: ProcessEnv = {}
    const entries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
    const seen = new Set<string>()
    for (const [key, value] of entries) {
      const upper = key.toUpperCase()
      if (seen.has(upper) && key !== "Path") continue
      seen.add(upper)
      result[key === "PATH" ? "Path" : key] = value
    }
    return result
  }

  export function resolveShellLaunch(command: string): { shell: SynergyLinkHost.Shell; file: string; args: string[] } {
    if (process.platform === "win32") {
      return {
        shell: "cmd",
        file: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", command],
      }
    }

    return {
      shell: "sh",
      file: "/bin/sh",
      args: ["-c", command],
    }
  }

  export async function killTree(child: ChildLike, exited?: () => boolean, options?: KillTreeOptions): Promise<void> {
    const pid = child.pid
    if (process.platform === "win32") {
      if (!pid || exited?.()) return
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    const trackedProcessAlive = Boolean(pid && !exited?.())
    const processGroups = new Set<number>()
    if (trackedProcessAlive && pid) processGroups.add(pid)
    if (options?.ownerMarker) {
      for (const processGroupId of ownedProcessGroups([options.ownerMarker])) processGroups.add(processGroupId)
    }
    if (processGroups.size === 0) return

    const trackedGroupSignaled = pid ? signalProcessGroups(processGroups, "SIGTERM").has(pid) : true
    if (trackedProcessAlive && !trackedGroupSignaled) child.kill("SIGTERM")
    const trackedProcessExited = trackedGroupSignaled
      ? waitForProcessGroupsExit(processGroups, SIGTERM_GRACE_MS)
      : waitForChildExit(exited, SIGTERM_GRACE_MS)
    await trackedProcessExited

    const killProcessGroups = new Set<number>()
    if (trackedProcessAlive && pid && !exited?.()) killProcessGroups.add(pid)
    if (options?.ownerMarker) {
      for (const processGroupId of ownedProcessGroups([options.ownerMarker])) killProcessGroups.add(processGroupId)
    }
    signalExistingProcessGroups(killProcessGroups, "SIGKILL")
    if (trackedProcessAlive && !exited?.() && !trackedGroupSignaled) child.kill("SIGKILL")
    await Promise.all([
      waitForProcessGroupsExit(killProcessGroups, SIGKILL_TIMEOUT_MS),
      trackedGroupSignaled ? Promise.resolve(true) : waitForChildExit(exited, SIGKILL_TIMEOUT_MS),
    ])
  }

  export async function killOwnedByMarker(ownerMarker: string): Promise<void> {
    return killOwnedByMarkers([ownerMarker])
  }

  export async function killOwnedByMarkers(ownerMarkers: Iterable<string>): Promise<void> {
    if (process.platform === "win32") return
    const markers = [...new Set(ownerMarkers)].filter(Boolean)
    if (markers.length === 0) return
    const processGroups = new Set(ownedProcessGroups(markers))
    if (processGroups.size === 0) return

    signalProcessGroups(processGroups, "SIGTERM")
    await waitForProcessGroupsExit(processGroups, SIGTERM_GRACE_MS)
    const killProcessGroups = new Set(ownedProcessGroups(markers))
    signalExistingProcessGroups(killProcessGroups, "SIGKILL")
    await waitForProcessGroupsExit(killProcessGroups, SIGKILL_TIMEOUT_MS)
  }

  export function encodeKeySequence(keys: string[]): { data: string; warnings: string[] } {
    const warnings: string[] = []
    let data = ""
    for (const token of keys) {
      data += encodeKeyToken(token, warnings)
    }
    return { data, warnings }
  }

  export function resolveWorkdir(workdir?: string): string {
    if (!workdir) return process.cwd()
    if (path.isAbsolute(workdir)) return workdir
    return path.resolve(process.cwd(), workdir)
  }

  export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

function encodeKeyToken(raw: string, warnings: string[]): string {
  const token = raw.trim()
  if (!token) return ""
  if (token.length === 2 && token.startsWith("^")) {
    const ctrl = toCtrlChar(token[1])
    if (ctrl) return ctrl
  }

  const parsed = parseModifiers(token)
  const named = namedKey(parsed.base.toLowerCase())
  if (named) {
    return parsed.alt ? `${ESC}${named}` : named
  }

  if (parsed.base.length === 1) {
    let value = parsed.shift && /[a-z]/.test(parsed.base) ? parsed.base.toUpperCase() : parsed.base
    if (parsed.ctrl) value = toCtrlChar(value) || value
    if (parsed.alt) value = `${ESC}${value}`
    return value
  }

  if (parsed.hasModifiers) {
    warnings.push(`Unknown key \"${parsed.base}\" for modifiers; sending literal.`)
  }
  return parsed.base
}

interface ProcessTableEntry {
  parentPid: number
  processGroupId: number
}

function ownedProcessGroups(ownerMarkers: Iterable<string>): number[] {
  const markers = [...new Set(ownerMarkers)].filter(Boolean)
  if (markers.length === 0) return []
  const includeNoTty = process.platform === "darwin" ? "-x" : "x"
  const result = spawnSync(
    "/bin/sh",
    ["-c", PROCESS_OWNER_SCAN_SCRIPT, "synergy-link-process-scan", includeNoTty, ...markers],
    {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      env: { PATH: PROCESS_SCAN_PATH },
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
      timeout: PROCESS_LIST_TIMEOUT_MS,
    },
  )
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return []

  const processes = new Map<number, ProcessTableEntry>()
  const descendants = new Set<number>()
  const processGroups = new Set<number>()
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([01])$/)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const processGroupId = Number(match[3])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId)) {
      continue
    }
    processes.set(pid, { parentPid, processGroupId })
    if (match[4] !== "1") continue
    descendants.add(pid)
    if (processGroupId > 0) processGroups.add(processGroupId)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [pid, entry] of processes) {
      if (descendants.has(pid) || !descendants.has(entry.parentPid)) continue
      descendants.add(pid)
      if (entry.processGroupId > 0) processGroups.add(entry.processGroupId)
      changed = true
    }
  }
  return [...processGroups]
}

function signalProcessGroups(processGroups: Iterable<number>, signal: NodeJS.Signals): Set<number> {
  const signaled = new Set<number>()
  for (const processGroupId of processGroups) {
    try {
      process.kill(-processGroupId, signal)
      signaled.add(processGroupId)
    } catch {}
  }
  return signaled
}

function signalExistingProcessGroups(processGroups: Iterable<number>, signal: NodeJS.Signals): void {
  for (const processGroupId of processGroups) {
    if (!processGroupExists(processGroupId)) continue
    try {
      process.kill(-processGroupId, signal)
    } catch {}
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessGroupsExit(processGroups: Iterable<number>, timeoutMs: number): Promise<boolean> {
  const groups = [...processGroups]
  const deadline = Date.now() + timeoutMs
  while (groups.some(processGroupExists)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return groups.every((processGroupId) => !processGroupExists(processGroupId))
    await Platform.sleep(Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs))
  }
  return true
}

async function waitForChildExit(exited: (() => boolean) | undefined, timeoutMs: number): Promise<boolean> {
  if (!exited) {
    await Platform.sleep(timeoutMs)
    return false
  }

  const deadline = Date.now() + timeoutMs
  while (!exited()) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return exited()
    await Platform.sleep(Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs))
  }
  return true
}

function parseModifiers(token: string) {
  let rest = token
  let ctrl = false
  let alt = false
  let shift = false
  let hasModifiers = false

  while (rest.length > 2 && rest[1] === "-") {
    const mod = rest[0].toLowerCase()
    if (mod === "c") ctrl = true
    else if (mod === "m") alt = true
    else if (mod === "s") shift = true
    else break
    hasModifiers = true
    rest = rest.slice(2)
  }

  return { base: rest, ctrl, alt, shift, hasModifiers }
}

function namedKey(input: string): string | undefined {
  const map = new Map<string, string>([
    ["enter", "\r"],
    ["return", "\r"],
    ["tab", "\t"],
    ["escape", ESC],
    ["esc", ESC],
    ["space", " "],
    ["backspace", process.platform === "win32" ? "\b" : "\u007f"],
    ["up", `${ESC}[A`],
    ["down", `${ESC}[B`],
    ["right", `${ESC}[C`],
    ["left", `${ESC}[D`],
    ["home", `${ESC}[1~`],
    ["end", `${ESC}[4~`],
    ["pageup", `${ESC}[5~`],
    ["pagedown", `${ESC}[6~`],
    ["insert", `${ESC}[2~`],
    ["delete", `${ESC}[3~`],
    ["f1", `${ESC}OP`],
    ["f2", `${ESC}OQ`],
    ["f3", `${ESC}OR`],
    ["f4", `${ESC}OS`],
    ["f5", `${ESC}[15~`],
    ["f6", `${ESC}[17~`],
    ["f7", `${ESC}[18~`],
    ["f8", `${ESC}[19~`],
    ["f9", `${ESC}[20~`],
    ["f10", `${ESC}[21~`],
    ["f11", `${ESC}[23~`],
    ["f12", `${ESC}[24~`],
  ])
  return map.get(input)
}

function toCtrlChar(char: string): string | null {
  if (char.length !== 1) return null
  if (char === "?") return "\u007f"
  const code = char.toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 0x1f) : null
}

function safeHostname(): string | undefined {
  try {
    return os.hostname()
  } catch {
    return undefined
  }
}
