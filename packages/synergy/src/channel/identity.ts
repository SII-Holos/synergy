export function externalIdentityHash(...parts: Array<string | undefined>): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part ?? "")
    hasher.update("\0")
  }
  return hasher.digest("hex")
}
