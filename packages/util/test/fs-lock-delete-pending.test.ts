import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileLockPath, withFileLock } from "../src/fs-lock"

// Provenance: https://bun.sh/docs/test/mocks
// Local adaptation: scoped spies preserve module identity across shared test batches.
// Windows keeps a just-unlinked lock as a delete-pending directory entry, and
// an exclusive create on that entry fails with EPERM instead of EEXIST. That
// platform state cannot be produced on demand from macOS or Linux. Scope the
// open spy to each test: replacing the builtin module detaches existing default
// imports from later filesystem spies even when the module is restored.
type OpenArgs = Parameters<typeof fs.open>

let deletePending: { path: string; times: number } | undefined
let writeFailure: { path: string; times: number } | undefined
let closeFailure: { path: string; times: number } | undefined
const failedCloses = new Set<Awaited<ReturnType<typeof fs.open>>>()
const directories = new Set<string>()

function simulatedEperm(targetPath: OpenArgs[0]): NodeJS.ErrnoException {
  const error = new Error(`EPERM: simulated lock failure: ${String(targetPath)}`) as NodeJS.ErrnoException
  error.code = "EPERM"
  error.path = String(targetPath)
  return error
}

function simulateLockIO() {
  const realOpen = fs.open.bind(fs)
  return spyOn(fs, "open").mockImplementation(async (...args: OpenArgs) => {
    const targetPath = args[0]
    if (deletePending !== undefined && deletePending.times > 0 && targetPath === deletePending.path) {
      deletePending.times -= 1
      throw simulatedEperm(targetPath)
    }
    const handle = await realOpen(...args)
    const wrapForWrite = writeFailure !== undefined && writeFailure.times > 0 && targetPath === writeFailure.path
    const wrapForClose = closeFailure !== undefined && closeFailure.times > 0 && targetPath === closeFailure.path
    if (!wrapForWrite && !wrapForClose) return handle
    return new Proxy(handle, {
      get(target, property) {
        if (
          property === "writeFile" &&
          writeFailure !== undefined &&
          writeFailure.times > 0 &&
          targetPath === writeFailure.path
        ) {
          writeFailure.times -= 1
          return async () => {
            throw simulatedEperm(targetPath)
          }
        }
        if (
          property === "close" &&
          closeFailure !== undefined &&
          closeFailure.times > 0 &&
          targetPath === closeFailure.path
        ) {
          closeFailure.times -= 1
          return async () => {
            failedCloses.add(target)
            throw simulatedEperm(targetPath)
          }
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[property]
        return typeof value === "function" ? (value as (...fnArgs: unknown[]) => unknown).bind(target) : value
      },
    })
  })
}

async function createLockDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-fs-lock-delete-pending-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  deletePending = undefined
  writeFailure = undefined
  closeFailure = undefined
  await Promise.all([...failedCloses].map((handle) => handle.close()))
  failedCloses.clear()
  await Promise.all([...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })))
  directories.clear()
})

describe("withFileLock delete-pending contention", () => {
  test("acquires the lock after a transient EPERM from a delete-pending entry", async () => {
    const directory = await createLockDirectory()
    deletePending = { path: fileLockPath(directory, "shared"), times: 1 }
    using _open = simulateLockIO()

    let acquired = false
    await withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {
      acquired = true
    })

    expect(acquired).toBe(true)
    expect(deletePending.times).toBe(0)
  })

  test("surfaces the timeout message when EPERM never clears", async () => {
    const directory = await createLockDirectory()
    deletePending = { path: fileLockPath(directory, "stuck"), times: 1_000 }
    using _open = simulateLockIO()

    await expect(withFileLock({ directory, key: "stuck", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for stuck",
    )
  })

  test("preserves the original error when writeFile fails with EPERM", async () => {
    const directory = await createLockDirectory()
    writeFailure = { path: fileLockPath(directory, "shared"), times: 1 }
    using _open = simulateLockIO()

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")

    await expect(fs.stat(fileLockPath(directory, "shared"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("preserves the original error when close fails with EPERM", async () => {
    const directory = await createLockDirectory()
    closeFailure = { path: fileLockPath(directory, "shared"), times: 1 }
    using _open = simulateLockIO()

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")
  })

  test("keeps unrelated filesystem reads observable after lock simulation", async () => {
    const directory = await createLockDirectory()
    const filename = path.join(directory, "read.txt")
    await fs.writeFile(filename, "retried")
    const { readFileWithRetry } = await import("../src/io-retry")
    using read = spyOn(fs, "readFile").mockRejectedValueOnce(simulatedEperm(filename)).mockResolvedValueOnce("retried")

    expect(await readFileWithRetry(filename, { attempts: 2, delayMs: 0 })).toBe("retried")
    expect(read.mock.calls).toHaveLength(2)
  })
})
