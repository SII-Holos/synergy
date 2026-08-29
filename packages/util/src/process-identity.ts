import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

let ownIdentityPromise: Promise<string | undefined> | undefined
let linuxBootIdPromise: Promise<string | undefined> | undefined

/**
 * Identity of a pid beyond the number itself: the moment the occupying process
 * started. Pids recycle on every platform, so a recorded pid matching a live
 * process does not prove that process is the recorded one — the same pid held
 * by a process with a different start time does. Returns `undefined` when the
 * start time cannot be determined; callers must treat that as "unknown", never
 * as "recycled".
 *
 * Every platform has one canonical encoding, so a recorded identity is always
 * comparable with a later query on the same machine. Linux identities include
 * the boot id because start ticks reset on reboot while lock files survive it.
 */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (pid === process.pid) {
    // Cache the promise, not the value: concurrent first acquisitions must
    // share a single query instead of spawning one subprocess each.
    ownIdentityPromise ??= queryProcessStartIdentity(pid)
    return ownIdentityPromise
  }
  return queryProcessStartIdentity(pid)
}

async function queryProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
    const closingParen = stat.lastIndexOf(")")
    const fields =
      closingParen < 0
        ? []
        : stat
            .slice(closingParen + 1)
            .trim()
            .split(/\s+/)
    const startTicks = fields[19]
    if (!startTicks) return undefined
    const bootId = await linuxBootId()
    return bootId ? `linux:${bootId}:${startTicks}` : `linux:${startTicks}`
  }

  if (process.platform === "win32") {
    const wmic = await execFileAsync("wmic.exe", [
      "process",
      "where",
      `(ProcessId=${pid})`,
      "get",
      "CreationDate",
      "/value",
    ]).catch(() => ({ stdout: "" }))
    const creationDate = wmic.stdout.match(/CreationDate=(\d{14}\.\d{6}[+-]\d{3})/)?.[1]
    if (creationDate !== undefined) {
      const epochMs = wmicCreationDateToEpochMs(creationDate)
      if (epochMs !== undefined) return `windows:${epochMs}`
    }

    const result = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]).catch(() => ({ stdout: "" }))
    const epochMs = ticksToEpochMs(result.stdout)
    if (epochMs !== undefined) return `windows:${epochMs}`

    return undefined
  }

  // `ps -o lstart=` resolves to whole seconds on macOS and BSD, so two
  // processes started within the same second share an identity and a pid
  // recycled within that second is not detected. That failure is fail-safe:
  // the stale lock waits out the acquire timeout instead of a live owner
  // being displaced.
  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]).catch(() => ({ stdout: "" }))
  const startedAt = Date.parse(result.stdout.trim())
  return Number.isNaN(startedAt) ? undefined : `unix:${startedAt}`
}

async function linuxBootId(): Promise<string | undefined> {
  linuxBootIdPromise ??= fs
    .readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then((value) => value.trim() || undefined)
    .catch(() => undefined)
  return linuxBootIdPromise
}

/**
 * WMIC reports the creation time as local wall clock plus a UTC offset in
 * minutes (`YYYYMMDDHHMMSS.microseconds±UUU`). Convert to UTC epoch
 * milliseconds so the value stays comparable with the PowerShell fallback,
 * which reports .NET ticks — the two sources must share one encoding or a
 * live owner looks like a recycled pid when a later query takes the other
 * path.
 */
export function wmicCreationDateToEpochMs(value: string): number | undefined {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, micros, offset] = match
  const offsetMinutes = Number(offset)
  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(micros.slice(0, 3)),
    ) -
    offsetMinutes * 60_000
  )
}

/** .NET ticks (100 ns since 0001-01-01) → UTC epoch milliseconds. */
export function ticksToEpochMs(value: string): number | undefined {
  const match = value.trim().match(/^\d+$/)
  if (!match) return undefined
  return Number((BigInt(match[0]) - 621355968000000000n) / 10_000n)
}
