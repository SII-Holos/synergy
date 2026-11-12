import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { OrganizationCloud } from "../cloud"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function cloudFileRoutes(grants: () => ExecutionGrants) {
  return new Hono().post(
    "/workspaces/files",
    operation(
      "orgCloudFiles.request",
      "Access the one authoritative Workspace through an accepted native root",
      Cloud.FileResult,
      true,
    ),
    validator("json", Cloud.FileRequest, validation),
    async (c) => {
      if (c.req.header("cookie") || c.req.header("origin"))
        fail("PERMISSION_DENIED", "Workspace files require a signed machine request")
      const request = c.req.valid("json")
      return c.json(
        await grants().withWorkspace(request, c.req.raw.signal, (authority) =>
          OrganizationCloud.file(authority, c.req.raw.signal),
        ),
      )
    },
  )
}
