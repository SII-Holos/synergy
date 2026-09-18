import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import { StorageIntegrityError } from "./errors"

// Activation retirement runs while the Home is exclusively locked, so a
// legitimate legacy writer cannot appear; the checks defend against out-of-band
// mutation. Legacy writers only replace whole records atomically, so a
// byte-count match on a large Home makes a full digest of every file the most
// expensive part of activation without adding real protection. Small Homes
// (and sampled positions above the threshold) still digest everything.
const RETIRE_FULL_VERIFY_FILE_LIMIT = 4096
const RETIRE_SAMPLE_STRIDE = 16

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

/**
 * Verifies one legacy file immediately before its retirement unlink or its
 * backup-side deletion guard. A missing file only passes when the caller
 * tolerates absence (the source may already be retired after an interrupted
 * activation; a backup copy may not). Small Homes digest every file; large
 * ones digest a deterministic sample of positions because the exclusive Home
 * lock already excludes the registered legacy writer and whole-record
 * replacement always shifts the byte count.
 */
export async function verifyRetirement(
  filename: string,
  expectedHash: string,
  expectedSize: number,
  position: { total: number; index: number },
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
  if (position.total > RETIRE_FULL_VERIFY_FILE_LIMIT && position.index % RETIRE_SAMPLE_STRIDE !== 0) return
  if ((await fileDigest(filename, expectedSize)) !== expectedHash) throw new StorageIntegrityError(reason)
}
