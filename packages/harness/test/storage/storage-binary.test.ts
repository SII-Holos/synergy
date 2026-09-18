import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

describe("Storage binary records", () => {
  test("preserves arbitrary bytes in a private record", async () => {
    const key = ["binary-test", crypto.randomUUID(), "payload"]
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0])
    await Storage.writeBinary(key, bytes)
    expect(await Storage.readBinary(key)).toEqual(bytes)
    if (process.platform !== "win32") {
      const location = await Storage.current().store.snapshot((tx) => tx.artifact(key))
      const file = await fs.stat(path.join(Global.Path.data, "agent-artifacts", location.pack))
      expect(file.mode & 0o777).toBe(0o600)
    }
  })

  test("keeps the committed record when a replacement fails", async () => {
    const key = ["binary-test", crypto.randomUUID(), "payload"]
    const bytes = new Uint8Array([1, 2, 3])
    await Storage.writeBinary(key, bytes)
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" })
    const original = fs.open.bind(fs)
    using open = spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if (flags !== "r" && String(filename).endsWith(".pack")) throw error
      return original(filename, flags, mode)
    })
    await expect(Storage.writeBinary(key, new Uint8Array([4]))).rejects.toMatchObject({ code: "ENOSPC" })
    expect(await Storage.readBinary(key)).toEqual(bytes)
    expect(await Storage.readBinary(key)).toEqual(bytes)
  })

  test("retries transient sharing violations", async () => {
    const key = ["binary-test", crypto.randomUUID(), "payload"]
    const original = fs.open.bind(fs)
    let attempts = 0
    using open = spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if (flags !== "r" && String(filename).endsWith(".pack") && ++attempts < 3)
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" })
      return original(filename, flags, mode)
    })
    await Storage.writeBinary(key, new Uint8Array([42]))
    expect(await Storage.readBinary(key)).toEqual(new Uint8Array([42]))
    expect(attempts).toBe(3)
  })
})
