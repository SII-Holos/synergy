import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import os from "node:os"
import path from "node:path"

// Windows keeps a just-unlinked lock as a delete-pending directory entry, and
// an exclusive create on that entry fails with EPERM instead of EEXIST. That
// platform state cannot be produced on demand from macOS or Linux, so this
// file simulates it at the fs boundary: node:fs/promises is replaced with a
// proxy that throws the delete-pending error for one specific lock path while
// every other call passes through to the real module. The replacement must be
// installed before ../src/fs-lock is imported (mock.module only affects
// imports that resolve after it), and the real module is restored in afterAll
// per the testing-guide rule for module-level replacements in shared test
// processes.
type FsPromisesModule = typeof import("node:fs/promises")
const realFs: FsPromisesModule = await import("node:fs/promises")

let deletePending: { path: string; times: number } | undefined

const simulatedFs: FsPromisesModule = new Proxy(realFs, {
  get(target, property, receiver) {
    if (property !== "open") return Reflect.get(target, property, receiver)
    const realOpen = target.open.bind(target)
    return async (...args: Parameters<FsPromisesModule["open"]>) => {
      const targetPath = args[0]
      if (deletePending !== undefined && deletePending.times > 0 && targetPath === deletePending.path) {
        deletePending.times -= 1
        const error = new Error(`EPERM: delete-pending lock entry: ${String(targetPath)}`) as NodeJS.ErrnoException
        error.code = "EPERM"
        error.path = targetPath
        throw error
      }
      return await realOpen(...args)
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
})
