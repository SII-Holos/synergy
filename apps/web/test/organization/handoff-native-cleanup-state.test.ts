import { expect, test } from "bun:test"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import {
  organizationNativeCleanupHandle,
  organizationNativeCleanupResult,
} from "../../src/organization/handoff-native-cleanup-state"
import { createOrganizationHandoffState } from "../../src/organization/handoff-state"

const binding = Handoff.Binding.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "handoff",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 2,
})
const runtime = Runtime.MemberRegistrationRecord.parse({
  runtimeID: "target",
  orgID: "org",
  deploymentIncarnation: "inc",
  runtimeKind: "member",
  accountID: "account",
  deviceID: "destination-computer",
  publicKey: "a".repeat(64),
  state: "active",
  revision: 1,
  connectionEpoch: 1,
  createdAt: 0,
})
const view = Handoff.View.parse({
  ...binding,
  phase: "cancelled",
  targetAccepted: true,
  cancelRequested: true,
  manifestHash: "b".repeat(64),
  commandSeq: 1,
  missingRequirements: [],
  canCancel: false,
  canAccept: false,
  canContinue: false,
  currentDriver: "source",
  bindingEpoch: 7,
  initiator: "account",
  mappingHash: "c".repeat(64),
  workspaceMapping: {
    kind: "organization-native",
    moveID: "move",
    source: { workspaceID: "cloud", generation: 1 },
    resource: { resourceID: "storage", workspaceID: "cloud", generation: 1, path: "project" },
    target: {
      kind: "existing",
      workspaceID: "native",
      generation: 1,
      expectedRevision: 1,
      projectRevision: "d".repeat(64),
    },
  },
})
const handle = organizationNativeCleanupHandle(view, runtime)!
const pending = {
  handoffID: "handoff",
  requestID: "inspection",
  runtimeID: "target",
  operation: "inspect-target",
  state: "idle",
  stage: "idle",
  revision: "e".repeat(64),
  requirements: [],
  facts: [],
}
const fact = {
  proof: {
    ...binding,
    purpose: "target-preview-released",
    manifestHash: "b".repeat(64),
    diffHash: null,
    tombstonePersisted: true,
  },
  signature: "f".repeat(128),
}

test("a cancelled source does not establish target cleanup without its original target fact", () => {
  expect(organizationNativeCleanupResult(handle, "inspection", pending).complete).toBe(false)
  expect(() =>
    organizationNativeCleanupResult(handle, "inspection", {
      ...pending,
      state: "complete",
      stage: "target-preview-released",
    }),
  ).toThrow("fact")
  expect(
    organizationNativeCleanupResult(handle, "inspection", {
      ...pending,
      state: "complete",
      stage: "target-preview-released",
      facts: [fact],
    }).complete,
  ).toBe(true)
})

test("limited cleanup rejects another binding and any returned private comparison", () => {
  expect(() =>
    organizationNativeCleanupResult(handle, "inspection", {
      ...pending,
      state: "complete",
      stage: "target-preview-released",
      facts: [{ ...fact, proof: { ...fact.proof, toEpoch: 9 } }],
    }),
  ).toThrow("binding")
  expect(() =>
    organizationNativeCleanupResult(handle, "inspection", {
      ...pending,
      differencePage: { diffHash: "a".repeat(64), items: [] },
    }),
  ).toThrow("content")
  expect(() => organizationNativeCleanupResult(handle, "another-request", pending)).toThrow("operation")
  expect(organizationNativeCleanupHandle({ ...view, workspaceMapping: { kind: "native" } }, runtime)).toBeUndefined()
})

test("a retained cleanup handle keeps the unknown preview through reload without persisting signed facts", () => {
  const values = new Map<string, string>()
  const input = {
    owner: '["organization","org","account","inc"]',
    projectID: "project",
    sessionID: "session",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  }
  const owner = createOrganizationHandoffState(input)
  const original = {
    kind: "drive" as const,
    body: { operation: "preview-target" as const, requestID: "original-preview" },
  }
  owner.save("handoff", original)
  owner.rememberCleanup(handle)
  const reloaded = createOrganizationHandoffState(input)
  expect(reloaded.read()?.pending).toEqual(original)
  expect(reloaded.read()?.nativeCleanup).toEqual(handle)
  expect([...values.values()].join()).not.toContain("signature")
  expect(() => reloaded.rememberCleanup({ ...handle, runtime: { ...runtime, publicKey: "e".repeat(64) } })).toThrow(
    "destination",
  )
  expect(
    createOrganizationHandoffState({ ...input, owner: '["organization","org","account","new-inc"]' }).read(),
  ).toBeUndefined()
})
