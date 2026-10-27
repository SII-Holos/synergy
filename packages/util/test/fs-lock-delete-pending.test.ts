import { afterEach, describe, expect, spyOn, test } from "bun:test"
import realFs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileLockPath, withFileLock } from "../src/fs-lock"

// Windows delete-pending errors need boundary injection on other platforms.
// Scope the open spy to each test without replacing the shared native module.
type OpenArgs = Parameters<typeof realFs.open>
const realOpen = realFs.open.bind(realFs)

let deletePending: { path: string; times: number } | undefined
let writeFailure: { path: string; times: number } | undefined
let closeFailure: { path: string; times: number } | undefined
const failedCloses = new Set<Awaited<ReturnType<typeof realFs.open>>>()
const directories = new Set<string>()

function simulatedEperm(targetPath: OpenArgs[0]): NodeJS.ErrnoException {
  const error = new Error(`EPERM: simulated lock failure: ${String(targetPath)}`) as NodeJS.ErrnoException
  error.code = "EPERM"
  error.path = String(targetPath)
  return error
}

async function simulatedOpen(...args: OpenArgs) {
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
}

async function createLockDirectory(): Promise<string> {
  const directory = await realFs.mkdtemp(path.join(os.tmpdir(), "synergy-fs-lock-delete-pending-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  deletePending = undefined
  writeFailure = undefined
  closeFailure = undefined
  await Promise.all([...failedCloses].map((handle) => handle.close()))
  failedCloses.clear()
  await Promise.all([...directories].map((directory) => realFs.rm(directory, { recursive: true, force: true })))
  directories.clear()
})

describe("withFileLock delete-pending contention", () => {
  test("acquires the lock after a transient EPERM from a delete-pending entry", async () => {
    using _open = spyOn(realFs, "open").mockImplementation(simulatedOpen)
    const directory = await createLockDirectory()
    deletePending = { path: fileLockPath(directory, "shared"), times: 1 }

    let acquired = false
    await withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {
      acquired = true
    })

    expect(acquired).toBe(true)
    expect(deletePending.times).toBe(0)
  })

  test("surfaces the timeout message when EPERM never clears", async () => {
    using _open = spyOn(realFs, "open").mockImplementation(simulatedOpen)
    const directory = await createLockDirectory()
    deletePending = { path: fileLockPath(directory, "stuck"), times: 1_000 }

    await expect(withFileLock({ directory, key: "stuck", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for stuck",
    )
  })

  test("preserves the original error when writeFile fails with EPERM", async () => {
    using _open = spyOn(realFs, "open").mockImplementation(simulatedOpen)
    const directory = await createLockDirectory()
    writeFailure = { path: fileLockPath(directory, "shared"), times: 1 }

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")

    await expect(realFs.stat(fileLockPath(directory, "shared"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("preserves the original error when close fails with EPERM", async () => {
    using _open = spyOn(realFs, "open").mockImplementation(simulatedOpen)
    const directory = await createLockDirectory()
    closeFailure = { path: fileLockPath(directory, "shared"), times: 1 }

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")
  })
})
