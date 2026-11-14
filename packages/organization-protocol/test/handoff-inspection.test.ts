import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"
import { OrganizationRuntimeProtocol as Runtime } from "../src/runtime"

test("handoff discovery metadata is bounded and excludes machine authority", () => {
  const page: Handoff.TargetPage = {
    sessionID: "session",
    sourceRuntimeID: "source",
    bindingEpoch: 1,
    controlRevision: 2,
    shareGeneration: 3,
    items: [
      {
        runtimeKind: "member",
        runtimeID: "target",
        accountID: "member",
        deviceID: "device",
        displayName: "Member",
        state: "active",
        availability: "offline",
      },
    ],
    cursor: "original_cursor",
  }
  expect(Handoff.TargetPage.parse(page)).toEqual(page)
  expect(
    Handoff.TargetPage.safeParse({ ...page, items: [{ ...page.items[0], publicKey: "private-registration" }] }).success,
  ).toBe(false)
  expect(
    Handoff.TargetPage.safeParse({ ...page, items: Array.from({ length: 101 }, () => page.items[0]) }).success,
  ).toBe(false)
  expect(Handoff.TargetsQuery.safeParse({ cursor: "x".repeat(4097) }).success).toBe(false)
  expect(Handoff.TargetsQuery.safeParse({ cursor: "not/a/cursor" }).success).toBe(false)
  expect(Handoff.NativeTargetQuery.safeParse({ requestID: "inspect", handoffID: "borrowed" }).success).toBe(false)
})

test("handoff inspection has its own finite signature and exact participant metadata", async () => {
  const plan = Handoff.InspectionPlan.parse({
    schemaVersion: 1,
    purpose: "handoff-inspection",
    requestID: "inspect",
    keyID: "key",
    orgID: "org",
    deploymentIncarnation: "deployment",
    projectID: "project",
    sessionID: "session",
    sourceRuntimeID: "source",
    targetRuntimeID: "target",
    runtimeID: "source",
    connectionEpoch: 2,
    bindingEpoch: 3,
    controlRevision: 4,
    role: "source",
    actor: {
      kind: "account",
      orgID: "org",
      subjectID: "actor",
      displayName: "Member",
      clientKind: "web",
      requestID: "inspect",
    },
    issuedAt: 100,
    expiresAt: 30100,
  })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const signature = await Handoff.signInspection(plan, keys.privateKey)
  expect(await Handoff.verifyInspection(plan, signature, publicKey)).toBe(true)
  for (const changed of [
    { ...plan, requestID: "other", actor: { ...plan.actor, requestID: "other" } },
    { ...plan, targetRuntimeID: "other" },
    { ...plan, connectionEpoch: 3 },
    { ...plan, controlRevision: 5 },
    { ...plan, bindingEpoch: 4 },
  ])
    expect(await Handoff.verifyInspection(changed, signature, publicKey)).toBe(false)
  expect(await Handoff.verifyMachinePlan(plan, signature, publicKey)).toBe(false)
  for (const changed of [
    { ...plan, runtimeID: "target" },
    { ...plan, actor: { ...plan.actor, requestID: "other" } },
    { ...plan, expiresAt: 30101 },
    { ...plan, handoffID: "not-a-migration" },
  ])
    expect(Handoff.InspectionPlan.safeParse(changed).success).toBe(false)
  const result = Handoff.InspectionResult.parse({
    requestID: plan.requestID,
    orgID: plan.orgID,
    deploymentIncarnation: plan.deploymentIncarnation,
    projectID: plan.projectID,
    sessionID: plan.sessionID,
    runtimeID: plan.runtimeID,
    connectionEpoch: plan.connectionEpoch,
    bindingEpoch: plan.bindingEpoch,
    controlRevision: plan.controlRevision,
    role: plan.role,
    workspace: {
      kind: "native",
      label: "Project directory",
      reference: { workspaceID: "workspace", generation: 1, revision: 1 },
    },
    native: null,
  })
  expect(Handoff.matchesInspection(plan, result)).toBe(true)
  for (const changed of [
    { ...result, sessionID: "other" },
    { ...result, controlRevision: 5 },
    { ...result, role: "target" as const },
  ])
    expect(Handoff.matchesInspection(plan, changed)).toBe(false)
  expect(
    Handoff.InspectionResult.safeParse({ ...result, workspace: { ...result.workspace, path: "/private/path" } })
      .success,
  ).toBe(false)
})
