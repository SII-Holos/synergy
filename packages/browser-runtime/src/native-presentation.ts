import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserNativeLease } from "@ericsanchezok/synergy-browser/native-lease"
import { BrowserBroker } from "./broker.js"
import { BrowserOwner } from "./owner.js"

const consumed = new Map<string, number>()
const MAX_CONSUMED_LEASES = 2_048

export namespace BrowserNativePresentation {
  export function consume(owner: BrowserOwner.Info, serverOrigin: string, token: string | undefined): boolean {
    prune()
    if (!token) return false
    let claims: ReturnType<typeof BrowserNativeLease.verify>
    try {
      claims = BrowserNativeLease.verify(BrowserBroker.secret(), token)
    } catch (error) {
      const expired = error instanceof Error && /expired/i.test(error.message)
      throw new BrowserProtocolError({
        code: expired ? "browser_native_ticket_expired" : "browser_native_ticket_rejected",
        message: expired
          ? "The native Browser presentation ticket expired."
          : "The native Browser presentation ticket was rejected.",
        retryable: true,
      })
    }
    const ownerKey = BrowserOwner.key(owner)
    if (claims.ownerKey !== ownerKey) {
      throw new BrowserProtocolError({
        code: "browser_native_ticket_owner_mismatch",
        message: "The native Browser presentation ticket owner does not match this workspace.",
        retryable: true,
      })
    }
    if (claims.serverOrigin !== new URL(serverOrigin).origin) {
      throw new BrowserProtocolError({
        code: "browser_native_ticket_origin_mismatch",
        message: "The native Browser presentation ticket does not match this server.",
        retryable: true,
      })
    }
    if (consumed.has(claims.nonce)) {
      throw new BrowserProtocolError({
        code: "browser_native_ticket_replayed",
        message: "The native Browser presentation ticket was already used.",
        retryable: true,
      })
    }
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
