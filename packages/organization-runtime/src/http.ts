import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import {
  OrganizationIdentity,
  OrganizationLocalProjectProtocol as Protocol,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { z } from "zod"
import { OrganizationLocalProjects } from "./local-project"
import { OrganizationRuntimeError } from "./error"

async function localResult(c: Context, operation: () => Promise<Protocol.Summary>) {
  try {
    return c.json(await operation())
  } catch (error) {
    if (!(error instanceof OrganizationRuntimeError)) throw error
    return c.json(
      error.data,
      error.data.code === "PERMISSION_DENIED" ? 403 : error.data.code === "REVISION_CONFLICT" ? 409 : 503,
    )
  }
}

export const localProjectRoutes = () =>
  new Hono()
    .get(
      "/:projectID",
      describeRoute({
        summary: "Read this member machine's project directory binding",
        operationId: "orgLocalProject.get",
        responses: {
          200: {
            description: "Safe local Workspace summary",
            content: { "application/json": { schema: resolver(Protocol.Summary) } },
          },
          403: {
            description: "Member Runtime required",
            content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
          },
          503: {
            description: "Binding unavailable",
            content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
          },
        },
      }),
      validator("param", z.strictObject({ projectID: OrganizationIdentity.ID })),
      async (c) => localResult(c, () => OrganizationLocalProjects.get(c.req.valid("param").projectID)),
    )
    .post(
      "/:projectID",
      describeRoute({
        summary: "Bind a native directory selected on this member machine",
        operationId: "orgLocalProject.bind",
        responses: {
          200: {
            description: "Safe committed local Workspace summary",
            content: { "application/json": { schema: resolver(Protocol.Summary) } },
          },
          403: {
            description: "Member Runtime required",
            content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
          },
          409: {
            description: "Binding or request changed",
            content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
          },
          503: {
            description: "Directory unavailable",
            content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
          },
        },
      }),
      validator("param", z.strictObject({ projectID: OrganizationIdentity.ID })),
      validator("json", Protocol.Bind),
      async (c) =>
        localResult(c, () => OrganizationLocalProjects.bind(c.req.valid("param").projectID, c.req.valid("json"))),
    )

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "global-services": new Hono().route("/organization-local-project", localProjectRoutes()) },
      isGlobalRoute: (pathname) =>
        pathname === "/organization-local-project" || pathname.startsWith("/organization-local-project/"),
    },
    "organization-runtime",
  )
}
