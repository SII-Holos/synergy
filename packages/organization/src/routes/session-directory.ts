import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationSessionProtocol as Protocol,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionDirectory as Directory } from "../session-directory"
import { OrganizationSessionResources as Resources } from "../session-resources"
import { browserCredentials, operation, validation } from "./shared"

export function sessionDirectoryRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .get(
      "/sessions/:sessionID/resources",
      operation("orgSessionResources.get", "Read a Session resource selection", Execution.Contract),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      async (c) => c.json(await Resources.get(credentials(c), c.req.valid("param").sessionID)),
    )
    .put(
      "/sessions/:sessionID/resources",
      operation("orgSessionResources.set", "Select resources for an idle Session", Execution.Contract, true),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      validator("json", Execution.Change, validation),
      async (c) => c.json(await Resources.set(credentials(c), c.req.valid("param").sessionID, c.req.valid("json"))),
    )
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
