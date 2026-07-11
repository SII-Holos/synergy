import { createHash } from "node:crypto"

export function browserProfilePartition(ownerKey: string): string {
  return `persist:synergy-browser-${createHash("sha256").update(ownerKey).digest("hex")}`
}
