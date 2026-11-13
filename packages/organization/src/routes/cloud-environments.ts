import { Hono } from "hono"
import { validator } from "hono-openapi"
import { OrganizationCloudExecutionProtocol as CloudEnvironment } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCloudCleanupProtocol as Cleanup } from "@ericsanchezok/synergy-organization-protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import type { OrganizationCloudEnvironments } from "../cloud-environments"
import { OrganizationExecutionGrants as Grants, type ExecutionGrants } from "../execution-grants"
import { OrganizationCloud } from "../cloud"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function cloudEnvironmentExecutionRoutes(
  environmentOwner: () => OrganizationCloudEnvironments | undefined,
  execution: () => ExecutionGrants,
) {
  function environments() {
    const owner = environmentOwner()
    if (!owner) fail("SERVICE_UNAVAILABLE", "Native Environment execution is unavailable")
    return owner
  }
  async function emptyNative(evidence: Grants.NativeCleanupAuthority) {
    const frame = Grants.nativeCleanupAuthority(evidence)
    if (await Environment.hasState())
      fail("RESOURCE_UNAVAILABLE", "Retained native cleanup requires its original configured Environment owner")
    await frame.recheck()
    return frame
  }
  return new Hono()
    .post(
      "/environments/cleanups",
      operation(
        "orgCloudCleanup.discover",
        "Discover only original retained native cleanup selectors",
        Cleanup.Page,
        true,
      ),
      validator("json", Cleanup.DiscoveryRequest, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Native cleanup requires a signed machine retention request")
        const request = c.req.valid("json"),
          owner = environmentOwner()
        if (owner) return c.json(await owner.discover(request, c.req.raw.signal))
        return c.json(
          await execution().withNativeCleanupDiscovery(request, c.req.raw.signal, async (evidence) => {
            const frame = await emptyNative(evidence)
            return Cleanup.Page.parse({
              version: 1,
              grantID: frame.grant.grantID,
              generation: frame.generation,
              items: [],
            })
          }),
        )
      },
    )
    .post(
      "/environments/cleanups/reconciliation",
      operation(
        "orgCloudCleanup.reconcile",
        "Reconcile only an original native cleanup selector",
        Cleanup.Result,
        true,
      ),
      validator("json", Cleanup.ReconciliationRequest, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Native cleanup reconciliation requires its signed machine retention request")
        const request = c.req.valid("json"),
          owner = environmentOwner()
        if (owner) return c.json(await owner.reconcileNative(request, c.req.raw.signal))
        return c.json(
          await execution().withNativeCleanupReconciliation(request, c.req.raw.signal, async (evidence) => {
            const frame = await emptyNative(evidence)
            if (request.proof.candidate.scopeID !== OrganizationCloud.scopeID(frame.grant.orgID, frame.grant.projectID))
              fail("PERMISSION_DENIED", "Native cleanup selector has another original Scope")
            return Cleanup.Result.parse({ candidate: request.proof.candidate, state: "absent" })
          }),
        )
      },
    )
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
