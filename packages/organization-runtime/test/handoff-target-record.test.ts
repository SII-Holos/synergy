import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { readHandoffTargetRecord } from "../src/handoff-target-record"
import { registerSessionSchema } from "../src/session-schema"

const binding = {
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "deployment",
  handoffID: "handoff",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 1,
  toEpoch: 2,
  mappingPlanRevision: 1,
  shareGeneration: 0,
} as const
const plan = Handoff.MachinePlan.parse({
  ...binding,
  purpose: "handoff-machine",
  operation: "prepare-target",
  requestID: "prepare",
  keyID: "authority",
  runtimeID: "target",
  connectionEpoch: 1,
  commandSeq: 0,
  controlRevision: 1,
  authRevision: 1,
  actor: {
    kind: "account",
    orgID: "org",
    subjectID: "recipient",
    displayName: "Recipient",
    clientKind: "web",
    requestID: "prepare",
  },
  sourceBinding: {
    schemaVersion: 1,
    orgID: "org",
    projectID: "project",
    creatorID: "creator",
    driverRuntimeID: "source",
    bindingEpoch: 1,
  },
  manifestHash: "a".repeat(64),
  issuedAt: 1,
  expiresAt: 30001,
})
const fact = Handoff.Proof.parse({
  ...binding,
  purpose: "target-prepared",
  manifestHash: plan.manifestHash,
  compatibilityHash: "b".repeat(64),
  convertedHash: "c".repeat(64),
  closureHash: "d".repeat(64),
  fileClosureHash: null,
  workspaceMoveReceiptHash: null,
  paused: true,
})

test("destination receipt upgrades use the registered owner and reject unknown, cross-binding and mixed native facts", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema() })
  await runtime.run(async () => {
    const key = [
      "organization_handoff_target",
      binding.orgID,
      binding.deploymentIncarnation,
      binding.handoffID,
      "prepared",
    ]
    for (const version of [1, 2]) {
      await Storage.write(key, { version, plan, fact })
      expect(readHandoffTargetRecord(key, await Storage.read(key))).toEqual({ version: 2, plan, fact })
    }
    const before = await Storage.read<Record<string, unknown>>(key)
    for (const changed of [
      { ...before, version: 99 },
      { ...before, extra: "unknown" },
      { ...before, fact: { ...fact, handoffID: "other" } },
      { ...before, fact: { ...fact, manifestHash: "e".repeat(64) } },
      { ...before, plan: { ...plan, operation: "activate-target" } },
      { ...before, fact: { ...fact, workspaceDifferenceHash: "e".repeat(64) } },
      { version: 1, plan: { ...plan, workspacePlan: { mapping: { kind: "organization-native" } } }, fact },
    ])
      expect(() => readHandoffTargetRecord(key, changed)).toThrow()
    expect(await Storage.read(key)).toEqual(before)
  })
})
