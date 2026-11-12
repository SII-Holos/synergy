import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { createHandoffs } from "../src/handoff"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { commandFixture } from "./support/commands"

test("the original Handoff owner reads fresh records and upgrades both previous readers without accepting native metadata under old versions", async () => {
  await using f = await commandFixture()
  await f.run(async () => {
    const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
    const participant = async (id: string) => {
      const record = await Record.read(Record.RuntimeRegistration, Keys.runtime(id))
      if (!record) throw new Error("Missing actual registered participant")
      const { schemaVersion: _, ...publicRuntime } = record
      return Runtime.Registration.parse(publicRuntime)
    }
    const handoffID = "retained-reader",
      key = ["organization", "handoffs", handoffID]
    const request = {
      handoffID,
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    }
    const legacy = {
      schemaVersion: 1,
      version: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID,
      sessionID: f.sessionID,
      sourceRuntimeID: "runtime-alice",
      targetRuntimeID: "runtime-bob",
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 0,
      phase: "preparing",
      initiator: "alice",
      targetAccepted: false,
      commandSeq: 0,
      source: await participant("runtime-alice"),
      target: await participant("runtime-bob"),
      request,
      cancelRequested: false,
    }
    const previous = {
      ...legacy,
      version: 2,
      request: { ...request, workspaceMapping: { kind: "native" } },
      selectionActor: null,
    }
    const current = { ...previous, version: 3 }
    for (const value of [legacy, previous, current]) {
      await Storage.write(key, value)
      expect(await handoffs.get(f.credentials.alice, handoffID)).toMatchObject({
        handoffID,
        workspaceMapping: { kind: "native" },
        cancelRequested: false,
      })
      expect(upgradeAccessRecord(key, value)).toMatchObject({
        version: 3,
        request: previous.request,
        selectionActor: null,
      })
    }
    const actor = (subjectID: string) => ({
      kind: "account",
      orgID: "org",
      subjectID,
      displayName: subjectID,
      clientKind: "web",
      requestID: handoffID,
    })
    const native = {
      ...current,
      sourceBinding: {
        schemaVersion: 1,
        orgID: "org",
        projectID: "project",
        creatorID: "alice",
        driverRuntimeID: "runtime-alice",
        bindingEpoch: 1,
      },
      sourceControlRevision: 1,
      targetAccepted: true,
      selectionActor: actor("alice"),
      targetActor: actor("bob"),
      request: {
        ...request,
        workspaceMapping: {
          kind: "organization-native",
          moveID: "native-move",
          source: { workspaceID: "logical-source", generation: 1 },
          resource: { resourceID: "files", workspaceID: "service-files", generation: 1, path: "selected" },
          target: {
            kind: "existing",
            workspaceID: "native-directory",
            generation: 1,
            expectedRevision: 1,
            projectRevision: "a".repeat(64),
          },
        },
      },
    }
    await Storage.write(key, native)
    expect(await handoffs.get(f.credentials.alice, handoffID)).toMatchObject({
      targetAccepted: true,
      workspaceDifferenceAccepted: false,
    })
    for (const value of [
      { ...current, version: 99 },
      { ...current, unknownNativeFact: true },
      { ...previous, targetActor: {} },
      { ...legacy, difference: {} },
      {
        ...current,
        differenceConsent: {
          sourceSnapshotHash: "a".repeat(64),
          targetDigest: "b".repeat(64),
          diffHash: "c".repeat(64),
          mappingPlanRevision: 1,
        },
      },
      { ...current, previewReleased: {} },
      { ...current, request: { ...request, workspaceMapping: { kind: "organization-native" } } },
      { ...native, version: 2 },
      { ...native, sourceBinding: undefined },
      { ...native, sourceControlRevision: undefined },
      { ...native, targetActor: actor("alice") },
      {
        ...native,
        differenceConsent: {
          sourceSnapshotHash: "a".repeat(64),
          targetDigest: "b".repeat(64),
          diffHash: "c".repeat(64),
          mappingPlanRevision: 1,
        },
      },
      {
        ...native,
        phase: "prepared",
        prepared: {
          signature: "a".repeat(128),
          proof: {
            schemaVersion: 1,
            orgID: native.orgID,
            deploymentIncarnation: native.deploymentIncarnation,
            handoffID,
            sessionID: native.sessionID,
            sourceRuntimeID: native.sourceRuntimeID,
            targetRuntimeID: native.targetRuntimeID,
            fromEpoch: 1,
            toEpoch: 2,
            mappingPlanRevision: 1,
            shareGeneration: 0,
            purpose: "target-prepared",
            manifestHash: "a".repeat(64),
            compatibilityHash: "b".repeat(64),
            convertedHash: "c".repeat(64),
            closureHash: "d".repeat(64),
            fileClosureHash: null,
            workspaceMoveReceiptHash: null,
            paused: true,
          },
        },
      },
    ]) {
      await Storage.write(key, value)
      await expect(handoffs.get(f.credentials.alice, handoffID)).rejects.toThrow()
    }
    await Storage.write(key, current)
    expect(await handoffs.get(f.credentials.alice, handoffID)).toMatchObject({ targetAccepted: false })
  })
})
