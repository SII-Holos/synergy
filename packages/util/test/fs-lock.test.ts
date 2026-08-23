import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileLockPath, withFileLock } from "../src/fs-lock"

const isWindows = process.platform === "win32"

async function createLockDirectory(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "synergy-fs-lock-test-"))
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

describe("withFileLock", () => {
  test("serializes concurrent work for the same key", async () => {
    const directory = await createLockDirectory()
    let active = 0
    let maximumActive = 0
    let completed = 0

    await Promise.all(
      Array.from({ length: 12 }, () =>
        withFileLock({ directory, key: "shared", retryMs: 1 }, async () => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await delay(2)
          completed += 1
          active -= 1
        }),
      ),
    )

    expect(maximumActive).toBe(1)
    expect(completed).toBe(12)
  })

  test("reclaims a lock owned by a dead process", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    await fs.writeFile(filename, JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })

    let acquired = false
    await withFileLock({ directory, key: "shared", timeoutMs: 100 }, async () => {
      acquired = true
    })

    expect(acquired).toBe(true)
  })

  test("protects fresh incomplete metadata and reclaims it after the grace period", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    await fs.writeFile(filename, "", { mode: 0o600 })

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 25, staleMetadataMs: 5_000 }, async () => {}),
    ).rejects.toThrow("Timed out acquiring file lock for shared")

    const staleTime = new Date(Date.now() - 10_000)
    await fs.utimes(filename, staleTime, staleTime)

    let acquired = false
    await withFileLock({ directory, key: "shared", timeoutMs: 100, staleMetadataMs: 5_000 }, async () => {
      acquired = true
    })

    expect(acquired).toBe(true)
  })

  test("times out without removing a live lock", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    await fs.writeFile(filename, JSON.stringify({ pid: process.pid }), { mode: 0o600 })

    await expect(withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for shared",
    )
    await expect(fs.readFile(filename, "utf8")).resolves.toContain(`"pid":${process.pid}`)
  })

  // BUG-005: on Windows, PIDs recycle aggressively and process.kill(pid, 0)
  // returns true for a recycled PID that now belongs to an unrelated live
  // process. A stale lock whose owner PID has been recycled would otherwise
  // look live forever and never be reclaimed. The wall-clock age (acquiredAt)
  // must age it out past staleMetadataMs even when the PID appears live.
  test.skipIf(!isWindows)("reclaims a stale lock whose recycled PID looks live", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    // pid = current process → processExists() is true, simulating a recycled
    // PID that an unrelated live process now owns. acquiredAt is 10s in the
    // past, beyond the 5s stale grace period.
    await fs.writeFile(filename, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 10_000 }), { mode: 0o600 })

    let acquired = false
    await withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 2_000, staleMetadataMs: 5_000 }, async () => {
      acquired = true
    })

    expect(acquired).toBe(true)
  })

  test("does not reclaim a fresh live-owner lock by age alone", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    // Fresh lock with a live owner PID: must not be reclaimed by the age gate.
    await fs.writeFile(filename, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { mode: 0o600 })

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 25, staleMetadataMs: 5_000 }, async () => {}),
    ).rejects.toThrow("Timed out acquiring file lock for shared")
    await expect(fs.readFile(filename, "utf8")).resolves.toContain(`"pid":${process.pid}`)
  })
})
