import fs from "fs"
import { homedir } from "os"
import path from "path"
import { Installation } from "../global/installation"
import { DaemonPaths } from "./paths"

export namespace DaemonCommand {
  export interface Spec {
    cmd: string[]
    cwd: string
    env: Record<string, string>
  }

  export function resolve(input: { hostname: string; port: number }): Spec {
    const baseEnv = buildServiceEnv()

    const explicit = process.env.SYNERGY_BIN_PATH
    if (explicit) {
      return {
        cmd: [
          explicit,
          "server",
          "--managed-service",
          "--non-interactive",
          "--no-banner",
          "--print-logs",
          "--hostname",
          input.hostname,
          "--port",
          String(input.port),
        ],
        cwd: serviceWorkingDirectory(),
        env: baseEnv,
      }
    }

    const execPath = process.execPath
    const basename =
      process.platform === "win32" ? path.win32.basename(execPath).toLowerCase() : path.basename(execPath).toLowerCase()
    if (basename === "synergy" || basename === "synergy.exe") {
      return {
        cmd: [
          execPath,
          "server",
          "--managed-service",
          "--non-interactive",
          "--no-banner",
          "--print-logs",
          "--hostname",
          input.hostname,
          "--port",
          String(input.port),
        ],
        cwd: serviceWorkingDirectory(),
        env: baseEnv,
      }
    }

    if (Installation.isLocal()) {
      const entry = "src/daemon/entry.ts"
      const packageRoot = path.resolve(import.meta.dir, "../..")
      if (!fs.existsSync(path.join(packageRoot, entry))) {
        throw new Error("Could not resolve the local Synergy TypeScript entrypoint for background service installation")
      }

      return {
        cmd: [
          execPath,
          "run",
          "--cwd",
          packageRoot,
          "--conditions=browser",
          entry,
          "--hostname",
          input.hostname,
          "--port",
          String(input.port),
        ],
        cwd: serviceWorkingDirectory(),
        env: baseEnv,
      }
    }

    const script = path.resolve(import.meta.dir, "../../bin/synergy")
    if (!fs.existsSync(script)) {
      throw new Error("Could not resolve a stable Synergy CLI entrypoint for background service installation")
    }

    return {
      cmd: [
        execPath,
        script,
        "server",
        "--managed-service",
        "--non-interactive",
        "--no-banner",
        "--hostname",
        input.hostname,
        "--port",
        String(input.port),
      ],
      cwd: serviceWorkingDirectory(),
      env: baseEnv,
    }
  }

  export function shellQuote(parts: string[]) {
    return parts.map((part) => shellEscape(part)).join(" ")
  }

  function shellEscape(value: string) {
    if (value.length === 0) return "''"
    if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'"'"'`)}'`
  }

  export function serviceLabel() {
    if (process.platform === "linux") return "synergy"
    if (process.platform === "win32") return "Synergy"
    return "dev.synergy.server"
  }

  export function logPath() {
    return DaemonPaths.logFile()
  }

  function serviceWorkingDirectory() {
    return process.env.SYNERGY_CWD || process.env.HOME || process.env.USERPROFILE || homedir() || process.cwd()
  }

  function buildServiceEnv(): Record<string, string> {
    const source = process.env
    const env: Record<string, string> = {}
    for (const key of Object.keys(source)) {
      const value = source[key]
      if (typeof value !== "string") continue
      if (ENV_VOLATILE.has(key)) continue
      env[key] = value
    }
    env.SYNERGY_DAEMON = "1"
    return env
  }

  const ENV_VOLATILE = new Set([
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "TERMINAL_EMULATOR",
    "COLORTERM",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "WINDOWID",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "PROMPT",
    "PROMPT_COMMAND",
    "PS1",
    "PS2",
    "SSH_CLIENT",
    "SSH_CONNECTION",
    "SSH_TTY",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SESSIONNAME",
    "LOGONSERVER",
    "SHELL",
    "BASH_ENV",
    "ZSH_VERSION",
    "BASH_VERSINFO",
    "RANDOM",
    "LINENO",
    "HISTFILE",
    "HISTSIZE",
    "HISTCONTROL",
    "HISTTIMEFORMAT",
    "COMP_WORDBREAKS",
    "BASHOPTS",
    "SHELLOPTS",
    "STARSHIP_SESSION_KEY",
    "STARSHIP_SHELL",
    "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_MAIN",
    "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
    "VSCODE_GIT_IPC_HANDLE",
    "VSCODE_INJECTION",
    "GIT_ASKPASS",
    "SYNERGY_CLIENT",
    "SYNERGY_CALLER",
  ])
}
