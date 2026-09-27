import { createHmac, timingSafeEqual } from "node:crypto"
import z from "zod"

const ClaimsSchema = z
  .object({
    protocolVersion: z.literal(2),
    ownerKey: z.string().min(1).max(20_000),
    serverOrigin: z.string().url().max(20_000),
    nonce: z.string().min(16).max(200),
    expiresAt: z.number().int().positive(),
  })
  .strict()

export type BrowserNativeLeaseClaims = z.infer<typeof ClaimsSchema>

export namespace BrowserNativeLease {
  export function issue(
    secret: string,
    input: { ownerKey: string; serverOrigin: string; ttlMs?: number; now?: number },
  ): string {
    if (!secret) throw new Error("Browser Host registration secret is unavailable.")
    const claims = ClaimsSchema.parse({
      protocolVersion: 2,
      ownerKey: input.ownerKey,
      serverOrigin: new URL(input.serverOrigin).origin,
      nonce: crypto.randomUUID(),
      expiresAt: (input.now ?? Date.now()) + Math.min(Math.max(input.ttlMs ?? 30_000, 1_000), 60_000),
    })
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return `${payload}.${signature(secret, payload)}`
  }

  export function verify(secret: string, token: string, now = Date.now()): BrowserNativeLeaseClaims {
    if (!secret || token.length > 4_096) throw new Error("Native Browser presentation ticket is invalid.")
    const [payload, provided, extra] = token.split(".")
    if (!payload || !provided || extra) throw new Error("Native Browser presentation ticket is malformed.")
    const expected = signature(secret, payload)
    const actualBytes = Buffer.from(provided)
    const expectedBytes = Buffer.from(expected)
    if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error("Native Browser presentation ticket signature is invalid.")
    }
    const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    if (claims.expiresAt <= now) throw new Error("Native Browser presentation ticket has expired.")
    return claims
  }
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}
