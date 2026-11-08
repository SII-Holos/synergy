import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationSessionProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionDirectory as Directory } from "../session-directory"
import { browserCredentials, operation, validation } from "./shared"

export function sessionDirectoryRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .get(
      "/projects/:projectID/sessions",
      operation("orgSessions.list", "List authorized Session directory entries", Protocol.Page),
      validator("param", z.strictObject({ projectID: Identity.ID }), validation),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await Directory.list(credentials(c), c.req.valid("param").projectID, c.req.valid("query"))),
    )
    .get(
      "/sessions/:sessionID",
      operation("orgSessions.get", "Read an authorized Session directory entry", Protocol.View),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      async (c) => c.json(await Directory.get(credentials(c), c.req.valid("param").sessionID)),
    )
    .get(
      "/organization/session-capacity",
      operation("orgOrganization.sessionCapacity", "Read anonymous Session counts", Protocol.Capacity),
      async (c) => c.json(await Directory.capacity(credentials(c))),
    )
}
