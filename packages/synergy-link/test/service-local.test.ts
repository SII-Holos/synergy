import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { SynergyLinkLocalService } from "../src/service/local"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-local-service-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link local service process helpers", () => {
  test("isPidRunning rejects invalid pids and probes live processes", () => {
    expect(SynergyLinkLocalService.isPidRunning(0)).toBe(false)
    expect(SynergyLinkLocalService.isPidRunning(-5)).toBe(false)
    expect(SynergyLinkLocalService.isPidRunning(process.pid)).toBe(true)
    expect(SynergyLinkLocalService.isPidRunning(2 ** 30 - 1)).toBe(false)
  })

  test("isPidRunningSince verifies a live pid and compares start time", async () => {
    const child = spawn("sleep", ["30"])
    const exited = new Promise((resolve) => child.once("exit", resolve))
    try {
      const pid = child.pid!
      expect(await SynergyLinkLocalService.isPidRunningSince(pid)).toBe(true)
      expect(await SynergyLinkLocalService.isPidRunningSince(2 ** 30 - 1)).toBe(false)
      if (process.platform !== "win32") {
        expect(await SynergyLinkLocalService.isPidRunningSince(pid, Date.now() - 1000)).toBe(true)
      }
    } finally {
      child.kill("SIGKILL")
      await exited
    }
  })

  test("terminatePid stops a live child and tolerates unknown pids", async () => {
    await expect(SynergyLinkLocalService.terminatePid(2 ** 30 - 1)).resolves.toBeUndefined()

    const child = spawn("sleep", ["30"])
    const exited = new Promise((resolve) => child.once("exit", resolve))
    const pid = child.pid!
    await SynergyLinkLocalService.terminatePid(pid, { waitMs: 10, retries: 100, killRetries: 5 })
    await exited
    expect(SynergyLinkLocalService.isPidRunning(pid)).toBe(false)
  })

  test("removeSocketFile tolerates missing files and removes existing ones", async () => {
    const root = await createRoot()
    await expect(SynergyLinkLocalService.removeSocketFile(path.join(root, "absent.sock"))).resolves.toBeUndefined()

    const socketPath = path.join(root, "control.sock")
    await writeFile(socketPath, "stale")
    await SynergyLinkLocalService.removeSocketFile(socketPath)
    await expect(stat(socketPath)).rejects.toThrow()
  })
})

describe("synergy-link local service log files", () => {
  test("readLogsFile returns empty content for a missing file", async () => {
    const root = await createRoot()
    const result = await SynergyLinkLocalService.readLogsFile(path.join(root, "missing.log"))
    expect(result.content).toBe("")
    expect(result.truncated).toBe(false)
    expect(result.logPath).toBe(path.join(root, "missing.log"))
  })

  test("readLogsFile tails lines and filters by timestamp", async () => {
    const root = await createRoot()
    const logPath = path.join(root, "runtime.log")
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const freshTimestamp = new Date().toISOString()
    await writeFile(
      logPath,
      [
        `[synergy-link] ${oldTimestamp} INFO old.line`,
        `[synergy-link] ${freshTimestamp} INFO fresh.one`,
        `[synergy-link] ${freshTimestamp} WARN fresh.two`,
        `[synergy-link] ${freshTimestamp} ERROR fresh.three`,
        "plain line without timestamp",
        "",
      ].join("\n"),
    )

    const tailed = await SynergyLinkLocalService.readLogsFile(logPath, { tailLines: 2 })
    expect(tailed.content).toBe(`[synergy-link] ${freshTimestamp} ERROR fresh.three\nplain line without timestamp`)

    const since = await SynergyLinkLocalService.readLogsFile(logPath, { since: "5m" })
    expect(since.content).not.toContain("old.line")
    expect(since.content).toContain("fresh.one")
    expect(since.content).toContain("plain line without timestamp")

    const full = await SynergyLinkLocalService.readLogsFile(logPath)
    expect(full.content).toContain("old.line")
  })

  test("readLogsFile truncates files larger than the minimum byte budget", async () => {
    const root = await createRoot()
    const logPath = path.join(root, "runtime.log")
    const padding = "x".repeat(64)
    await writeFile(logPath, Array.from({ length: 40 }, (_, index) => `line ${index} ${padding}`).join("\n"))

    const truncated = await SynergyLinkLocalService.readLogsFile(logPath, { maxBytes: 1024 })
    expect(truncated.truncated).toBe(true)
    expect(truncated.content).toContain("line 39")
    expect(truncated.content).not.toContain("line 0 ")
  })

  test("followLogsFile emits initial content, appended changes, and truncation resets the offset", async () => {
    const root = await createRoot()
    const logPath = path.join(root, "runtime.log")
    await writeFile(logPath, "first\n")

    const chunks: string[] = []
    const following = SynergyLinkLocalService.followLogsFile({
      outputPath: logPath,
      onChunk: (chunk) => chunks.push(chunk),
    })
    void following.catch(() => undefined)

    // fs.watch may coalesce rapid successive writes into a single callback
    // (inotify under CI load), so assert on content arrival instead of exact
    // chunk boundaries. The behavior under test is that every write is
    // eventually emitted and truncation resets the read offset.
    const waitForContent = async (content: string) => {
      const deadline = Date.now() + 15_000
      while (!chunks.some((chunk) => chunk.includes(content)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(chunks.some((chunk) => chunk.includes(content))).toBe(true)
    }

    await waitForContent("first\n")
    await appendFile(logPath, "second\n")
    await waitForContent("second\n")
    await writeFile(logPath, "restarted\n")
    await waitForContent("restarted\n")
    await appendFile(logPath, "after-truncate\n")
    await waitForContent("after-truncate\n")
  })
})
