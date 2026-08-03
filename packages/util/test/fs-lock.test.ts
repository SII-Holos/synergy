import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileLockPath, withFileLock } from "../src/fs-lock"

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
})
