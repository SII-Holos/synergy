import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

function keyRoot() {
  return ["storage-retry-test", Math.random().toString(36).slice(2)]
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

async function tempFiles(root: string[]): Promise<string[]> {
  const dir = path.join(Global.Path.data, ...root)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  return entries.filter((name) => name.includes(".tmp-") || name.endsWith(".tmp"))
}

describe("Storage atomic write transient-failure retry", () => {
  test("retries a transient EPERM on rename and persists the payload", async () => {
    const root = keyRoot()
    const realRename: typeof fs.rename = fs.rename.bind(fs)
    let calls = 0
    const impl = (async (from: unknown, to: unknown) => {
      calls += 1
      if (calls <= 2) throw errnoError("EPERM")
      return realRename(from as Parameters<typeof realRename>[0], to as Parameters<typeof realRename>[1])
    }) as unknown as typeof fs.rename
    using _rename = spyOn(fs, "rename").mockImplementation(impl)

    await Storage.write([...root, "item"], { value: 1 })

    expect(calls).toBe(3)
    expect(await Storage.read<{ value: number }>([...root, "item"])).toEqual({ value: 1 })
    expect(await tempFiles(root)).toEqual([])
  })

  test("retries a transient EPERM on the temp-file write", async () => {
    const root = keyRoot()
    const realWrite: typeof Bun.write = Bun.write.bind(Bun)
    let calls = 0
    const impl = (async (destination: unknown, data: unknown) => {
      calls += 1
      if (calls === 1) throw errnoError("EPERM")
      return realWrite(destination as never, data as never)
    }) as unknown as typeof Bun.write
    using _write = spyOn(Bun, "write").mockImplementation(impl)

    await Storage.write([...root, "item"], { value: 2 })

    expect(calls).toBe(2)
    expect(await Storage.read<{ value: number }>([...root, "item"])).toEqual({ value: 2 })
    expect(await tempFiles(root)).toEqual([])
  })

  test("propagates the original error after retries are exhausted without leaving temp files", async () => {
    const root = keyRoot()
    let calls = 0
    const impl = (async () => {
      calls += 1
      throw errnoError("EPERM")
    }) as unknown as typeof fs.rename
    using _rename = spyOn(fs, "rename").mockImplementation(impl)

    await expect(Storage.write([...root, "item"], { value: 3 })).rejects.toMatchObject({ code: "EPERM" })
    expect(calls).toBe(4)
    expect(await tempFiles(root)).toEqual([])
  })

  test("does not retry non-transient errors", async () => {
    const root = keyRoot()
    let calls = 0
    const impl = (async () => {
      calls += 1
      throw errnoError("ENOSPC")
    }) as unknown as typeof fs.rename
    using _rename = spyOn(fs, "rename").mockImplementation(impl)

    await expect(Storage.write([...root, "item"], { value: 4 })).rejects.toMatchObject({ code: "ENOSPC" })
    expect(calls).toBe(1)
    expect(await tempFiles(root)).toEqual([])
  })
})
