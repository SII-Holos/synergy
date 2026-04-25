import { NamedError } from "@ericsanchezok/synergy-util/error"
import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import z from "zod"
import { Flag } from "@/flag/flag"

type JwtPayload = Record<string, unknown> & {
  exp?: number
  nbf?: number
  iss?: string
  aud?: string | string[]
}

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
  return Buffer.from(padded, "base64")
}

function parseCookie(header: string | undefined, name: string) {
  if (!header) return
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=")
    if (rawKey !== name) continue
    return decodeURIComponent(rawValue.join("="))
  }
}

function isWithinRoot(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export namespace Hosted {
  export const DirectoryAccessError = NamedError.create(
    "HostedDirectoryAccessError",
    z.object({
      path: z.string(),
      root: z.string(),
    }),
  )

  export function enabled() {
    return Flag.SYNERGY_HOSTED
  }

  export function authEnabled() {
    return enabled()
  }

  export function disableWebMount() {
    return Flag.SYNERGY_DISABLE_WEB_MOUNT
  }

  export function scopeRoot() {
    return path.resolve(Flag.SYNERGY_SCOPE_ROOT || "/workspace")
  }

  export function defaultDirectory() {
    return scopeRoot()
  }

  export function cookieName() {
    return Flag.SYNERGY_AUTH_COOKIE_NAME
  }

  export function ownerId() {
    return Flag.HOLOS_OWNER_ID
  }

  export function readToken(input: { cookie?: string; authorization?: string }) {
    const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (bearer) return bearer
    return parseCookie(input.cookie, cookieName())
  }

  export function resolveDirectory(input: string) {
    if (!enabled() || input === "global") return input

    const root = scopeRoot()
    const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)
    if (!isWithinRoot(root, resolved)) {
      throw new DirectoryAccessError({ path: resolved, root })
    }
    return resolved
  }

  export async function verifyJwt(token: string): Promise<JwtPayload> {
    const secret = Flag.SYNERGY_JWT_SECRET
    if (!secret) {
      throw new Error("missing_jwt_secret")
    }

    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error("invalid_token")
    }

    let header: { alg?: string }
    let payload: JwtPayload
    try {
      header = JSON.parse(decodeBase64Url(encodedHeader).toString("utf8")) as { alg?: string }
      payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as JwtPayload
    } catch {
      throw new Error("invalid_token")
    }

    if (header.alg !== "HS256") {
      throw new Error("invalid_algorithm")
    }

    const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest()
    const actual = decodeBase64Url(encodedSignature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("invalid_signature")
    }

    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.nbf === "number" && payload.nbf > now) {
      throw new Error("not_yet_valid")
    }
    if (typeof payload.exp === "number" && payload.exp <= now) {
      throw new Error("expired")
    }

    if (Flag.SYNERGY_JWT_ISSUER !== undefined && payload.iss !== Flag.SYNERGY_JWT_ISSUER) {
      throw new Error("invalid_issuer")
    }

    if (Flag.SYNERGY_JWT_AUDIENCE !== undefined) {
      const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud]
      if (!audience.includes(Flag.SYNERGY_JWT_AUDIENCE)) {
        throw new Error("invalid_audience")
      }
    }

    const owner = ownerId()
    if (enabled() && owner === undefined) {
      throw new Error("missing_owner")
    }
    if (owner !== undefined && String(payload.user_id) !== String(owner)) {
      throw new Error("invalid_owner")
    }

    return payload
  }
}
