import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationCloudExecutionProtocol as CloudEnvironment } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationCloudEnvironments } from "../cloud-environments"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function cloudEnvironmentExecutionRoutes(environments: () => OrganizationCloudEnvironments) {
  return new Hono()
    .post(
      "/environments/execution",
      operation(
        "orgCloudExecution.request",
        "Use the original selected Environment through accepted native execution",
        CloudEnvironment.Result,
        true,
      ),
      validator("json", CloudEnvironment.Request, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Environment execution requires a signed machine request")
        return c.json(await environments().request(c.req.valid("json"), c.req.raw.signal))
      },
    )
    .post(
      "/environments/execution/retirement",
      operation(
        "orgCloudExecution.retire",
        "Retire only the original retained Environment operation",
        CloudEnvironment.RetirementResult,
        true,
      ),
      validator("json", CloudEnvironment.RetirementRequest, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Environment retirement requires its signed original machine receipt")
        return c.json(await environments().retire(c.req.valid("json"), c.req.raw.signal))
      },
    )
    .post(
      "/environments/execution/retirement/inspection",
      operation(
        "orgCloudExecution.inspectRetirement",
        "Inspect the original Environment retirement without repeating cleanup",
        CloudEnvironment.RetirementResult,
        true,
      ),
      validator("json", CloudEnvironment.RetirementInspectionRequest, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Environment retirement inspection requires its signed original machine receipt")
        return c.json(await environments().inspectRetirement(c.req.valid("json"), c.req.raw.signal))
      },
    )
    .post(
      "/environments/execution/inspection",
      operation(
        "orgCloudExecution.inspect",
        "Inspect only the original retained Environment operation without dispatch",
        CloudEnvironment.InspectionResult,
        true,
      ),
      validator("json", CloudEnvironment.InspectionRequest, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Environment receipt inspection requires a signed machine request")
        return c.json(await environments().inspect(c.req.valid("json"), c.req.raw.signal))
      },
    )
}
