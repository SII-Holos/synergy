import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

let ownIdentity: string | undefined

/**
 * Identity of a pid beyond the number itself: the moment the occupying process
 * started. Pids recycle on every platform, so a recorded pid matching a live
 * process does not prove that process is the recorded one — the same pid held
 * by a process with a different start time does. Returns `undefined` when the
 * start time cannot be determined; callers must treat that as "unknown", never
 * as "recycled".
 */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (pid === process.pid) {
    ownIdentity ??= await queryProcessStartIdentity(pid)
    return ownIdentity
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
    if (startTicks) return `linux:${startTicks}`
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
    const creationDate = wmic.stdout.match(/CreationDate=(\d+)/)?.[1]
    if (creationDate) return `windows:${creationDate}`

    const result = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]).catch(() => ({ stdout: "" }))
    const ticks = result.stdout.trim()
    if (ticks) return `windows:${ticks}`

    return undefined
  }

  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]).catch(() => ({ stdout: "" }))
  const startedAt = Date.parse(result.stdout.trim())
  return Number.isNaN(startedAt) ? undefined : `unix:${startedAt}`
}
