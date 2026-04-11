import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { MetaProtocolHost } from "@ericsanchezok/meta-protocol"

const SIGKILL_TIMEOUT_MS = 200
const ESC = "\u001b"

export type ProcessEnv = Record<string, string | undefined>
export type ChildLike = { pid?: number; kill(signal?: number | NodeJS.Signals): boolean }

export namespace Platform {
  export function runtime(): MetaProtocolHost.Runtime {
    if (typeof process.versions?.bun === "string") return "bun"
    if (typeof process.versions?.node === "string") return "node"
    return "unknown"
  }

  export function defaultShell(): MetaProtocolHost.Shell {
    if (process.platform === "win32") {
      const comspec = (process.env.ComSpec || process.env.COMSPEC || "").toLowerCase()
      if (comspec.includes("pwsh")) return "pwsh"
      if (comspec.includes("powershell")) return "powershell"
      return "cmd"
    }
    return "sh"
  }

  export function supportedShells(): MetaProtocolHost.Shell[] {
    return process.platform === "win32" ? ["cmd", "powershell", "pwsh"] : ["sh"]
  }

  export function detectCapabilities(): MetaProtocolHost.Capabilities {
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

  export function resolveShellLaunch(command: string): { shell: MetaProtocolHost.Shell; file: string; args: string[] } {
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

  export async function killTree(child: ChildLike, exited?: () => boolean): Promise<void> {
    const pid = child.pid
    if (!pid || exited?.()) return

    if (process.platform === "win32") {
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

    try {
      process.kill(-pid, "SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!exited?.()) process.kill(-pid, "SIGKILL")
      return
    } catch {}

    child.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!exited?.()) child.kill("SIGKILL")
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
