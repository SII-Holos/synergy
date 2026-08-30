import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { processStartIdentity } from "../src/process-identity"
import { fileLockPath, withFileLock } from "../src/fs-lock"

const ownIdentity = await processStartIdentity(process.pid)
const identityAvailable = ownIdentity !== undefined

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

  test.skipIf(!identityAvailable)(
    "reclaims a lock whose live pid no longer matches its recorded start identity",
    async () => {
      const directory = await createLockDirectory()
      const filename = fileLockPath(directory, "shared")
      // The current process is alive, but the recorded start identity belongs to
      // a previous process that held this pid — exactly what PID recycling
      // produces. The lock must be reclaimed regardless of platform.
      await fs.writeFile(
        filename,
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), startIdentity: "forged:previous-occupant" }),
        { mode: 0o600 },
      )

      let acquired = false
      await withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 2_000 }, async () => {
        acquired = true
      })

      expect(acquired).toBe(true)
    },
  )

  test.skipIf(!identityAvailable)("does not reclaim a live owner whose start identity still matches", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    await fs.writeFile(
      filename,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), startIdentity: ownIdentity }),
      { mode: 0o600 },
    )

    await expect(withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for shared",
    )
    await expect(fs.readFile(filename, "utf8")).resolves.toContain(`"pid":${process.pid}`)
  })

  test("does not reclaim a live legacy owner that predates start identity metadata", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    // Lock payloads written before this change carry no startIdentity. A live
    // owner holding such a lock must never be displaced by a newer acquirer.
    await fs.writeFile(filename, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { mode: 0o600 })

    await expect(withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for shared",
    )
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

  test("release keeps a lock whose payload was replaced after acquisition", async () => {
    const directory = await createLockDirectory()
    const filename = fileLockPath(directory, "shared")
    const identity = ownIdentity
    await fs.writeFile(
      filename,
      JSON.stringify({ pid: 2_147_483_647, acquiredAt: Date.now(), startIdentity: identity }),
      { mode: 0o600 },
    )

    await withFileLock({ directory, key: "shared", retryMs: 5, timeoutMs: 1_000 }, async () => {
      // A competing writer replaces the payload while the lock is held: the
      // holder's release must not unlink a lock it no longer owns.
      const rival = JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), startIdentity: identity })
      await fs.writeFile(filename, rival, { mode: 0o600 })
    })

    await expect(fs.readFile(filename, "utf8")).resolves.toContain("acquiredAt")
  })
})
