import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileDigest, verifyRetirement } from "../../src/storage/file-digest"

test("file digests preserve complete bytes across bounded and streamed reads", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "digest-"))
  try {
    const filename = path.join(root, "evidence")
    for (const size of [0, 99, 2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
      const bytes = randomBytes(size)
      await fs.writeFile(filename, bytes)
      expect(await fileDigest(filename, size)).toBe(createHash("sha256").update(bytes).digest("hex"))
      await fs.appendFile(filename, "x")
      await expect(fileDigest(filename, size)).rejects.toThrow("size changed")
      if (size) {
        await fs.truncate(filename, size - 1)
        await expect(fileDigest(filename, size)).rejects.toThrow("size changed")
      }
    }
    await expect(fileDigest(filename, -1)).rejects.toThrow("Invalid expected file size")
    await expect(fileDigest(path.join(root, "missing"), 1)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("retirement verification rejects missing, resized, and same-size corrupt files", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "retire-verify-"))
  try {
    const filename = path.join(root, "record.json")
    await fs.writeFile(filename, "original-bytes")
    const digest = createHash("sha256").update("original-bytes").digest("hex")

    await fs.unlink(filename)
    await expect(verifyRetirement(filename, digest, 14, "changed")).rejects.toThrow("changed")
    await expect(verifyRetirement(filename, digest, 14, "changed", { tolerateMissing: true })).resolves.toBeUndefined()

    await fs.writeFile(filename, "original-bytes")
    await expect(verifyRetirement(filename, digest, 14, "changed")).resolves.toBeUndefined()

    await fs.appendFile(filename, "!")
    await expect(verifyRetirement(filename, digest, 14, "changed")).rejects.toThrow("changed")

    await fs.writeFile(filename, "tampered-bytes")
    await expect(verifyRetirement(filename, digest, 14, "changed")).rejects.toThrow("changed")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
