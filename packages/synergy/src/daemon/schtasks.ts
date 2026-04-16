import fs from "fs/promises"
import path from "path"
import { DaemonPaths } from "./paths"
import type { DaemonService } from "./service"

const TASK_ENV_SKIP = new Set(["SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP"])

const TASK_RUNNING_PATTERN = /\bRunning\b|正在运行|正在執行/i

export const SchtasksService: DaemonService.Service = {
  manager: "schtasks",
  async install(spec) {
    await assertSchtasksAvailable()
    await fs.mkdir(DaemonPaths.logs(), { recursive: true })
    await fs.mkdir(path.dirname(DaemonPaths.windowsTaskScript()), { recursive: true })
    await fs.writeFile(DaemonPaths.windowsTaskScript(), renderTaskScript(spec), "utf8")
    await fs.writeFile(DaemonPaths.windowsLauncher(), renderLauncherVbs(), "utf8")
    const launcher = `wscript.exe ${quoteTaskArg(DaemonPaths.windowsLauncher())}`
    const onlogon = await schtasks(
      ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", spec.label, "/TR", launcher],
      true,
    )
    if (onlogon.exitCode === 0) return
    await schtasks([
      "/Create",
      "/F",
      "/SC",
      "ONCE",
      "/ST",
      "23:59",
      "/RL",
      "LIMITED",
      "/TN",
      spec.label,
      "/TR",
      launcher,
    ])
  },
  async uninstall(spec) {
    await assertSchtasksAvailable()
    await schtasks(["/End", "/TN", spec.label], true)
    await schtasks(["/Delete", "/F", "/TN", spec.label], true)
    await fs.rm(DaemonPaths.windowsTaskScript(), { force: true }).catch(() => {})
    await fs.rm(DaemonPaths.windowsLauncher(), { force: true }).catch(() => {})
  },
  async start(spec) {
    await assertSchtasksAvailable()
    await schtasks(["/Run", "/TN", spec.label])
  },
  async stop(spec) {
    await assertSchtasksAvailable()
    await schtasks(["/End", "/TN", spec.label], true)
  },
  async restart(spec) {
    await assertSchtasksAvailable()
    await schtasks(["/End", "/TN", spec.label], true)
    await schtasks(["/Run", "/TN", spec.label])
  },
  async status(spec) {
    try {
      await assertSchtasksAvailable()
    } catch (error) {
      return {
        installed: false,
        running: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const result = await schtasks(["/Query", "/TN", spec.label], true)
    if (result.exitCode !== 0) {
      return {
        installed: false,
        running: false,
        detail: "Scheduled Task not registered",
      }
    }

    const running = TASK_RUNNING_PATTERN.test(result.stdout)
    return {
      installed: true,
      running,
      detail: running ? "Scheduled Task running" : "Scheduled Task registered",
    }
  },
}

function renderTaskScript(spec: DaemonService.InstallSpec) {
  const lines = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "chcp 65001 >nul 2>&1",
    `cd /d ${quoteCmdArg(spec.cwd)} || exit /b 1`,
  ]
  for (const [key, value] of Object.entries(spec.env)) {
    if (!value || TASK_ENV_SKIP.has(key.toUpperCase())) continue
    lines.push(`set "${key}=${escapeCmdValue(value)}"`)
  }
  lines.push(spec.command.map((part) => quoteCmdArg(part)).join(" ") + ` 1>>${quoteCmdArg(spec.logFile)} 2>&1`)
  return lines.join("\r\n") + "\r\n"
}

function renderLauncherVbs() {
  const cmdPath = DaemonPaths.windowsTaskScript().replaceAll('"', '""')
  return [`Set ws = CreateObject("WScript.Shell")`, `ws.Run """${cmdPath}""", 0, False`].join("\r\n") + "\r\n"
}

function quoteTaskArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`
}

function quoteCmdArg(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function escapeCmdValue(value: string) {
  return value
    .replaceAll("^", "^^")
    .replaceAll("%", "%%")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>")
    .replaceAll("(", "^(")
    .replaceAll(")", "^)")
}

async function assertSchtasksAvailable() {
  const result = await schtasks(["/Query", "/?"], true)
  if (result.exitCode === 0) return
  throw new Error(`schtasks unavailable: exit code ${result.exitCode}`)
}

async function schtasks(args: string[], allowFailure = false) {
  const proc = Bun.spawn(["schtasks", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (!allowFailure && exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `schtasks failed with exit code ${exitCode}`
    throw new Error(detail)
  }
  return { exitCode, stdout, stderr }
}
