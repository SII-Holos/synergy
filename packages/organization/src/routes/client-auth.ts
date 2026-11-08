import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import { OrganizationClientAuth as Protocol, OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import type { ClientAuthentication } from "../auth/client"
import { browserCredentials, operation, validation } from "./shared"

export function clientAuthenticationRoutes(authentication: () => ClientAuthentication, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .get(
      "/auth/discovery",
      operation("orgAuth.discovery", "Read the registered organization client and issuer", Protocol.Discovery),
      validator("query", z.strictObject({ clientID: OrganizationIdentity.ID }), validation),
      async (c) => c.json(await authentication().discovery(c.req.valid("query").clientID)),
    )
    .post(
      "/auth/authorize",
      operation(
        "orgAuth.authorize",
        "Authorize a registered client from the organization sign-in session",
        Protocol.Code,
        true,
      ),
      validator("json", Protocol.Authorize, validation),
      async (c) => c.json(await authentication().authorize(credentials(c), c.req.valid("json"))),
    )
    .post(
      "/auth/exchange",
      operation("orgAuth.exchange", "Exchange a single-use S256 authorization code", Protocol.Tokens, true),
      validator("json", Protocol.Exchange, validation),
      async (c) => c.json(await authentication().exchange(c.req.valid("json"), c.req.header("origin"))),
    )
    .post(
      "/auth/refresh",
      operation("orgAuth.refresh", "Rotate a Desktop authorization refresh token", Protocol.Tokens, true),
      validator("json", Protocol.Refresh, validation),
      async (c) => c.json(await authentication().refresh(c.req.valid("json"), c.req.header("origin"))),
    )
}
