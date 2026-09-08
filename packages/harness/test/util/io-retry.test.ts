import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRetryableIOError, readFileWithRetry } from "../../src/util/io-retry"

const dir = mkdtempSync(join(tmpdir(), "io-retry-"))
const target = join(dir, "store.json")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

describe("readFileWithRetry", () => {
  test("returns file content on success", async () => {
    await fs.writeFile(target, "hello")
    expect(await readFileWithRetry(target)).toBe("hello")
  })

  test("retries a transient EPERM and succeeds", async () => {
    await fs.writeFile(target, "retried")
    let calls = 0
    const impl = (async () => {
      calls++
      if (calls === 1) throw errnoError("EPERM")
      return "retried"
    }) as unknown as typeof fs.readFile
    using _read = spyOn(fs, "readFile").mockImplementation(impl)
    expect(await readFileWithRetry(target, { attempts: 3, delayMs: 0 })).toBe("retried")
    expect(calls).toBe(2)
  })

  test("propagates after transient retries are exhausted", async () => {
    await fs.writeFile(target, "content")
    const impl = (async () => {
      throw errnoError("EBUSY")
    }) as unknown as typeof fs.readFile
    using _read = spyOn(fs, "readFile").mockImplementation(impl)
    await expect(readFileWithRetry(target, { attempts: 2, delayMs: 0 })).rejects.toMatchObject({ code: "EBUSY" })
  })

  test("does not retry non-transient errors", async () => {
    await fs.writeFile(target, "content")
    let calls = 0
    const impl = (async () => {
      calls++
      throw errnoError("ENOENT")
    }) as unknown as typeof fs.readFile
    using _read = spyOn(fs, "readFile").mockImplementation(impl)
    await expect(readFileWithRetry(target, { attempts: 3, delayMs: 0 })).rejects.toMatchObject({ code: "ENOENT" })
    expect(calls).toBe(1)
  })
})

describe("isRetryableIOError", () => {
  test("classifies transient errno codes", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      expect(isRetryableIOError(errnoError(code))).toBe(true)
    }
  })

  test("rejects non-errno errors", () => {
    expect(isRetryableIOError(new Error("boom"))).toBe(false)
    expect(isRetryableIOError(undefined)).toBe(false)
    expect(isRetryableIOError("EPERM")).toBe(false)
  })
})
