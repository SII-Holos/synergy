import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function executionRoutes(grants: () => ExecutionGrants) {
  return new Hono().post(
    "/execution/bind",
    operation(
      "orgExecution.bind",
      "Bind an admitted execution grant to a proven native root",
      Execution.BoundGrant,
      true,
    ),
    validator("json", Execution.BindingRequest, validation),
    async (c) => {
      if (c.req.header("origin") || c.req.header("cookie"))
        fail("PERMISSION_DENIED", "Execution binding requires a machine request")
      return c.json(await grants().bind(c.req.valid("json")))
    },
  )
}
