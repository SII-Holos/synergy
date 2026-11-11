import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { ArtifactPack } from "../../src/storage/artifact-pack"
import { storageTestRuntime } from "../support/storage-runtime"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

test("immutable artifact streams preserve more than 64 MiB without allocating the whole artifact", () =>
  runtime.run(async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-stream-"))
    try {
      const pack = new ArtifactPack(directory)
      const block = new Uint8Array(1024 * 1024).fill(0x37)
      const expected = createHash("sha256")
      const location = await pack.appendStream(
        (async function* () {
          for (let index = 0; index < 65; index++) {
            expected.update(block)
            yield block
          }
        })(),
      )
      expect(location.size).toBe(65 * block.length)
      let size = 0
      const actual = createHash("sha256")
      for await (const chunk of pack.stream(location)) {
        expect(chunk.length).toBeLessThanOrEqual(4 * 1024 * 1024)
        size += chunk.length
        actual.update(chunk)
      }
      expect(size).toBe(location.size)
      expect(actual.digest("hex")).toBe(expected.digest("hex"))
      const same = await pack.appendStream(
        (async function* () {
          for (let index = 0; index < 65; index++) yield block
        })(),
      )
      expect(same).toEqual(location)
      await fs.truncate(path.join(directory, location.pack), location.size - 1)
      await expect(
        (async () => {
          for await (const _chunk of pack.stream(location)) {
          }
        })(),
      ).rejects.toThrow("byte count")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }))

test("streamed reads validate existing compressed blocks and empty artifacts", () =>
  runtime.run(async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-stream-"))
    try {
      const pack = new ArtifactPack(directory)
      const content = Buffer.from("old compressed artifact".repeat(50_000))
      const compressed = await pack.append(content)
      expect(compressed.codec).toBe("gzip")
      const chunks: Uint8Array[] = []
      for await (const chunk of pack.stream(compressed)) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(content)
      const empty = await pack.appendStream((async function* () {})())
      let count = 0
      for await (const _chunk of pack.stream(empty)) count++
      expect(count).toBe(0)
      await fs.rm(path.join(directory, compressed.pack))
      await expect(
        (async () => {
          for await (const _chunk of pack.stream(compressed)) {
          }
        })(),
      ).rejects.toMatchObject({ code: "ENOENT" })
      await fs.rm(path.join(directory, empty.pack))
      await expect(
        (async () => {
          for await (const _chunk of pack.stream(empty)) {
          }
        })(),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }))
