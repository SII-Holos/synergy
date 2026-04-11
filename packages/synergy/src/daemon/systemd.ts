import fs from "fs/promises"
import path from "path"
import { DaemonPaths } from "./paths"
import type { DaemonService } from "./service"

const UNIT_PROPERTIES = ["LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID"] as const

export const SystemdUserService: DaemonService.Service = {
  manager: "systemd-user",
  async install(spec) {
    await assertSystemdUserAvailable()
    await fs.mkdir(DaemonPaths.logs(), { recursive: true })
    await fs.mkdir(DaemonPaths.systemdUserDir(), { recursive: true })
    await Bun.write(DaemonPaths.systemdUnit(spec.label), renderUnit(spec))
    await systemctlUser(["daemon-reload"])
    await systemctlUser(["enable", "--now", spec.label + ".service"])
  },
  async uninstall(spec) {
    await assertSystemdUserAvailable()
    await systemctlUser(["disable", "--now", spec.label + ".service"], true)
    await fs.rm(DaemonPaths.systemdUnit(spec.label), { force: true }).catch(() => {})
    await systemctlUser(["daemon-reload"], true)
  },
  async start(spec) {
    await assertSystemdUserAvailable()
    await systemctlUser(["start", spec.label + ".service"])
  },
  async stop(spec) {
    await assertSystemdUserAvailable()
    await systemctlUser(["stop", spec.label + ".service"], true)
  },
  async restart(spec) {
    await assertSystemdUserAvailable()
    await systemctlUser(["restart", spec.label + ".service"])
  },
  async status(spec) {
    const exists = await Bun.file(DaemonPaths.systemdUnit(spec.label))
      .exists()
      .catch(() => false)
    try {
      await assertSystemdUserAvailable()
    } catch (error) {
      return {
        installed: exists,
        running: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const result = await systemctlUser(
      ["show", "--property=" + UNIT_PROPERTIES.join(","), spec.label + ".service"],
      true,
    )

    if (result.exitCode !== 0) {
      const detail = readDetail(result)
      return {
        installed: exists,
        running: false,
        detail,
      }
    }

    const parsed = parseShow(readStdout(result))
    const installed = exists || parsed.loadState === "loaded" || parsed.unitFileState === "enabled"
    const running = parsed.activeState === "active"

    return {
      installed,
      running,
      detail: formatShowDetail(parsed),
    }
  },
}

function renderUnit(spec: DaemonService.InstallSpec) {
  const execStart = renderExecStart(spec.command)
  const environment = Object.entries(spec.env)
    .filter((entry) => entry[1] !== undefined)
    .map(([key, value]) => `Environment=${key}=${quoteValue(value)}`)
    .join("\n")

  return `[Unit]
Description=Synergy Background Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.cwd}
ExecStart=${execStart}
Restart=on-failure
RestartSec=2
KillMode=control-group
TimeoutStartSec=30
TimeoutStopSec=30
SuccessExitStatus=0 143
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}
${environment}

[Install]
WantedBy=default.target
`
}

function renderExecStart(parts: string[]) {
  return parts.map((part) => quoteArg(part)).join(" ")
}

function quoteArg(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function quoteValue(value: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error("systemd environment values must not contain CR or LF")
  }
  return quoteArg(value)
}

type ShowInfo = {
  loadState?: string
  activeState?: string
  subState?: string
  unitFileState?: string
  mainPid?: string
}

function parseShow(text: string): ShowInfo {
  const result: ShowInfo = {}
  for (const line of text.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split("=")
    if (!rawKey || rest.length === 0) continue
    const value = rest.join("=").trim()
    switch (rawKey.trim()) {
      case "LoadState":
        result.loadState = value
        break
      case "ActiveState":
        result.activeState = value
        break
      case "SubState":
        result.subState = value
        break
      case "UnitFileState":
        result.unitFileState = value
        break
      case "MainPID":
        result.mainPid = value
        break
    }
  }
  return result
}

function formatShowDetail(info: ShowInfo) {
  const parts = [
    info.loadState ? `LoadState=${info.loadState}` : undefined,
    info.activeState ? `ActiveState=${info.activeState}` : undefined,
    info.subState ? `SubState=${info.subState}` : undefined,
    info.unitFileState ? `UnitFileState=${info.unitFileState}` : undefined,
    info.mainPid && info.mainPid !== "0" ? `MainPID=${info.mainPid}` : undefined,
  ].filter(Boolean)
  return parts.join(", ")
}

async function assertSystemdUserAvailable() {
  const result = await systemctlUser(["status"], true)
  if (result.exitCode === 0) return
  const detail = readDetail(result)
  if (!detail) {
    throw new Error("systemctl --user unavailable: unknown error")
  }
  if (/command not found|not found/i.test(detail)) {
    throw new Error("systemctl not available; systemd user services are required on Linux")
  }
  if (
    /Failed to connect to bus|No medium found|not been booted with systemd|System has not been booted/i.test(detail)
  ) {
    throw new Error(`systemctl --user unavailable: ${detail}`)
  }
  throw new Error(`systemctl --user unavailable: ${detail}`)
}

async function systemctlUser(args: string[], allowFailure = false) {
  const proc = Bun.spawn(["systemctl", "--user", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (!allowFailure && exitCode !== 0) {
    throw new Error(readDetail({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode }))
  }
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }
}

function readStdout(result: { stdout: Buffer }) {
  return result.stdout.toString("utf8").trim()
}

function readDetail(result: { stdout: Buffer; stderr: Buffer; exitCode: number }) {
  return (
    result.stderr.toString("utf8").trim() ||
    result.stdout.toString("utf8").trim() ||
    `systemctl --user failed with exit code ${result.exitCode}`
  )
}
