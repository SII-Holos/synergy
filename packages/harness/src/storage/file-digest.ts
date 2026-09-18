import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { StorageIntegrityError } from "./errors"

export async function fileDigest(filename: string, expectedSize: number): Promise<string> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    throw new StorageIntegrityError("Invalid expected file size")
  const digest = createHash("sha256")
  let size = 0
  if (expectedSize <= 2 * 1024 * 1024) {
    // The extra byte detects growth without reading an unexpectedly large replacement.
    const bytes = await Bun.file(filename)
      .slice(0, expectedSize + 1)
      .arrayBuffer()
    size = bytes.byteLength
    digest.update(new Uint8Array(bytes))
  } else {
    for await (const bytes of createReadStream(filename)) {
      size += bytes.length
      if (size > expectedSize) throw new StorageIntegrityError("File size changed during integrity verification")
      digest.update(bytes)
    }
  }
  if (size !== expectedSize) throw new StorageIntegrityError("File size changed during integrity verification")
  return digest.digest("hex")
}
