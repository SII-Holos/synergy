import { expect, test } from "bun:test"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferStaging as Staging,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { registerSessionSchema, SessionBindingError } from "../src/session-schema"
import { OrganizationSessionAdoption as Adoption } from "../src/session-adoption"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerOrganizationTransferOwner } from "../src/session-transfer"

test("verified paused destination adoption changes only driver and epoch through canonical Core publication", async () => {
  const sourceBinding = {
    schemaVersion: 1,
    orgID: "adoption-org",
    projectID: "adoption-project",
    creatorID: "adoption-creator",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  } as const
  const register = () => {
    Core.register()
    registerSessionSchema(sourceBinding)
    registerOrganizationTransferOwner()
  }
  const values = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, max: number) {
      const value = values.get(hash)
      if (!value || value.length > max) throw new Error("Missing or oversized object")
      return value.slice()
    },
  }
  await using source = await testRuntime({ register })
  const exported = await source.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: sourceBinding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: sourceBinding, workspaceID: null, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        await Storage.write(["sessions", scope.id, root.id, "portable_fixture", "obsolete"], { value: "old" })
        await Storage.writeBinary(
          ["sessions", scope.id, root.id, "portable_fixture", "old-body"],
          new Uint8Array([1, 2, 3]),
        )
        const binding = {
          sessionID: root.id,
          scopeID: scope.id,
          handoffID: "adoption-handoff",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding,
          store,
          signal: new AbortController().signal,
          async verify() {},
        })
        return { prepared, binding, sessions: [await Session.get(root.id), await Session.get(child.id)] }
      },
    })
  })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex")
  const connection = Runtime.Connected.parse({
    type: "handshake",
    protocolVersion: 1,
    orgID: sourceBinding.orgID,
    deploymentIncarnation: "deployment",
    runtimeID: "runtime-b",
    connectionEpoch: 1,
    signingIdentity: {
      schemaVersion: 1,
      orgID: sourceBinding.orgID,
      deploymentIncarnation: "deployment",
      keyID: "key",
      publicKey,
    },
    heartbeatMs: 1000,
    offlineMs: 10000,
  })
  const permit = Handoff.Permit.parse({
    schemaVersion: 1,
    orgID: sourceBinding.orgID,
    deploymentIncarnation: "deployment",
    handoffID: exported.binding.handoffID,
    sessionID: exported.binding.sessionID,
    sourceRuntimeID: "runtime-a",
    targetRuntimeID: "runtime-b",
    fromEpoch: 1,
    toEpoch: 2,
    mappingPlanRevision: 1,
    shareGeneration: 0,
    purpose: "handoff-activation",
    permitID: "activation",
    keyID: "key",
    manifestHash: exported.prepared.manifestHash,
    preparedHash: "a".repeat(64),
    createdAt: Date.now(),
    sourceBinding,
  })
  const authorization = { permit, signature: await Handoff.signPermit(permit, keys.privateKey) }
  await using target = await testRuntime({ register })
  await target.run(async () => {
    await Staging.receive({ handoffID: permit.handoffID, root: exported.prepared.root, store })
    const bindings = exported.sessions.map((session) => ({
      ...exported.binding,
      sessionID: session.id,
      ...(session.parentID ? { rootSessionID: permit.sessionID } : {}),
    }))
    for (const binding of bindings) await Epochs.reserve(binding, permit.manifestHash)
    const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
    for (const session of exported.sessions) {
      for (const ownerID of ["session-core", "organization-runtime"]) {
        const context = await Staging.context({
          handoffID: permit.handoffID,
          ownerID,
          session,
          rootSessionID: permit.sessionID,
          mapping: {},
          signal: new AbortController().signal,
        })
        await Owners.validate(ownerID, context)
        contexts.push({ ownerID, context })
      }
    }
    const activate = () =>
      Epochs.activateMany({
        bindings,
        manifestHash: permit.manifestHash,
        publish: () => Staging.publish({ handoffID: permit.handoffID, contexts }),
      })
    await expect(activate()).rejects.toThrow("verified organization activation authority")
    for (const changed of [
      { ...permit, manifestHash: "b".repeat(64) },
      { ...permit, sourceBinding: { ...sourceBinding, creatorID: "other-creator" } },
    ]) {
      const signed = { permit: changed, signature: await Handoff.signPermit(changed, keys.privateKey) }
      await expect(Adoption.run(signed, connection, activate)).rejects.toThrow("signed source, manifest")
      await expect(Session.get(permit.sessionID)).rejects.toThrow()
      expect((await Epochs.inspect(exported.binding)).phase).toBe("prepared")
    }
    const legacy = Handoff.Permit.parse({ ...permit, sourceBinding: undefined })
    await expect(
      Adoption.run(
        { permit: legacy, signature: await Handoff.signPermit(legacy, keys.privateKey) },
        connection,
        activate,
      ),
    ).rejects.toThrow("activation permit")
    await Adoption.run(authorization, connection, () =>
      Epochs.activateMany({
        bindings,
        manifestHash: permit.manifestHash,
        publish: () => Staging.publish({ handoffID: permit.handoffID, contexts }),
      }),
    )
    for (const session of exported.sessions) {
      const current = await Session.get(session.id)
      expect(current.organization).toEqual({ ...sourceBinding, driverRuntimeID: "runtime-b", bindingEpoch: 2 })
      expect(current.paused).toBeDefined()
      await expect(
        Session.update(session.id, (draft) => {
          draft.organization = { ...sourceBinding, bindingEpoch: 100 }
        }),
      ).rejects.toBeInstanceOf(SessionBindingError)
    }
  })
  await source.run(async () => {
    for (const session of exported.sessions)
      await Epochs.surrender(
        {
          ...exported.binding,
          sessionID: session.id,
          ...(session.parentID ? { rootSessionID: permit.sessionID } : {}),
        },
        permit.preparedHash,
      )
  })
  const returned = await target.run(async () => {
    const scope = await Scope.fromID(sourceBinding.projectID)
    if (!scope) throw new Error("Target project missing")
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        await Storage.removeTree(["sessions", scope.id, permit.sessionID, "portable_fixture"])
        const binding = {
          ...exported.binding,
          handoffID: "return-handoff",
          sourceID: "runtime-b",
          targetID: "runtime-a",
          fromEpoch: 2,
          toEpoch: 3,
        }
        const prepared = await Source.prepare({
          binding,
          store,
          signal: new AbortController().signal,
          async verify() {},
        })
        return {
          binding,
          prepared,
          sessions: await Promise.all(exported.sessions.map((session) => Session.get(session.id))),
        }
      },
    })
  })
  const backPermit = Handoff.Permit.parse({
    ...permit,
    handoffID: returned.binding.handoffID,
    sourceRuntimeID: "runtime-b",
    targetRuntimeID: "runtime-a",
    fromEpoch: 2,
    toEpoch: 3,
    manifestHash: returned.prepared.manifestHash,
    sourceBinding: { ...sourceBinding, driverRuntimeID: "runtime-b", bindingEpoch: 2 },
  })
  await source.run(async () => {
    await Staging.receive({ handoffID: backPermit.handoffID, root: returned.prepared.root, store })
    const bindings = returned.sessions.map((session) => ({
      ...returned.binding,
      sessionID: session.id,
      ...(session.parentID ? { rootSessionID: permit.sessionID } : {}),
    }))
    for (const binding of bindings)
      await Epochs.reserve(binding, backPermit.manifestHash, {
        handoffID: permit.handoffID,
        fromEpoch: 1,
        manifestHash: permit.manifestHash,
      })
    const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
    for (const session of returned.sessions) {
      for (const ownerID of ["session-core", "organization-runtime"]) {
        const context = await Staging.context({
          handoffID: backPermit.handoffID,
          ownerID,
          session,
          rootSessionID: permit.sessionID,
          mapping: {},
          signal: new AbortController().signal,
        })
        await Owners.validate(ownerID, context)
        contexts.push({ ownerID, context })
      }
    }
    const authorization = { permit: backPermit, signature: await Handoff.signPermit(backPermit, keys.privateKey) }
    await Adoption.run(authorization, { ...connection, runtimeID: "runtime-a" }, () =>
      Epochs.activateMany({
        bindings,
        manifestHash: backPermit.manifestHash,
        publish: () => Staging.publish({ handoffID: backPermit.handoffID, contexts }),
      }),
    )
    for (const session of exported.sessions) {
      const current = await Session.get(session.id)
      expect(current.organization).toEqual({ ...sourceBinding, bindingEpoch: 3 })
      expect(current.paused).toBeDefined()
      expect(
        (
          await Epochs.inspect({
            ...exported.binding,
            sessionID: session.id,
            ...(session.parentID ? { rootSessionID: permit.sessionID } : {}),
          })
        ).phase,
      ).toBe("surrendered")
    }
    expect(
      (
        await Storage.readMany([
          ["sessions", sourceBinding.projectID, permit.sessionID, "portable_fixture", "obsolete"],
        ])
      )[0],
    ).toBeUndefined()
    expect(
      await Storage.artifactReferences({
        prefix: ["sessions", sourceBinding.projectID, permit.sessionID, "portable_fixture"],
        limit: 1,
      }),
    ).toEqual([])
  })
}, 20000)
