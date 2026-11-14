import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationApiTokenProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationApiTokens as Tokens } from "../auth/api-tokens"
import { browserCredentials, operation, validation } from "./shared"

export function apiTokenRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/api-tokens",
      operation(
        "orgApiTokens.create",
        "Issue a project and operation scoped personal API token once",
        Protocol.Created,
        true,
      ),
      validator("json", Protocol.Create, validation),
      async (c) => c.json(await Tokens.create(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/api-tokens",
      operation("orgApiTokens.list", "Page your API token metadata without original secrets", Protocol.Page),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await Tokens.list(credentials(c), c.req.valid("query"))),
    )
    .post(
      "/api-tokens/:tokenID/revoke",
      operation("orgApiTokens.revoke", "Revoke a personal API token", Protocol.Metadata, true),
      validator("param", z.strictObject({ tokenID: Identity.ID }), validation),
      validator("json", Protocol.Revoke, validation),
      async (c) => c.json(await Tokens.revoke(credentials(c), c.req.valid("param").tokenID, c.req.valid("json"))),
    )
}
