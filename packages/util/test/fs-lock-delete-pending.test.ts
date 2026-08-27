import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import os from "node:os"
import path from "node:path"

// Windows keeps a just-unlinked lock as a delete-pending directory entry, and
// an exclusive create on that entry fails with EPERM instead of EEXIST. That
// platform state cannot be produced on demand from macOS or Linux, so this
// file simulates it at the fs boundary: node:fs/promises is replaced with a
// proxy that throws the delete-pending error for one specific lock path while
// every other call passes through to the real module. The same proxy can fail
// writeFile or close on the acquired handle, pinning that EPERM from those
// operations surfaces as the original error instead of entering the
// contention retry. The replacement must be installed before ../src/fs-lock
// is imported (mock.module only affects imports that resolve after it), and
// the real module is restored in afterAll per the testing-guide rule for
// module-level replacements in shared test processes.
type FsPromisesModule = typeof import("node:fs/promises")
type OpenArgs = Parameters<FsPromisesModule["open"]>
const realFs: FsPromisesModule = await import("node:fs/promises")

let deletePending: { path: string; times: number } | undefined
let writeFailure: { path: string; times: number } | undefined
let closeFailure: { path: string; times: number } | undefined

function simulatedEperm(targetPath: OpenArgs[0]): NodeJS.ErrnoException {
  const error = new Error(`EPERM: simulated lock failure: ${String(targetPath)}`) as NodeJS.ErrnoException
  error.code = "EPERM"
  error.path = String(targetPath)
  return error
}

const simulatedFs: FsPromisesModule = new Proxy(realFs, {
  get(target, property, receiver) {
    if (property !== "open") return Reflect.get(target, property, receiver)
    const realOpen = target.open.bind(target)
    return async (...args: OpenArgs) => {
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
              throw simulatedEperm(targetPath)
            }
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[property]
          return typeof value === "function" ? (value as (...fnArgs: unknown[]) => unknown).bind(target) : value
        },
      })
    }
  },
})

mock.module("node:fs/promises", () => ({ ...realFs, default: simulatedFs }))

const { fileLockPath, withFileLock } = await import("../src/fs-lock")

async function createLockDirectory(): Promise<string> {
  return await realFs.mkdtemp(path.join(os.tmpdir(), "synergy-fs-lock-delete-pending-"))
}

afterEach(() => {
  deletePending = undefined
  writeFailure = undefined
  closeFailure = undefined
})

afterAll(() => {
  mock.module("node:fs/promises", () => realFs)
})

describe("withFileLock delete-pending contention", () => {
  test("acquires the lock after a transient EPERM from a delete-pending entry", async () => {
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
    const directory = await createLockDirectory()
    deletePending = { path: fileLockPath(directory, "stuck"), times: 1_000 }

    await expect(withFileLock({ directory, key: "stuck", retryMs: 5, timeoutMs: 25 }, async () => {})).rejects.toThrow(
      "Timed out acquiring file lock for stuck",
    )
  })

  test("preserves the original error when writeFile fails with EPERM", async () => {
    const directory = await createLockDirectory()
    writeFailure = { path: fileLockPath(directory, "shared"), times: 1 }

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")

    await expect(realFs.stat(fileLockPath(directory, "shared"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("preserves the original error when close fails with EPERM", async () => {
    const directory = await createLockDirectory()
    closeFailure = { path: fileLockPath(directory, "shared"), times: 1 }

    await expect(
      withFileLock({ directory, key: "shared", retryMs: 1, timeoutMs: 1_000 }, async () => {}),
    ).rejects.toThrow("EPERM: simulated lock failure")
  })
})
