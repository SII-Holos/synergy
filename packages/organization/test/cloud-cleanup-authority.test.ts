import { expect, test } from "bun:test"
import {
  OrganizationCloudCleanupProtocol as Cleanup,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { OrganizationExecutionGrants as Grants } from "../src/execution-grants"
import { OrganizationCloud } from "../src/cloud"
import { executionFixture } from "./support/execution"
import { selectedEnvironmentTask } from "./support/environment-task"

type Fixture = Awaited<ReturnType<typeof executionFixture>>
async function inspection(
  f: Pick<Fixture, "binding" | "grant" | "machineKeys">,
  changes: Partial<Execution.InspectionProof> = {},
) {
  const proof = Execution.InspectionProof.parse({
    ...f.binding.proof,
    purpose: "execution-retention-inspection",
    grantID: f.grant.grantID,
    generation: f.grant.retention.generation,
    ...changes,
  })
  return { proof, signature: await Execution.signInspection(proof, f.machineKeys.privateKey) }
}
async function discovery(f: Pick<Fixture, "machineKeys">, authority: Execution.InspectionRequest) {
  const proof = Cleanup.DiscoveryProof.parse({
    version: 1,
    purpose: "organization-environment-cleanup-discovery",
    authority,
    page: { limit: 1 },
  })
  return { proof, signature: await Cleanup.signDiscovery(proof, f.machineKeys.privateKey) }
}
async function reconciliation(
  f: Pick<Fixture, "machineKeys">,
  authority: Execution.InspectionRequest,
  candidate: Cleanup.Candidate,
) {
  const proof = Cleanup.ReconciliationProof.parse({
    version: 1,
    purpose: "organization-environment-cleanup-reconciliation",
    authority,
    action: "retire",
    candidate,
  })
  return { proof, signature: await Cleanup.signReconciliation(proof, f.machineKeys.privateKey) }
}
function post(baseUrl: string, pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

test("actual signed cleanup without native state retains exact grant hints and callback authority without granting dispatch", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const authority = await inspection(f)
  const request = await discovery(f, authority)
  const path = "/runtime/v1/environments/cleanups"
  expect(await f.run(() => Environment.hasState())).toBe(false)
  const response = await post(f.baseUrl, path, request)
  expect(response.status).toBe(200)
  expect(Cleanup.Page.parse(await response.json())).toEqual({
    version: 1,
    grantID: f.grant.grantID,
    generation: f.grant.retention.generation,
    items: [],
  })
  let escaped: Grants.NativeCleanupAuthority | undefined
  await f.run(() =>
    f.execution.withNativeCleanupDiscovery(request, undefined, async (evidence) => {
      escaped = evidence
      expect(Grants.nativeCleanupAuthority(evidence).generation).toBe(f.grant.retention.generation)
      expect(() => Grants.environmentAuthority(evidence as unknown as Grants.EnvironmentAuthority)).toThrow()
    }),
  )
  if (!escaped) throw new Error("The genuine signed cleanup callback did not run")
  const original = escaped
  await f.run(async () => {
    expect(() => Grants.nativeCleanupAuthority(original)).toThrow("ended")
    expect(() => Grants.nativeCleanupAuthority({ ...original })).toThrow("original")
  })
  const browserHeaders: Record<string, string>[] = [
    { cookie: "browser-cookie" },
    { origin: "https://organization.example" },
  ]
  for (const headers of browserHeaders) expect((await post(f.baseUrl, path, request, headers)).status).toBe(403)
  const changed = structuredClone(request)
  changed.proof.page.limit = 2
  expect((await post(f.baseUrl, path, changed)).status).toBe(403)
  const unhinted = await discovery(f, await inspection(f, { grantID: undefined, generation: undefined }))
  expect((await post(f.baseUrl, path, unhinted)).status).toBe(409)
  const future = await discovery(f, await inspection(f, { generation: f.grant.retention.generation + 1 }))
  expect((await post(f.baseUrl, path, future)).status).toBe(409)
  const candidate = Cleanup.Candidate.parse({
    kind: "admission",
    scopeID: OrganizationCloud.scopeID(f.grant.orgID, f.grant.projectID),
    environmentID: "absent-environment",
    useID: "absent-use",
    useHash: "a".repeat(64),
  })
  const absent = await post(f.baseUrl, path + "/reconciliation", await reconciliation(f, authority, candidate))
  expect(absent.status).toBe(200)
  expect(Cleanup.Result.parse(await absent.json())).toEqual({ candidate, state: "absent" })
  const foreign = await post(
    f.baseUrl,
    path + "/reconciliation",
    await reconciliation(f, authority, { ...candidate, scopeID: "another-original-Scope" }),
  )
  expect(foreign.status).toBe(403)
  expect(await f.run(() => Environment.hasState())).toBe(false)
})

test("an actual retained Environment without its selected native owner cannot appear as empty cleanup", async () => {
  await using f = await selectedEnvironmentTask()
  expect(await f.run(() => Environment.hasState())).toBe(true)
  const request = await discovery(f, await inspection(f))
  const response = await post(f.baseUrl, "/runtime/v1/environments/cleanups", request)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: "RESOURCE_UNAVAILABLE" })
  expect(await f.run(() => Environment.hasState())).toBe(true)
})
