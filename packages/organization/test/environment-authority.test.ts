import { expect, test } from "bun:test"
import { OrganizationResources } from "../src/resources"
import { OrganizationExecutionGrants } from "../src/execution-grants"
import { selectedEnvironmentTask } from "./support/environment-task"

test("Environment effects require the complete signed operation and a live original authority callback", async () => {
  await using f = await selectedEnvironmentTask()
  const request = await f.resolve()
  let escaped: OrganizationExecutionGrants.EnvironmentAuthority | undefined
  await f.run(() =>
    f.execution.withEnvironment(request, undefined, async (evidence) => {
      escaped = evidence
      expect(OrganizationExecutionGrants.environmentAuthority(evidence).grant.grantID).toBe(f.grant.grantID)
    }),
  )
  if (!escaped) throw new Error("The original accepted callback did not run")
  const original = escaped
  await f.run(() => expect(() => OrganizationExecutionGrants.environmentAuthority(original)).toThrow())
  const changed = structuredClone(request)
  changed.proof.operation = {
    action: "resolve",
    nativeOperationID: f.nativeOperationID,
    capability: "pty",
    origin: { kind: "native-test" },
    workspace: f.workspace,
  }
  let entered = false
  await expect(
    f.run(() =>
      f.execution.withEnvironment(changed, undefined, async () => {
        entered = true
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  expect(entered).toBe(false)
})

test("Environment authority preserves accepted project selection while rechecking disabled resources and Working location", async () => {
  await using f = await selectedEnvironmentTask()
  const wrong = await f.request({
    action: "resolve",
    nativeOperationID: f.nativeOperationID,
    capability: "exec",
    origin: {},
    workspace: {
      ...f.workspace,
      workspaceID: "another-workspace",
    },
  })
  await expect(f.run(() => f.execution.withEnvironment(wrong, undefined, async () => {}))).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH" },
  })
  const request = await f.resolve()
  await expect(
    f.run(() =>
      f.execution.withEnvironment(request, undefined, async (evidence) => {
        await OrganizationResources.grant(
          f.credentials.admin,
          f.compute.resourceID,
          { kind: "project", id: "project" },
          { expectedRevision: 1, enabled: false },
        )
        await OrganizationExecutionGrants.environmentAuthority(evidence).recheck()
        await OrganizationResources.update(f.credentials.admin, f.compute.resourceID, {
          expectedRevision: f.compute.revision,
          state: "disabled",
        })
        await OrganizationExecutionGrants.environmentAuthority(evidence).recheck()
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
})
