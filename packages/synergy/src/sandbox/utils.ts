import * as fs from "fs"
import * as crypto from "crypto"

export function isTarballHelperUpToDate(src: string, dst: string): boolean {
  try {
    const srcStat = fs.statSync(src)
    const dstStat = fs.statSync(dst)
    return srcStat.mtimeMs <= dstStat.mtimeMs
  } catch {
    return false
  }
}

export function verifyHelperHash(binaryPath: string, trustedHashes: Record<string, string>): boolean {
  if (Object.keys(trustedHashes).length === 0) {
    return false
  }
  // Compute digest once to avoid re-reading the file for each candidate hash
  let digest: string
  try {
    const hash = crypto.createHash("sha256")
    hash.update(fs.readFileSync(binaryPath))
    digest = hash.digest("hex")
  } catch {
    return false
  }
  // Try all trusted hashes with constant-time comparison
  for (const trustedHash of Object.values(trustedHashes)) {
    if (!trustedHash || trustedHash.length === 0) continue
    if (digest.length !== trustedHash.length) continue
    let result = 0
    for (let i = 0; i < digest.length; i++) {
      result |= digest.charCodeAt(i) ^ trustedHash.charCodeAt(i)
    }
    if (result === 0) return true
  }
  return false
}
