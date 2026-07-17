import { createHmac, timingSafeEqual } from "crypto"

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i

export function verifyGitHubSignature(
  rawBody: Uint8Array,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false
  const match = signature.match(SIGNATURE_PATTERN)
  if (!match) return false

  const received = Buffer.from(match[1], "hex")
  const expected = createHmac("sha256", secret).update(rawBody).digest()
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}
