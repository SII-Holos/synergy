import process from "node:process"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, stat, unlink } from "node:fs/promises"
import { watch } from "node:fs"
import { Platform } from "../platform.js"

const execFileAsync = promisify(execFile)

export namespace SynergyLinkLocalService {
  export function isPidRunning(pid: number) {
    if (!pid || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  export async function isPidRunningSince(pid: number, expectedStartedAt?: number) {
    if (!isPidRunning(pid)) return false
    if (expectedStartedAt === undefined) return true
    const observedStartedAt = await readPidStartedAt(pid)
    if (observedStartedAt === undefined) return true
    return Math.abs(observedStartedAt - expectedStartedAt) <= 5_000
  }

  export async function terminatePid(pid: number, input?: { waitMs?: number; retries?: number; killRetries?: number }) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      return
    }

    const waitMs = input?.waitMs ?? 100
    const retries = input?.retries ?? 50
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (!isPidRunning(pid)) return
      await Platform.sleep(waitMs)
    }

    try {
      process.kill(pid, "SIGKILL")
    } catch {
      return
    }

    for (let attempt = 0; attempt < (input?.killRetries ?? 20); attempt += 1) {
      if (!isPidRunning(pid)) return
      await Platform.sleep(waitMs)
    }
  }

  export async function removeSocketFile(socketPath: string) {
    await unlink(socketPath).catch(() => undefined)
  }

  export async function readLogsFile(
    outputPath: string,
    input?: { maxBytes?: number; tailLines?: number; since?: string },
  ) {
    let content = ""
    try {
      content = await readFile(outputPath, "utf8")
    } catch {
      return {
        logPath: outputPath,
        content: "",
        truncated: false,
      }
    }

    const filtered = filterLogContent(content, input)
    const maxBytes = Math.max(1_024, input?.maxBytes ?? 64_000)
    const truncated = Buffer.byteLength(filtered) > maxBytes
    if (!truncated) {
      return {
        logPath: outputPath,
        content: filtered,
        truncated: false,
      }
    }

    const tail = Buffer.from(filtered).subarray(-maxBytes).toString("utf8")
    return {
      logPath: outputPath,
      content: tail,
      truncated: true,
    }
  }

  export async function followLogsFile(input: {
    outputPath: string
    tailLines?: number
    since?: string
    onChunk: (chunk: string) => void
  }): Promise<void> {
    const initial = await readLogsFile(input.outputPath, {
      tailLines: input.tailLines,
      since: input.since,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })
    if (initial.content.length > 0) {
      input.onChunk(initial.content.endsWith("\n") ? initial.content : `${initial.content}\n`)
    }

    let offset = 0
    try {
      offset = (await stat(input.outputPath)).size
    } catch {
      offset = 0
    }

    await new Promise<void>((resolve, reject) => {
      const watcher = watch(input.outputPath, async (eventType) => {
        if (eventType !== "change") return
        try {
          const next = await readFile(input.outputPath, "utf8")
          const nextBytes = Buffer.byteLength(next)
          if (nextBytes < offset) {
            offset = 0
          }
          const slice = Buffer.from(next).subarray(offset).toString("utf8")
          offset = nextBytes
          if (slice.length > 0) input.onChunk(slice)
        } catch (error) {
          watcher.close()
          reject(error)
        }
      })
      watcher.once("error", reject)
      process.once("SIGINT", () => {
        watcher.close()
        resolve()
      })
      process.once("SIGTERM", () => {
        watcher.close()
        resolve()
      })
    })
  }
}

async function readPidStartedAt(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") return undefined
  try {
    // Derive the start instant from the elapsed runtime instead of parsing
    // `lstart`: the latter is a local-time string whose timezone handling
    // differs across JS engines, while `etimes` is a procps/Linux-only
    // keyword that macOS/BSD ps rejects. `etime` prints the same elapsed
    // time in the portable `[[dd-]hh:]mm:ss` form on both procps and BSD.
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "etime="], {
      timeout: 1_000,
      maxBuffer: 4_096,
    })
    const elapsedSeconds = parsePsEtime(stdout)
    return elapsedSeconds === undefined ? undefined : Date.now() - elapsedSeconds * 1_000
  } catch {
    return undefined
  }
}

/**
 * Parse `ps -o etime=` output into whole elapsed seconds. procps and BSD ps
 * both print `mm:ss` under an hour, `hh:mm:ss` under a day, and
 * `dd-hh:mm:ss` beyond a day; busybox prints the same clock forms. Returns
 * undefined for empty or unparseable output so callers can fall back to
 * accepting a live pid without a start-time comparison.
 */
export function parsePsEtime(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let rest = trimmed
  let days = 0
  const dayDash = rest.indexOf("-")
  if (dayDash !== -1) {
    const dayPart = rest.slice(0, dayDash)
    if (!/^\d+$/.test(dayPart)) return undefined
    days = Number(dayPart)
    rest = rest.slice(dayDash + 1)
  }
  const rawParts = rest.split(":")
  if (rawParts.length === 0 || rawParts.length > 3) return undefined
  const parts: number[] = []
  for (const part of rawParts) {
    if (!/^\d+$/.test(part)) return undefined
    parts.push(Number(part))
  }
  const seconds =
    parts.length === 1
      ? parts[0]!
      : parts.length === 2
        ? parts[0]! * 60 + parts[1]!
        : parts[0]! * 3_600 + parts[1]! * 60 + parts[2]!
  return days * 86_400 + seconds
}

function filterLogContent(content: string, input?: { tailLines?: number; since?: string }) {
  let lines = content.length === 0 ? [] : content.split("\n")
  if (lines.length > 0 && lines.at(-1) === "") {
    lines = lines.slice(0, -1)
  }

  const sinceMs = parseSince(input?.since)
  if (sinceMs !== undefined) {
    lines = lines.filter((line) => {
      const timestamp = extractLogTimestamp(line)
      return timestamp === undefined || timestamp >= sinceMs
    })
  }

  if (input?.tailLines) {
    lines = lines.slice(-input.tailLines)
  }

  return lines.join("\n")
}

function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2]
  const factor =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return Date.now() - amount * factor
}

function extractLogTimestamp(line: string): number | undefined {
  const match = line.match(/^\[synergy-link\]\s+(\S+)/)
  if (!match) return undefined
  const timestamp = Date.parse(match[1])
  return Number.isNaN(timestamp) ? undefined : timestamp
}
