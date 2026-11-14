import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffRecovery as Recovery } from "@ericsanchezok/synergy-organization-protocol"
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
    for (const version of [1, 2, 3]) {
      await Storage.write(key, { version, plan, fact })
      expect(readHandoffTargetRecord(key, await Storage.read(key))).toEqual({ version: 3, plan, fact })
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
    const native = Handoff.MachinePlan.parse({
      ...plan,
      workspacePlan: {
        mapping: {
          kind: "organization-native",
          moveID: "move",
          source: { workspaceID: "logical", generation: 1 },
          resource: { resourceID: "files", workspaceID: "service", generation: 1, path: "selected" },
          target: {
            kind: "existing",
            workspaceID: "native",
            generation: 1,
            expectedRevision: 1,
            projectRevision: "b".repeat(64),
          },
        },
        hash: "c".repeat(64),
        selectionActor: { ...plan.actor, requestID: plan.handoffID },
        targetActor: { ...plan.actor, requestID: plan.handoffID },
        targetScopeID: "service",
      },
      frozen: {
        proof: {
          ...binding,
          purpose: "source-frozen",
          manifestHash: plan.manifestHash,
          commandSeq: 0,
          receivedSeq: 0,
          compatibilityHash: "b".repeat(64),
          closureHash: "c".repeat(64),
          fileClosureHash: "d".repeat(64),
          workspaceMoveReceiptHash: null,
          workspaceSourceHash: "e".repeat(64),
          paused: true,
          drained: true,
        },
        signature: "0".repeat(128),
      },
    })
    const permit = Recovery.Permit.strip().parse({
      ...native,
      purpose: "handoff-target-cleanup",
      operation: "retire-target",
      requestHash: "1".repeat(64),
      participantKey: "2".repeat(64),
      sourceKey: "3".repeat(64),
      preparedHash: await Handoff.proofHash(fact),
      cleanup: {
        proof: {
          ...binding,
          purpose: "source-cancelled",
          manifestHash: plan.manifestHash,
          paused: true,
          gateCancelled: true,
        },
        signature: "0".repeat(128),
      },
    })
    const retired = Handoff.Proof.parse({
      ...binding,
      purpose: "target-never-activate",
      manifestHash: plan.manifestHash,
      preparedHash: permit.preparedHash,
      tombstonePersisted: true,
    })
    const retiredKey = [...key.slice(0, -1), "retired"]
    expect(readHandoffTargetRecord(retiredKey, { version: 3, plan: permit, fact: retired })).toEqual({
      version: 3,
      plan: permit,
      fact: retired,
    })
    expect(
      readHandoffTargetRecord(retiredKey, { version: 3, plan: { ...permit, preparedHash: undefined }, fact: retired })
        .fact,
    ).toEqual(retired)
    for (const changed of [
      { version: 2, plan: permit, fact: retired },
      { version: 1, plan: permit, fact: retired },
      { version: 3, plan: permit, fact },
      { version: 3, plan: { ...permit, operation: "inspect-target" }, fact: retired },
      { version: 3, plan: { ...permit, operation: "activate-target" }, fact: retired },
      {
        version: 3,
        plan: permit,
        fact: { ...retired, purpose: "target-activated", permitID: "activation", paused: true },
      },
      { version: 3, plan: permit, fact: { ...retired, preparedHash: "4".repeat(64) } },
    ])
      expect(() => readHandoffTargetRecord(retiredKey, changed)).toThrow()
  })
})
