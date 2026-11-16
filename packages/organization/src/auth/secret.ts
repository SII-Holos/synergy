import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function token() {
  return randomBytes(32).toString("hex")
}
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
export function fingerprint(secret: string, value: unknown) {
  return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex")
}
export function matches(value: string, hash: string) {
  return timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"))
}
