import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import type { Handoffs } from "../handoff"
import { OrganizationCloud } from "../cloud"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function handoffWorkspaceRoutes(handoffs: () => Handoffs) {
  return new Hono().post(
    "/handoffs/workspace",
    operation(
      "orgHandoffWorkspace.request",
      "Transfer and validate the exact consented Workspace through its original move owner",
      Cloud.HandoffWorkspaceResult,
      true,
    ),
    validator("json", Cloud.HandoffWorkspaceRequest, validation),
    async (c) => {
      if (c.req.header("cookie") || c.req.header("origin"))
        fail("PERMISSION_DENIED", "Workspace transfers require a signed participant request")
      return c.json(
        await handoffs().withWorkspace(c.req.valid("json"), c.req.raw.signal, (evidence) =>
          OrganizationCloud.handoffWorkspace(evidence, c.req.raw.signal),
        ),
      )
    },
  )
}
