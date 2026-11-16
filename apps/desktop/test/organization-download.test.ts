import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { saveOrganizationDownload } from "../src/organization/download"

test("a streamed download publishes atomically and cancellation preserves an existing destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-org-download-"))
  const target = path.join(root, "result.bin")
  await fs.writeFile(target, "original")
  const controller = new AbortController()
  try {
    await expect(
      saveOrganizationDownload({
        fileName: "result.bin",
        signal: controller.signal,
        choose: async () => target,
        write: async (append) => {
          await append(new Uint8Array([0, 255]))
          controller.abort()
          return 2
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(await fs.readFile(target, "utf8")).toBe("original")
    expect(await fs.readdir(root)).toEqual(["result.bin"])
    const bytes = new Uint8Array([0, 255, 128, 10])
    const result = await saveOrganizationDownload({
      fileName: "result.bin",
      signal: new AbortController().signal,
      choose: async () => target,
      write: async (append) => {
        await append(bytes)
        return bytes.byteLength
      },
    })
    expect(result).toEqual({ saved: true, bytes: 4 })
    expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes)
    expect(await fs.readdir(root)).toEqual(["result.bin"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
