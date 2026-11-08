import { z } from "zod"

export const SigningPublicKey = z.string().regex(/^[a-f0-9]{64}$/)
export const SigningSignature = z.string().regex(/^[a-f0-9]{128}$/)

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
function decode(value: string) {
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16))
}

// Provenance: https://www.rfc-editor.org/rfc/rfc8032 and https://nodejs.org/api/webcrypto.html
// Local adaptation: Ed25519 signs a fixed domain prefix and a strictly validated, recursively ordered protocol object.
export function signedProtocol<T>(schema: z.ZodType<T>, domain: string) {
  function bytes(value: T) {
    return new TextEncoder().encode(domain + JSON.stringify(canonical(schema.parse(value))))
  }
  return {
    async publicKey(key: CryptoKey) {
      return SigningPublicKey.parse(hex(await crypto.subtle.exportKey("raw", key)))
    },
    async sign(value: T, key: CryptoKey) {
      return SigningSignature.parse(hex(await crypto.subtle.sign("Ed25519", key, bytes(value))))
    },
    async verify(value: unknown, signature: unknown, publicKey: unknown) {
      const parsed = schema.safeParse(value)
      const signed = SigningSignature.safeParse(signature)
      const raw = SigningPublicKey.safeParse(publicKey)
      if (!parsed.success || !signed.success || !raw.success) return false
      try {
        const key = await crypto.subtle.importKey("raw", decode(raw.data), "Ed25519", false, ["verify"])
        return await crypto.subtle.verify("Ed25519", key, decode(signed.data), bytes(parsed.data))
      } catch {
        return false
      }
    },
  }
}
