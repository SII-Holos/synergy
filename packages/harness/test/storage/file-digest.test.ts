import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileDigest } from "../../src/storage/file-digest"

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
