import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationResources as Resources } from "../resources"
import { browserCredentials, operation, validation } from "./shared"

export function resourceRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  const target = z.strictObject({ resourceID: Identity.ID })
  const grants = target.extend({ kind: Resource.SubjectKind })
  return new Hono()
    .get(
      "/resources",
      operation("orgResources.list", "List resource configurations for an administrator", Resource.AdminPage),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await Resources.list(credentials(c), c.req.valid("query"))),
    )
    .post(
      "/resources",
      operation("orgResources.create", "Configure an organization resource", Resource.AdminView, true),
      validator("json", Resource.Create, validation),
      async (c) => c.json(await Resources.create(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/resources/:resourceID",
      operation("orgResources.get", "Read a resource configuration without its secret", Resource.AdminView),
      validator("param", target, validation),
      async (c) => c.json(await Resources.get(credentials(c), c.req.valid("param").resourceID)),
    )
    .patch(
      "/resources/:resourceID",
      operation(
        "orgResources.update",
        "Update a resource configuration or rotate its credential",
        Resource.AdminView,
        true,
      ),
      validator("param", target, validation),
      validator("json", Resource.Change, validation),
      async (c) => c.json(await Resources.update(credentials(c), c.req.valid("param").resourceID, c.req.valid("json"))),
    )
    .get(
      "/resources/:resourceID/grants/:kind",
      operation("orgResourceGrants.list", "List resource use grants for an administrator", Resource.GrantPage),
      validator("param", grants, validation),
      validator("query", Identity.Page, validation),
      async (c) => {
        const target = c.req.valid("param")
        return c.json(await Resources.grants(credentials(c), target.resourceID, target.kind, c.req.valid("query")))
      },
    )
    .put(
      "/resources/:resourceID/grants/:kind/:subjectID",
      operation("orgResourceGrants.set", "Grant or revoke resource use", Resource.Grant, true),
      validator("param", grants.extend({ subjectID: Identity.ID }), validation),
      validator("json", Resource.GrantChange, validation),
      async (c) => {
        const target = c.req.valid("param")
        return c.json(
          await Resources.grant(
            credentials(c),
            target.resourceID,
            { kind: target.kind, id: target.subjectID },
            c.req.valid("json"),
          ),
        )
      },
    )
    .get(
      "/projects/:projectID/resources",
      operation("orgProjectResources.list", "List the caller's available project resources", Resource.Page),
      validator("param", z.strictObject({ projectID: Identity.ID }), validation),
      validator("query", Identity.Page, validation),
      async (c) =>
        c.json(
          await Resources.available(
            credentials(c, "resources.read"),
            c.req.valid("param").projectID,
            c.req.valid("query"),
          ),
        ),
    )
}
