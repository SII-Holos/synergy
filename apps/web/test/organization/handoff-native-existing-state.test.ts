import { expect, test } from "bun:test"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { organizationNativeHandoffMapping } from "../../src/organization/handoff-native-state"
import {
  organizationDirectoryFromOptions,
  organizationDirectoryFromInspection,
  organizationDirectoryLabel,
} from "../../src/organization/handoff-directory-state"
import {
  organizationNativeCleanupHandle,
  organizationNativeCleanupResult,
} from "../../src/organization/handoff-native-cleanup-state"
import {
  organizationHandoffEnvironmentDefault,
  organizationHandoffEnvironmentMapping,
} from "../../src/organization/handoff-environment-state"

import {
  createOrganizationHandoffState,
  organizationHandoffOutcomeKnown,
  OrganizationHandoffAction,
} from "../../src/organization/handoff-state"

const descriptor = Handoff.NativeEnvironmentDescriptor.parse({
  version: 1,
  kind: "native",
  platform: "linux",
  architecture: "x64",
  capabilities: ["exec", "files"],
})
const options = Handoff.Options.parse({
  sessionID: "session",
  projectID: "project",
  bindingEpoch: 7,
  controlRevision: 11,
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  source: {
    kind: "native",
    label: "Original source folder",
    reference: { workspaceID: "source-directory", generation: 3, revision: 4 },
  },
  native: {
    label: "Consented destination folder",
    reference: {
      workspaceID: "destination-directory",
      generation: 2,
      revision: 5,
    },
    projectRevision: "a".repeat(64),
  },
  environment: {
    expectedSelectionRevision: 0,
    source: {
      kind: "native",
      environmentID: "source-environment",
      provider: "native",
      generation: 0,
      descriptor,
    },
    native: { kind: "native", provider: "native", descriptor, reference: null },
    choices: ["native", "none"],
  },
  choices: [
    { kind: "native", requiresDifference: false },
    { kind: "native-existing", requiresDifference: true },
  ],
})
const mapping = Handoff.WorkspaceMapping.parse({
  kind: "native-existing",
  moveID: "original-move",
  source: { workspaceID: "source-directory", generation: 3 },
  target: {
    kind: "existing",
    workspaceID: "destination-directory",
    generation: 2,
    expectedRevision: 5,
    projectRevision: "a".repeat(64),
  },
})
const plan = Handoff.CurrentPrepare.parse({
  handoffID: "handoff",
  targetRuntimeID: "target",
  expectedBindingEpoch: 7,
  expectedControlRevision: 11,
  mappingPlanRevision: 1,
  workspaceMapping: mapping,
})
const view = Handoff.View.parse({
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
  shareGeneration: 0,
  phase: "preparing",
  initiator: "account",
  targetAccepted: true,
  cancelRequested: false,
  commandSeq: 1,
  missingRequirements: [],
  canAccept: true,
  canCancel: true,
  canContinue: false,
  currentDriver: "source",
  bindingEpoch: 7,
  workspaceMapping: mapping,
  mappingHash: "b".repeat(64),
})

test("a native source selects an exact existing directory independently of command Environment", () => {
  expect(organizationNativeHandoffMapping(options, "original-move", "existing")).toEqual(mapping)
  expect(Object.keys(mapping).sort()).toEqual(["kind", "moveID", "source", "target"])
  expect(organizationNativeHandoffMapping({ ...options, native: null }, "move")).toBeUndefined()
  expect(
    organizationNativeHandoffMapping({ ...options, choices: [{ kind: "native", requiresDifference: false }] }, "move"),
  ).toBeUndefined()
  expect(organizationNativeHandoffMapping(options, "move", "private-copy")).toBeUndefined()
  const template = options.environment
  if (!template?.native || !template.source) throw new Error("The fixture requires an actual native Environment")
  const environment = organizationHandoffEnvironmentDefault(options)
  if (!environment || environment.kind !== "native") throw new Error("The fixture requires an actual native template")
  expect(environment).toEqual(template.native)
  expect(organizationHandoffEnvironmentMapping(options, mapping, environment)).toEqual({
    version: 1,
    expectedSelectionRevision: 0,
    source: template.source,
    target: template.native,
  })
  expect(organizationHandoffEnvironmentMapping(options, mapping, { kind: "none" })?.target).toEqual({ kind: "none" })
  expect(
    organizationHandoffEnvironmentMapping(options, mapping, {
      ...environment,
      reference: { environmentID: "another", generation: 1 },
    }),
  ).toBeUndefined()
})

test("native existing directory reload and cancellation retain original owner evidence", () => {
  const caption = organizationDirectoryFromOptions({
    plan,
    options,
    sessionID: "session",
    projectID: "project",
  })
  expect(caption).toEqual({ plan, label: "Consented destination folder" })
  expect(organizationDirectoryLabel(caption, view)).toBe("Consented destination folder")
  const inspection = Handoff.NativeTargetSelection.parse({
    requestID: "cold-inspection",
    handoffID: view.handoffID,
    targetRuntimeID: view.targetRuntimeID,
    mappingPlanRevision: view.mappingPlanRevision,
    mappingHash: view.mappingHash,
    native: options.native,
  })
  expect(organizationDirectoryFromInspection(view, inspection.requestID, inspection)).toEqual(inspection)
  expect(organizationDirectoryLabel(undefined, view, inspection)).toBe("Consented destination folder")
  for (const changed of [
    { mappingHash: "c".repeat(64) },
    { mappingPlanRevision: 2 },
    {
      native: {
        ...inspection.native,
        reference: { ...inspection.native.reference, generation: 3 },
      },
    },
    {
      native: {
        ...inspection.native,
        reference: { ...inspection.native.reference, revision: 6 },
      },
    },
    { native: { ...inspection.native, projectRevision: "c".repeat(64) } },
  ])
    expect(() =>
      organizationDirectoryFromInspection(view, inspection.requestID, {
        ...inspection,
        ...changed,
      }),
    ).toThrow("selection")
  const runtime = Runtime.MemberRegistrationRecord.parse({
    runtimeID: "target",
    orgID: "org",
    deploymentIncarnation: "inc",
    runtimeKind: "member",
    accountID: "account",
    deviceID: "destination-device",
    publicKey: "a".repeat(64),
    state: "active",
    revision: 1,
    connectionEpoch: 1,
    createdAt: 0,
  })
  const cancelled = Handoff.View.parse({
    ...view,
    phase: "cancelled",
    cancelRequested: true,
    manifestHash: "d".repeat(64),
    canCancel: false,
    canAccept: false,
  })
  const values = new Map<string, string>()
  const retainedInput = {
    owner: '["organization","org","account","inc"]',
    projectID: "project",
    sessionID: "session",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  }
  const owner = createOrganizationHandoffState(retainedInput)
  owner.save(plan.handoffID, { kind: "prepare", body: plan }, caption)
  owner.confirmed(plan.handoffID)
  const original = OrganizationHandoffAction.parse({
    kind: "drive",
    body: { operation: "preview-target", requestID: "original-preview" },
  })
  owner.save(plan.handoffID, original)
  expect(organizationHandoffOutcomeKnown(original, cancelled)).toBe(false)
  const reloaded = createOrganizationHandoffState(retainedInput)
  expect(reloaded.read()?.nativeDirectory).toEqual(caption)
  expect(reloaded.read()?.pending).toEqual(original)
  const handle = organizationNativeCleanupHandle(cancelled, runtime)
  expect(handle).toBeDefined()
  if (!handle) throw new Error("The cancelled native-existing move lost its exact cleanup handle")
  reloaded.rememberCleanup(handle)
  expect(createOrganizationHandoffState(retainedInput).read()?.pending).toEqual(original)
  expect(createOrganizationHandoffState(retainedInput).read()?.nativeCleanup).toEqual(handle)
  expect([...values.values()].join()).not.toContain("signature")
  const pending = {
    handoffID: view.handoffID,
    requestID: "cleanup",
    runtimeID: runtime.runtimeID,
    operation: "inspect-target",
    state: "blocked",
    stage: "preparing",
    revision: "e".repeat(64),
    requirements: [],
    facts: [],
  }
  expect(organizationNativeCleanupResult(handle, "cleanup", pending).complete).toBe(false)
  const released = {
    ...pending,
    state: "complete",
    stage: "target-preview-released",
    facts: [
      {
        proof: {
          ...Handoff.Binding.strip().parse(view),
          purpose: "target-preview-released",
          manifestHash: handle.manifestHash,
          diffHash: null,
          tombstonePersisted: true,
        },
        signature: "f".repeat(128),
      },
    ],
  }
  expect(organizationNativeCleanupResult(handle, "cleanup", released).complete).toBe(true)
  expect(() => organizationNativeCleanupResult(handle, "another-inspection", released)).toThrow("operation")
  expect(() =>
    organizationNativeCleanupResult(handle, "cleanup", {
      ...released,
      differencePage: { diffHash: "a".repeat(64), items: [] },
    }),
  ).toThrow("content")
})
