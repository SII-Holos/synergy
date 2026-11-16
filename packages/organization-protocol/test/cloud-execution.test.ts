import { expect, test } from "bun:test"
import { OrganizationCloudExecutionProtocol as Protocol } from "../src/cloud-execution"

const reference = Protocol.Reference.parse({
  version: 2,
  nativeOperationID: "native-operation",
  preparationVersion: 1,
  orgID: "organization",
  deploymentIncarnation: "incarnation",
  projectID: "project",
  runtimeID: "runtime",
  sessionID: "session",
  rootID: "root",
  bindingEpoch: 1,
  grantID: "grant",
  retentionGeneration: 1,
  selectionRevision: 1,
  resourceID: "compute",
  environmentID: "environment",
  serviceScopeID: "service-scope",
  hostOwner: "organization-environment",
  leaseID: "lease",
  target: { environmentID: "environment", allocationID: "allocation", generation: 1 },
  workspace: {
    orgID: "organization",
    projectID: "project",
    resourceID: "storage",
    workspaceID: "workspace",
    generation: 1,
    revision: 1,
  },
  mount: { id: "mount", workspaceID: "workspace", generation: 1 },
  directory: "/selected/working",
})
const origin = {
  kind: "session",
  scopeID: "project",
  sessionID: "session",
  rootID: "root",
  runID: "root",
  messageID: "assistant",
  callID: "call",
  tool: "bash",
}

test("original retirement envelopes separate admission drainage, execution facts and readonly inspections", () => {
  const admission = { kind: "admission" as const, reference, origin }
  const execution = {
    kind: "execution" as const,
    reference,
    origin,
    id: reference.nativeOperationID,
    digest: "a".repeat(64),
  }
  expect(Protocol.RetirementQuery.parse(admission)).toEqual(admission)
  expect(Protocol.RetirementQuery.parse(execution)).toEqual(execution)
  for (const extra of [{ action: "start" }, { data: "AA==" }, { permit: { execute: true } }])
    expect(Protocol.RetirementQuery.safeParse({ ...execution, ...extra }).success).toBe(false)
  expect(Protocol.RetirementQuery.safeParse({ ...admission, digest: execution.digest }).success).toBe(false)
  expect(
    Protocol.RetirementResult.safeParse({
      kind: "execution",
      reference,
      id: execution.id,
      digest: execution.digest,
      execution: null,
      output: [],
    }).success,
  ).toBe(false)
  expect(
    Protocol.RetirementResult.safeParse({ kind: "admission", reference, released: true, view: { phase: "completed" } })
      .success,
  ).toBe(false)
  expect(Protocol.InspectionQuery.safeParse(admission).success).toBe(false)
})

test("durable cloud preparation requires v2 identity and separates inspection from command facts", () => {
  expect(Protocol.Reference.safeParse({ ...reference, version: 1 }).success).toBe(false)
  expect(Protocol.Reference.safeParse({ ...reference, preparationVersion: 0 }).success).toBe(false)
  expect(Protocol.Reference.safeParse({ ...reference, fallback: "native" }).success).toBe(false)
  expect(
    Protocol.Operation.safeParse({ action: "resolve", capability: "exec", origin, workspace: reference.workspace })
      .success,
  ).toBe(false)
  expect(Protocol.Operation.safeParse({ action: "prepare-sandbox", reference, input: {} }).success).toBe(false)
  const inspection = { kind: "preparation" as const, reference, id: reference.nativeOperationID, origin }
  expect(Protocol.InspectionQuery.parse(inspection)).toEqual(inspection)
  for (const extra of [{ digest: "a".repeat(64) }, { after: 0 }, { action: "release-admission" }])
    expect(Protocol.InspectionQuery.safeParse({ ...inspection, ...extra }).success).toBe(false)
  expect(
    Protocol.InspectionResult.safeParse({
      kind: "preparation",
      reference,
      id: reference.nativeOperationID,
      preparation: null,
      execution: { state: "completed" },
      output: [],
    }).success,
  ).toBe(false)
})

test("bounded original Host metadata retains physical identity without accepting another logical operation", async () => {
  const actual = await Protocol.operationIdentity(reference, reference.nativeOperationID, origin)
  const retained = Protocol.readHostInvocation(actual.invocationID)
  expect(retained).toMatchObject({
    version: 2,
    kind: "execution",
    operationID: actual.operationID,
    reference,
    nativeOrigin: origin,
  })
  expect(await Protocol.operationIdentity(reference, reference.nativeOperationID, origin)).toEqual(actual)
  expect(
    (await Protocol.operationIdentity({ ...reference, bindingEpoch: 2 }, reference.nativeOperationID, origin))
      .operationID,
  ).not.toBe(actual.operationID)
  await expect(Protocol.operationIdentity(reference, "another-operation", origin)).rejects.toThrow(
    "original native identity",
  )
  expect(() => Protocol.readHostInvocation(" " + actual.invocationID)).toThrow("canonical")
  if (retained.kind !== "execution") throw new Error("Wrong original native metadata kind")
  expect(() => Protocol.hostInvocation({ ...retained, nativeOrigin: { oversized: "界".repeat(12000) } })).toThrow(
    "too large",
  )
  expect(Protocol.HostBinding.safeParse({ ...retained, version: 1 }).success).toBe(false)
  expect(Protocol.HostBinding.safeParse({ ...retained, observer: "another" }).success).toBe(false)
})
