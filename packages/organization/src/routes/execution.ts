import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function executionRoutes(grants: () => ExecutionGrants) {
  return new Hono()
    .post(
      "/execution/retention",
      operation(
        "orgExecution.retention",
        "Inspect accepted resource retention without acquiring execution authority",
        Execution.Grant,
        true,
      ),
      validator("json", Execution.DescriptionRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Retention inspection requires a machine request")
        return c.json(await grants().retention(c.req.valid("json")))
      },
    )
    .post(
      "/execution/resources",
      operation(
        "orgExecution.resources",
        "Describe the resources of accepted work without activating its grant",
        Execution.Description,
        true,
      ),
      validator("json", Execution.DescriptionRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Resource description requires a machine request")
        return c.json(await grants().describe(c.req.valid("json")))
      },
    )
    .post(
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
    .post(
      "/execution/release",
      operation(
        "orgExecution.release",
        "Release drained resources while retaining native root execution evidence",
        Execution.ReleaseReceipt,
        true,
      ),
      validator("json", Execution.ReleaseRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Execution release requires a machine request")
        return c.json(await grants().release(c.req.valid("json")))
      },
    )
}
