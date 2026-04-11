import fs from "fs/promises"
import { Global } from "../global"
import { DaemonPaths } from "./paths"
import type { DaemonService } from "./service"

export const LaunchdService: DaemonService.Service = {
  manager: "launchd",
  async install(spec) {
    const uid = currentUid()
    await fs.mkdir(DaemonPaths.logs(), { recursive: true })
    await fs.mkdir(`${Global.Path.home}/Library/LaunchAgents`, { recursive: true })
    await launchctl(["bootout", `gui/${uid}/${spec.label}`], true)
    await Bun.write(DaemonPaths.launchAgent(spec.label), renderPlist(spec))
    await launchctl(["bootstrap", `gui/${uid}`, DaemonPaths.launchAgent(spec.label)], true)
  },
  async uninstall(spec) {
    const uid = currentUid()
    await launchctl(["bootout", `gui/${uid}/${spec.label}`], true)
    await fs.rm(DaemonPaths.launchAgent(spec.label), { force: true }).catch(() => {})
  },
  async start(spec) {
    const uid = currentUid()
    await ensureLoaded(uid, spec)
    await launchctl(["kickstart", `gui/${uid}/${spec.label}`])
  },
  async stop(spec) {
    const uid = currentUid()
    await launchctl(["bootout", `gui/${uid}/${spec.label}`], true)
  },
  async restart(spec) {
    const uid = currentUid()
    await ensureLoaded(uid, spec)
    await launchctl(["kickstart", "-k", `gui/${uid}/${spec.label}`])
  },
  async status(spec) {
    const uid = currentUid()
    const result = await launchctl(["print", `gui/${uid}/${spec.label}`], true)
    if (result.exitCode !== 0) {
      const exists = await Bun.file(DaemonPaths.launchAgent(spec.label))
        .exists()
        .catch(() => false)
      const detail = exists ? "LaunchAgent installed but not loaded" : "LaunchAgent not installed"
      return {
        installed: exists,
        running: false,
        detail,
      }
    }

    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
    return {
      installed: true,
      running: !/state = exited/i.test(output),
      detail: output.trim(),
    }
  },
}

function renderPlist(spec: DaemonService.InstallSpec) {
  const programArguments = spec.command.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")
  const environmentVariables = Object.entries(spec.env)
    .filter((entry) => entry[1] !== undefined)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(spec.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(spec.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(spec.logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentVariables}
    </dict>
  </dict>
</plist>
`
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function currentUid() {
  const getuid = process.getuid?.bind(process)
  if (!getuid) {
    throw new Error("launchd service management requires a POSIX user session")
  }
  return getuid()
}

async function ensureLoaded(uid: number, spec: DaemonService.InstallSpec) {
  const target = `gui/${uid}/${spec.label}`
  const check = await launchctl(["print", target], true)
  if (check.exitCode === 0) {
    return
  }
  await launchctl(["bootstrap", `gui/${uid}`, DaemonPaths.launchAgent(spec.label)], true)
}

async function launchctl(args: string[], allowFailure = false) {
  const proc = Bun.spawn(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (!allowFailure && exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `launchctl ${args.join(" ")} failed with exit code ${exitCode}`)
  }
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }
}
