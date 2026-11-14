import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferCore as Core,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { registerWorkspace } from "@ericsanchezok/synergy-local-runtime/register-workspace"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationHandoffSource as Source } from "../src/handoff-source"

test("the source controller preserves its original request signal and refuses a machine identity outside its enrolled Home", async () => {
  await using directory = await tmpdir()
  const sourceBinding = {
    schemaVersion: 1 as const,
    orgID: "source-org",
    projectID: "source-project",
    creatorID: "creator",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
      Core.register()
      registerSessionSchema(sourceBinding)
      registerOrganizationTransferOwner()
    },
  })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: sourceBinding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    const sessions = await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: sourceBinding, workspaceID: null, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        return [root, child]
      },
    })
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const publicKey = await Runtime.publicKey(keys.publicKey)
    const connection = Runtime.Connected.parse({
      type: "handshake",
      protocolVersion: 1,
      orgID: sourceBinding.orgID,
      deploymentIncarnation: "deployment",
      runtimeID: "runtime-a",
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
    const plan = Handoff.MachinePlan.parse({
      schemaVersion: 1,
      orgID: sourceBinding.orgID,
      deploymentIncarnation: "deployment",
      handoffID: "real-source-controller",
      sessionID: sessions[0].id,
      sourceRuntimeID: "runtime-a",
      targetRuntimeID: "runtime-b",
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 0,
      purpose: "handoff-machine",
      operation: "prepare-source",
      sourceBinding,
      requestID: "prepare",
      keyID: "key",
      runtimeID: "runtime-a",
      connectionEpoch: 1,
      commandSeq: 0,
      controlRevision: 0,
      authRevision: 1,
      actor: {
        kind: "account",
        orgID: sourceBinding.orgID,
        subjectID: "creator",
        displayName: "Creator",
        clientKind: "web",
        requestID: "prepare",
      },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 15000,
    })
    const controller = Source.create({
      identity: { orgID: sourceBinding.orgID, accountID: sourceBinding.creatorID, deviceID: "source-device" },
      runtimeID: "runtime-a",
    })
    const signal = new AbortController().signal
    const input = {
      authorization: { plan, signature: await Handoff.signMachinePlan(plan, keys.privateKey) },
      connection,
      signal,
    }
    try {
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const original = new AbortController()
      const reason = new Error("The original source request ended")
      const verify = Handoff.verifyMachinePlan
      const delayed = spyOn(Handoff, "verifyMachinePlan").mockImplementationOnce(async (...args) => {
        entered.resolve()
        await resume.promise
        return verify(...args)
      })
      try {
        const mutable = { ...input, signal: original.signal }
        const interrupted = controller.prepare(mutable)
        void interrupted.catch(() => {})
        await entered.promise
        mutable.signal = new AbortController().signal
        original.abort(reason)
        resume.resolve()
        await expect(interrupted).rejects.toBe(reason)
        expect((await Session.get(sessions[0].id)).paused).toBeUndefined()
      } finally {
        delayed.mockRestore()
      }
      await expect(controller.prepare(input)).rejects.toThrow()
      for (const session of sessions) {
        await expect(
          Epochs.inspect({
            sessionID: session.id,
            scopeID: scope.id,
            handoffID: plan.handoffID,
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
            ...(session.parentID ? { rootSessionID: sessions[0].id } : {}),
          }),
        ).rejects.toThrow("unavailable")
        expect((await Session.get(session.id)).paused).toBeUndefined()
      }
    } finally {
      await controller.close()
    }
  })
}, 15000)
