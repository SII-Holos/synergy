import { execFile } from "node:child_process"

export type PortalFileAccessProbe = "allowed" | "denied" | "unavailable"

// xdg-desktop-portal routes every portal method call through the same
// authorize_callback caller inspection (opening /proc/<pid>/root, gated by
// ptrace_may_access). ReadAll therefore fails with the same AccessDenied as
// FileChooser.OpenFile when the calling process's primary group diverges from
// the desktop session (newgrp), while Properties.Get/Introspect bypass
// authorization and would false-positive. Chromium maps the OpenFile error to
// a silent cancel, so this probe is the only way to detect the condition.
// See flatpak/xdg-desktop-portal#1490 and SII-Holos/synergy#1396.
export const GDBUS_PROBE_ARGS = [
  "call",
  "--session",
  "--dest",
  "org.freedesktop.portal.Desktop",
  "--object-path",
  "/org/freedesktop/portal/desktop",
  "--method",
  "org.freedesktop.portal.Settings.ReadAll",
  "['']",
] as const

const DENIAL_MARKERS = ["DBus.Error.AccessDenied", "Portal operation not allowed"]
const PROBE_TIMEOUT_MS = 3_000

export type RunGdbus = (file: string, args: string[]) => Promise<string>

export type ProbePortalFileAccessOptions = {
  platform?: NodeJS.Platform
  run?: RunGdbus
}

export async function probePortalFileAccess(
  options: ProbePortalFileAccessOptions = {},
): Promise<PortalFileAccessProbe> {
  if ((options.platform ?? process.platform) !== "linux") return "allowed"
  const run = options.run ?? defaultRun
  let output: string
  try {
    output = await run("gdbus", [...GDBUS_PROBE_ARGS])
  } catch (error) {
    return classifyFailure(error)
  }
  return output.trim().length > 0 ? "allowed" : "unavailable"
}

function classifyFailure(error: unknown): PortalFileAccessProbe {
  const failure = error as NodeJS.ErrnoException & { stderr?: unknown }
  const text = `${failure.code ?? ""}\n${failure.message}\n${typeof failure.stderr === "string" ? failure.stderr : ""}`
  return DENIAL_MARKERS.some((marker) => text.includes(marker)) ? "denied" : "unavailable"
}

function defaultRun(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr}`.trim()
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
