import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCloud } from "../cloud"
import { browserCredentials, operation, validation } from "./shared"

export function cloudRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  const target = z.strictObject({ workspaceID: Identity.ID })
  return new Hono()
    .post(
      "/cloud/workspaces",
      operation(
        "orgCloudWorkspaces.create",
        "Create an organization-owned cloud Workspace without allocating compute",
        Cloud.Workspace,
        true,
      ),
      validator("json", Cloud.CreateWorkspace, validation),
      async (c) => c.json(await OrganizationCloud.createWorkspace(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/cloud/workspaces/:workspaceID",
      operation("orgCloudWorkspaces.get", "Inspect the canonical cloud Workspace head", Cloud.Workspace),
      validator("param", target, validation),
      async (c) => c.json(await OrganizationCloud.getWorkspace(credentials(c), c.req.valid("param").workspaceID)),
    )
    .get(
      "/projects/:projectID/cloud/workspaces",
      operation(
        "orgCloudWorkspaces.list",
        "List currently authorized Workspaces in a storage resource",
        Cloud.WorkspacePage,
      ),
      validator("param", z.strictObject({ projectID: Identity.ID }), validation),
      validator("query", Identity.Page.extend({ resourceID: Identity.ID }), validation),
      async (c) =>
        c.json(
          await OrganizationCloud.listWorkspaces(
            credentials(c),
            c.req.valid("param").projectID,
            c.req.valid("query").resourceID,
            c.req.valid("query"),
          ),
        ),
    )
    .post(
      "/cloud/workspaces/:workspaceID/read",
      operation(
        "orgCloudWorkspaces.read",
        "Read a bounded file range through current cloud authorization",
        Cloud.Bytes,
        true,
      ),
      validator("param", target, validation),
      validator("json", Cloud.Read, validation),
      async (c) =>
        c.json(await OrganizationCloud.read(credentials(c), c.req.valid("param").workspaceID, c.req.valid("json"))),
    )
    .post(
      "/cloud/workspaces/:workspaceID/write",
      operation(
        "orgCloudWorkspaces.write",
        "Commit a version-checked file write with a durable operation receipt",
        Cloud.Workspace,
        true,
      ),
      validator("param", target, validation),
      validator("json", Cloud.Write, validation),
      async (c) =>
        c.json(await OrganizationCloud.write(credentials(c), c.req.valid("param").workspaceID, c.req.valid("json"))),
    )
    .post(
      "/cloud/environments",
      operation(
        "orgCloudEnvironments.create",
        "Bind an organization-owned Environment without allocating compute",
        Cloud.Environment,
        true,
      ),
      validator("json", Cloud.CreateEnvironment, validation),
      async (c) => c.json(await OrganizationCloud.createEnvironment(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/projects/:projectID/cloud/environments",
      operation(
        "orgCloudEnvironments.list",
        "List currently authorized Environments without allocating compute",
        Cloud.EnvironmentPage,
      ),
      validator("param", z.strictObject({ projectID: Identity.ID }), validation),
      validator("query", Identity.Page.extend({ resourceID: Identity.ID }), validation),
      async (c) =>
        c.json(
          await OrganizationCloud.listEnvironments(
            credentials(c),
            c.req.valid("param").projectID,
            c.req.valid("query").resourceID,
            c.req.valid("query"),
          ),
        ),
    )
    .get(
      "/cloud/environments/:environmentID",
      operation(
        "orgCloudEnvironments.get",
        "Inspect an organization-owned Environment and retained uses",
        Cloud.Environment,
      ),
      validator("param", z.strictObject({ environmentID: Identity.ID }), validation),
      async (c) => c.json(await OrganizationCloud.getEnvironment(credentials(c), c.req.valid("param").environmentID)),
    )
}
