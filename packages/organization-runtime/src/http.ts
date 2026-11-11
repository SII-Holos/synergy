import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import {
  OrganizationIdentity,
  OrganizationLocalProjectProtocol as Protocol,
  OrganizationProtocol,
  OrganizationReadProtocol as Read,
} from "@ericsanchezok/synergy-organization-protocol"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { z } from "zod"
import { OrganizationLocalProjects } from "./local-project"
import { OrganizationRuntimeError } from "./error"
import { OrganizationSessionReads } from "./session-reads"

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
      routes: {
        "global-services": new Hono().route("/organization-local-project", localProjectRoutes()).post(
          "/organization/session/read",
          describeRoute({
            summary: "Read creator-only history from this native member Runtime",
            operationId: "orgLocalSession.read",
            requestBody: { required: true, content: { "application/json": {} } },
            responses: {
              200: {
                description: "Safe bounded native content",
                content: { "application/json": { schema: resolver(Read.Result) } },
              },
              403: {
                description: "Creator access required",
                content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
              },
              409: {
                description: "Native content changed",
                content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
              },
              503: {
                description: "Native content unavailable",
                content: { "application/json": { schema: resolver(OrganizationProtocol.Error) } },
              },
            },
          }),
          validator("json", Read.Query),
          async (c) => {
            try {
              return c.json(await OrganizationSessionReads.local(c.req.valid("json"), c.req.raw.signal))
            } catch (error) {
              const failure =
                error instanceof OrganizationRuntimeError
                  ? error.data
                  : {
                      code: "SERVICE_UNAVAILABLE" as const,
                      message: "Native Session reading could not finish",
                      retryable: false,
                      outcome: "not_dispatched" as const,
                    }
              return c.json(
                failure,
                failure.code === "PERMISSION_DENIED"
                  ? 403
                  : failure.code === "REVISION_CONFLICT"
                    ? 409
                    : failure.code === "NOT_FOUND"
                      ? 404
                      : 503,
              )
            }
          },
        ),
      },
      isGlobalRoute: (pathname) =>
        pathname === "/organization/session/read" ||
        pathname === "/organization-local-project" ||
        pathname.startsWith("/organization-local-project/"),
    },
    "organization-runtime",
  )
}
