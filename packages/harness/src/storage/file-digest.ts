import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import { StorageIntegrityError } from "./errors"
import { UpgradeWork } from "./upgrade-work"

export async function fileDigest(filename: string, expectedSize: number): Promise<string> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    throw new StorageIntegrityError("Invalid expected file size")
  UpgradeWork.signal()?.throwIfAborted()
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
    for await (const bytes of createReadStream(filename, { signal: UpgradeWork.signal() })) {
      size += bytes.length
      if (size > expectedSize) throw new StorageIntegrityError("File size changed during integrity verification")
      digest.update(bytes)
    }
  }
  if (size !== expectedSize) throw new StorageIntegrityError("File size changed during integrity verification")
  return digest.digest("hex")
}

export async function verifyRetirement(
  filename: string,
  expectedHash: string,
  expectedSize: number,
  reason: string,
  options: { tolerateMissing?: boolean } = {},
): Promise<void> {
  let size: number
  try {
    size = (await fs.stat(filename)).size
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
    if (options.tolerateMissing) return
    throw new StorageIntegrityError(reason)
  }
  if (size !== expectedSize) throw new StorageIntegrityError(reason)
  if ((await fileDigest(filename, expectedSize)) !== expectedHash) throw new StorageIntegrityError(reason)
}
