import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationSessionToolProtocol as SessionTool } from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { readSessionForExecution } from "../session-tool"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function sessionToolRoutes(grants: () => ExecutionGrants) {
  return new Hono().post(
    "/session-tools/read",
    operation(
      "orgSessionTools.read",
      "Read an authorized shared projection for accepted native work",
      SessionTool.ReadResult,
      true,
    ),
    validator("json", SessionTool.ReadRequest, validation),
    async (c) => {
      if (c.req.header("origin") || c.req.header("cookie"))
        fail("PERMISSION_DENIED", "Session tool reads require a machine proof")
      return c.json(await readSessionForExecution(grants(), c.req.valid("json"), c.req.raw.signal))
    },
  )
}
