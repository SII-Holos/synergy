import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { StorageCheckpoint } from "../../src/storage/checkpoint"

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-artifact-"))
  await fs.mkdir(path.join(directory, "objects"))
  const bytes = randomBytes(4 * 1024 * 1024 + 17)
  const location = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  const filename = path.join(directory, "objects", `${location.sha256}.bin`)
  await fs.writeFile(filename, bytes)
  return {
    directory,
    bytes,
    location,
    filename,
    async [Symbol.asyncDispose]() {
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("the trusted checkpoint artifact port verifies actual streamed bytes and requires complete consumption", async () => {
  await using f = await fixture()
  const chunks: Uint8Array[] = []
  for await (const chunk of StorageCheckpoint.streamArtifact(f)) {
    expect(chunk.length).toBeLessThanOrEqual(4 * 1024 * 1024)
    chunks.push(chunk)
  }
  expect(Buffer.concat(chunks)).toEqual(f.bytes)
  const early = StorageCheckpoint.streamArtifact(f)
  await early.next()
  await expect(early.return(undefined)).rejects.toThrow("complete")
  const controller = new AbortController()
  const reason = new Error("Stop reading captured Snapshot bytes")
  const cancelled = StorageCheckpoint.streamArtifact({ ...f, signal: controller.signal })
  await cancelled.next()
  controller.abort(reason)
  await expect(cancelled.next()).rejects.toBe(reason)
})

test("another valid namespace artifact cannot replace the selected bytes and missing or linked files fail closed", async () => {
  await using f = await fixture()
  const other = randomBytes(f.bytes.length)
  await fs.writeFile(f.filename, other)
  await expect(Array.fromAsync(StorageCheckpoint.streamArtifact(f))).rejects.toThrow("integrity")
  await fs.rm(f.filename)
  await expect(Array.fromAsync(StorageCheckpoint.streamArtifact(f))).rejects.toThrow()
  const foreign = path.join(f.directory, "foreign")
  await fs.writeFile(foreign, f.bytes)
  await fs.symlink(foreign, f.filename)
  await expect(Array.fromAsync(StorageCheckpoint.streamArtifact(f))).rejects.toThrow("ordinary")
})
