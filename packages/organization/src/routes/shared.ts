import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { OrganizationIdentity as Identity, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import type { Credentials } from "../auth/session"
import { fail } from "../error"

export const cookie = "__Host-synergy_org_session"
export const cookieOptions = { secure: true, httpOnly: true, sameSite: "Lax" as const, path: "/" }
export function validation(result: { success: boolean }) {
  if (!result.success) fail("INVALID_REQUEST", "Invalid request")
}

export function operation(id: string, summary: string, schema: z.ZodType, body = false, accepted = false) {
  const error = {
    description: "Organization error",
    content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
  }
  return describeRoute({
    operationId: id,
    summary,
    requestBody: body ? { required: true, content: { "application/json": {} } } : undefined,
    responses: {
      200: { description: "Success", content: { "application/json": { schema: resolver(schema) } } },
      ...(accepted
        ? {
            202: {
              description: "Runtime durably received the command",
              content: { "application/json": { schema: resolver(schema) } },
            },
            504: error,
          }
        : {}),
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      503: error,
    },
  })
}

export function browserCredentials(publicOrigin?: string) {
  function checkOrigin(c: Context) {
    if (!publicOrigin) fail("SERVICE_UNAVAILABLE", "The organization public origin is not configured")
    if (c.req.header("origin") !== publicOrigin) fail("PERMISSION_DENIED", "The request origin is not allowed")
  }
  // Provenance: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  // Local adaptation: revocable opaque cookies plus an exact configured Origin and session-bound CSRF token.
  function credentials(c: Context): Credentials {
    const authorization = c.req.header("authorization")
    if (authorization) {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1]
      if (!token) fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
      return { token, kind: "access", origin: c.req.header("origin") }
    }
    const token = getCookie(c, cookie)
    if (!token || !Identity.Token.safeParse(token).success)
      fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return { token }
    checkOrigin(c)
    const csrf = c.req.header("x-csrf-token")
    if (!csrf || !Identity.Token.safeParse(csrf).success) fail("PERMISSION_DENIED", "Invalid request token")
    return { token, csrf }
  }
  return { checkOrigin, credentials }
}
