import { execFile } from "node:child_process"

export type PortalFileAccessProbe = "allowed" | "denied" | "unavailable"

// Provenance: https://github.com/flatpak/xdg-desktop-portal/issues/1490 — every portal method call passes authorize_callback caller inspection (opening /proc/<pid>/root, gated by ptrace_may_access), so Settings.ReadAll fails with the same AccessDenied as FileChooser.OpenFile when the caller's primary group diverges from the desktop session (newgrp), while Properties.Get/Introspect bypass authorization and would false-positive; Chromium's portal dialog maps the OpenFile failure to a silent cancel (ui/shell_dialogs/select_file_dialog_linux_portal.cc), so a probe is the only detection path.
// Local adaptation: Synergy classifies a read-only gdbus Settings.ReadAll round-trip (Linux only, 3 s timeout) into allowed/denied/unavailable and gates the native directory picker on the cached verdict.
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
