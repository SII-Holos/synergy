import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function executionRoutes(grants: () => ExecutionGrants) {
  return new Hono()
    .post(
      "/execution/handoff-inventory",
      operation(
        "orgExecution.handoffInventory",
        "Page the canonical retained source resources of this prepared handoff",
        Execution.HandoffInventoryPage,
        true,
      ),
      validator("json", Execution.HandoffInventoryRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Handoff inventory requires a machine request")
        return c.json(await grants().handoffInventory(c.req.valid("json")))
      },
    )
    .post(
      "/execution/handoff-close",
      operation(
        "orgExecution.closeHandoff",
        "Close a drained source resource generation with a permanent handoff cause",
        Execution.HandoffCloseReceipt,
        true,
      ),
      validator("json", Execution.HandoffCloseRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Handoff resource closure requires a machine request")
        return c.json(await grants().closeHandoff(c.req.valid("json")))
      },
    )
    .post(
      "/execution/retention",
      operation(
        "orgExecution.retention",
        "Inspect accepted resource retention without acquiring execution authority",
        Execution.RetentionResult,
        true,
      ),
      validator("json", Execution.RetentionRequest, validation),
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
      "/execution/caller",
      operation(
        "orgExecution.caller",
        "Authorize the current caller of an accepted retained execution without reading its content",
        Execution.CallerAccess,
        true,
      ),
      validator("json", Execution.DescriptionRequest, validation),
      async (c) => {
        if (c.req.header("origin") || c.req.header("cookie"))
          fail("PERMISSION_DENIED", "Execution caller access requires a machine request")
        return c.json(await grants().caller(c.req.valid("json")))
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
