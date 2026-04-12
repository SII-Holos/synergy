import { NamedError } from "@ericsanchezok/synergy-util/error"
import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import z from "zod"

type JwtPayload = Record<string, unknown> & {
  exp?: number
  nbf?: number
}

function envFlag(name: string) {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
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
    return envFlag("SYNERGY_HOSTED")
  }

  export function authEnabled() {
    return enabled() || envFlag("SYNERGY_AUTH_ENABLED")
  }

  export function disableWebMount() {
    return envFlag("SYNERGY_DISABLE_WEB_MOUNT")
  }

  export function scopeRoot() {
    return path.resolve(process.env.SYNERGY_SCOPE_ROOT || "/workspace")
  }

  export function cookieName() {
    return process.env.SYNERGY_AUTH_COOKIE_NAME || "holos_jwt"
  }

  export function jwtAlgorithm() {
    return process.env.SYNERGY_JWT_ALGORITHM || "HS256"
  }

  export function ownerId() {
    return process.env.HOLOS_OWNER_ID
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

  export function defaultDirectory() {
    return scopeRoot()
  }

  export async function verifyJwt(token: string): Promise<JwtPayload> {
    const secret = process.env.SYNERGY_JWT_SECRET
    if (!secret) {
      throw new Error("SYNERGY_JWT_SECRET is required when hosted auth is enabled")
    }

    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error("invalid_token")
    }

    const header = JSON.parse(decodeBase64Url(encodedHeader).toString("utf8")) as { alg?: string; typ?: string }
    const payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as JwtPayload
    const algorithm = jwtAlgorithm()
    if (header.alg !== algorithm) {
      throw new Error("invalid_algorithm")
    }
    if (algorithm !== "HS256") {
      throw new Error("unsupported_algorithm")
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

    const ownerIdValue = ownerId()
    if (ownerIdValue !== undefined) {
      const payloadUserId = String(payload["user_id"])
      const ownerUserId = String(ownerIdValue)
      if (payloadUserId !== ownerUserId) {
        throw new Error("invalid_owner")
      }
    }

    return payload
  }
}
