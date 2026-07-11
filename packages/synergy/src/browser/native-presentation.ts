import { BrowserNativeLease } from "@ericsanchezok/synergy-browser/native-lease"
import { BrowserBroker } from "./broker.js"
import { BrowserOwner } from "./owner.js"

const consumed = new Map<string, number>()
const MAX_CONSUMED_LEASES = 2_048

export namespace BrowserNativePresentation {
  export function consume(owner: BrowserOwner.Info, serverOrigin: string, token: string | undefined): boolean {
    prune()
    if (!token) return false
    const claims = BrowserNativeLease.verify(BrowserBroker.secret(), token)
    const ownerKey = BrowserOwner.key(owner)
    if (claims.ownerKey !== ownerKey) throw new Error("Native Browser ticket owner does not match.")
    if (claims.serverOrigin !== new URL(serverOrigin).origin)
      throw new Error("Native Browser ticket server does not match.")
    if (consumed.has(claims.nonce)) throw new Error("Native Browser presentation ticket was already used.")
    consumed.set(claims.nonce, claims.expiresAt)
    while (consumed.size > MAX_CONSUMED_LEASES) {
      const oldest = consumed.keys().next().value
      if (typeof oldest !== "string") break
      consumed.delete(oldest)
    }
    return true
  }

  export function resetForTest(): void {
    consumed.clear()
  }
}

function prune(): void {
  const now = Date.now()
  for (const [nonce, expiresAt] of consumed) if (expiresAt < now) consumed.delete(nonce)
}
