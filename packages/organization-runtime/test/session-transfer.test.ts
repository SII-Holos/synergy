import { expect, test } from "bun:test"
import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Global } from "@ericsanchezok/synergy-harness/global"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferEpochs as Epochs,
  SessionTransferStaging as Staging,
  SessionTransferOwners as Owners,
  SessionTransferStream as Stream,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { registerSessionSchema } from "../src/session-schema"
import { OrganizationSessionAdoption as Adoption } from "../src/session-adoption"
import { createCommandIntake } from "../src/command-intake"
import { OrganizationIntakePath as Keys } from "../src/storage/path"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationCommandRecords as Records } from "../src/command-records"

test("organization transfer requires its actual reader and carries only the accepted Session's immutable command closure", async () => {
  const binding = {
    schemaVersion: 1,
    orgID: "transfer-org",
    projectID: "transfer-project",
    creatorID: "creator",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  } as const
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const identity: Command.SigningIdentity = {
    schemaVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: "deployment",
    keyID: "key",
    publicKey: await Runtime.publicKey(keys.publicKey),
  }
  const values = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      const value = values.get(hash)
      if (!value || value.length > maximum) throw new Error("Missing or oversized object")
      return value.slice()
    },
  }
  const register = () => {
    Core.register()
    registerSessionSchema(binding)
    registerOrganizationTransferOwner()
  }
  await using missingSource = await testRuntime({
    register() {
      Core.register()
      registerSessionSchema(binding)
    },
  })
  await missingSource.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: binding, workspaceID: null, environmentID: null })
        await expect(
          Source.prepare({
            binding: {
              sessionID: root.id,
              scopeID: scope.id,
              handoffID: "missing-owner",
              sourceID: "runtime-a",
              targetID: "runtime-b",
              fromEpoch: 1,
              toEpoch: 2,
            },
            store,
            signal: new AbortController().signal,
            async verify() {},
          }),
        ).rejects.toThrow("required portability owner")
      },
    })
  })
  await using source = await testRuntime({ register })
  const frozen = await source.run(async () => {
    SessionManager.closeAdmission()
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: binding, workspaceID: null, environmentID: null })
        const other = await Session.create({ organization: binding, workspaceID: null, environmentID: null })
        const intake = createCommandIntake({
          identity,
          runtimeID: binding.driverRuntimeID,
          accountID: binding.creatorID,
          connectionEpoch: 1,
          signal: new AbortController().signal,
        })
        async function delivery(
          sessionID: string,
          requestID: string,
          commandSeq: number,
          subjectID: string = binding.creatorID,
        ): Promise<Command.InputDelivery> {
          const input: Command.Input = {
            operation: "input",
            mode: "task",
            parts: [{ type: "text", text: "Original private input " + requestID }],
          }
          const permit: Command.Permit = {
            schemaVersion: 1,
            purpose: "session-command",
            orgID: binding.orgID,
            deploymentIncarnation: identity.deploymentIncarnation,
            keyID: identity.keyID,
            requestID,
            sessionID,
            projectID: binding.projectID,
            runtimeID: binding.driverRuntimeID,
            bindingEpoch: 1,
            connectionEpoch: 1,
            commandSeq,
            shareGeneration: 0,
            controlRevision: 0,
            authRevision: 1,
            admissionID: requestID,
            attemptID: requestID,
            actor: {
              kind: "account",
              orgID: binding.orgID,
              subjectID,
              displayName: "Original " + subjectID,
              clientKind: "web",
              requestID,
            },
            operation: "input",
            authorizedAt: Date.now(),
            deadline: Date.now() + 60000,
            payloadHash: "0".repeat(64),
            provisionalGrantID: "grant-" + requestID,
          }
          permit.payloadHash = await Command.digestInput(Command.inputRequest(permit, input))
          return { authorization: { permit, signature: await Command.sign(permit, keys.privateKey) }, input }
        }
        const first = await intake.input(await delivery(root.id, "original", 1))
        const skipped = await delivery(root.id, "skipped", 2)
        const skip = Command.SkipPermit.parse({
          schemaVersion: 1,
          purpose: "session-command-skip",
          command: skipped.authorization.permit,
          connectionEpoch: 1,
          authorizedAt: Date.now(),
          deadline: Date.now() + 60000,
        })
        await intake.skip({ permit: skip, signature: await Command.signSkip(skip, keys.privateKey) })
        const retry = await delivery(root.id, "original", 3)
        retry.authorization.permit.attemptID = "original-retry"
        retry.authorization.permit.admissionID = "original-retry-admission"
        retry.authorization.permit.provisionalGrantID = "unused-retry-grant"
        retry.authorization.signature = await Command.sign(retry.authorization.permit, keys.privateKey)
        expect((await intake.input(retry)).accepted).toEqual(first.accepted)
        const expired = await delivery(root.id, "expired", 4)
        expired.authorization.permit.authorizedAt = Date.now() - 1000
        expired.authorization.permit.deadline = Date.now() - 1
        expired.authorization.signature = await Command.sign(expired.authorization.permit, keys.privateKey)
        expect((await intake.input(expired)).attempt).toMatchObject({ status: "rejected", reason: "EXPIRED_PERMIT" })
        const rejectedSkip = Command.SkipPermit.parse({
          ...skip,
          command: expired.authorization.permit,
          authorizedAt: Date.now(),
          deadline: Date.now() + 60000,
        })
        await intake.skip({ permit: rejectedSkip, signature: await Command.signSkip(rejectedSkip, keys.privateKey) })
        const late = await intake.input(await delivery(root.id, "late", 2))
        expect(late.attempt).toMatchObject({ status: "rejected", reason: "SEQUENCE_CLOSED" })
        await intake.input(await delivery(other.id, "foreign", 1, "other-actor"))
        const future = await Session.create({ organization: binding, workspaceID: null, environmentID: null })
        expect((await intake.input(await delivery(future.id, "future-gap", 3))).attempt).toMatchObject({
          status: "rejected",
          reason: "SEQUENCE_GAP",
        })
        const incomplete = {
          sessionID: future.id,
          scopeID: scope.id,
          handoffID: "incomplete-native-watermark",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await expect(
          Source.prepare({ binding: incomplete, store, signal: new AbortController().signal, async verify() {} }),
        ).rejects.toThrow("closed organization Session watermark")
        expect(await Source.status(incomplete)).toBeUndefined()
        expect((await Epochs.inspect(incomplete)).phase).toBe("draining")
        const epoch = {
          sessionID: root.id,
          scopeID: scope.id,
          handoffID: "organization-transfer",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({
          binding: epoch,
          store,
          signal: new AbortController().signal,
          verify: async () => {
            await intake.barrier(root.id, 1, 4)
          },
        })
        return {
          root: await Session.get(root.id),
          epoch,
          prepared,
          first,
          late,
          requests: await Storage.readMany([
            Keys.request(binding.orgID, binding.creatorID, "original"),
            Keys.request(binding.orgID, binding.creatorID, "skipped"),
            Keys.request(binding.orgID, binding.creatorID, "expired"),
            Keys.request(binding.orgID, binding.creatorID, "late"),
          ]),
          release: await Storage.read(Keys.release(binding.orgID, binding.creatorID, "original")),
        }
      },
    })
  })
  await using oldTarget = await testRuntime({ register: Core.register })
  await oldTarget.run(async () => {
    let bodyReads = 0
    await expect(
      Staging.receive({
        handoffID: frozen.epoch.handoffID,
        root: frozen.prepared.root,
        store: {
          put: store.put,
          async get(hash, maximum) {
            bodyReads++
            return store.get(hash, maximum)
          },
        },
      }),
    ).rejects.toThrow("incompatible")
    expect(bodyReads).toBe(0)
  })
  for (const version of [1, 2]) {
    await using legacyTarget = await testRuntime({
      register() {
        Core.register()
        Owners.register("organization-runtime", {
          version,
          reads: [version],
          applies: () => false,
          async inspect() {
            return { requirements: [], children: (async function* () {})() }
          },
          async freeze() {
            throw new Error("Legacy reader must not freeze")
          },
          export() {
            throw new Error("Legacy reader must not export")
          },
          async validate() {
            throw new Error("Legacy reader must not validate continuation closure")
          },
          async publish() {
            throw new Error("Legacy reader must not publish continuation closure")
          },
        })
      },
    })
    await legacyTarget.run(async () => {
      let reads = 0
      await expect(
        Staging.receive({
          handoffID: frozen.epoch.handoffID,
          root: frozen.prepared.root,
          store: {
            put: store.put,
            async get(hash, maximum) {
              reads++
              return store.get(hash, maximum)
            },
          },
        }),
      ).rejects.toThrow("incompatible")
      expect(reads).toBe(0)
    })
  }
  await using target = await testRuntime({ register })
  await target.run(async () => {
    const original: Array<Omit<Stream.Input, "content"> & { value: unknown }> = []
    await using reader = await Stream.open({ root: frozen.prepared.root, store, directory: Global.Path.cache })
    for await (const entry of reader.entries()) {
      if (entry.kind !== "record") throw new Error("Fixture must contain native records only")
      const chunks: Uint8Array[] = []
      for await (const chunk of entry.content) chunks.push(chunk)
      original.push({
        id: entry.id,
        kind: entry.kind,
        metadata: entry.metadata,
        value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      })
    }
    expect(reader.verified()).toBe(true)
    const key = (entry: (typeof original)[number]) => z.array(z.string()).parse(entry.metadata.key)
    const cases: Array<{ name: string; change(entries: typeof original): void }> = [
      {
        name: "future-rejected-attempt-and-skip",
        change(entries) {
          const header = entries.find((entry) => key(entry)[0] === "organization-session-transfer")
          const state = entries.find(
            (entry) => key(entry).at(-1) === "state" && key(entry)[0] === "organization-command",
          )
          const slot = entries.findIndex(
            (entry) => key(entry).at(-2) === "commands" && key(entry).at(-1) === "0000000000000004",
          )
          if (!header || !state || slot < 0) throw new Error("Fixture lacks its closed third slot")
          header.value = { ...z.record(z.string(), z.unknown()).parse(header.value), commandSeq: 3 }
          state.value = { ...Records.State.parse(state.value), commandSeq: 3 }
          entries.splice(slot, 1)
        },
      },
      {
        name: "rejected-skip-with-another-attempts-slot",
        change(entries) {
          const existing = entries.find((entry) => key(entry).at(-2) === "skips" && key(entry).at(-1) === "skipped")
          if (!existing) throw new Error("Fixture lacks a native skip")
          const value = Command.SkipReceipt.parse(existing.value)
          const target = Keys.skip(binding.orgID, frozen.root.id, "late")
          entries.push({
            ...existing,
            id: JSON.stringify(target),
            metadata: { ...existing.metadata, key: target },
            value: { ...value, permit: { ...value.permit, command: frozen.late.attempt.permit } },
          })
        },
      },
      {
        name: "missing-release",
        change(entries) {
          const index = entries.findIndex((entry) => key(entry)[2] === "releases")
          if (index < 0) throw new Error("Fixture has no grant retention")
          entries.splice(index, 1)
        },
      },
      {
        name: "missing-request",
        change(entries) {
          const index = entries.findIndex((entry) => key(entry)[2] === "requests")
          if (index < 0) throw new Error("Fixture has no native request")
          entries.splice(index, 1)
        },
      },
      {
        name: "missing-command-slot",
        change(entries) {
          const index = entries.findIndex((entry) => key(entry).at(-2) === "commands")
          if (index < 0) throw new Error("Fixture has no command slot")
          entries.splice(index, 1)
        },
      },
      {
        name: "changed-release-binding",
        change(entries) {
          const entry = entries.find((entry) => key(entry)[2] === "releases")
          if (!entry) throw new Error("Fixture has no grant retention")
          entry.value = { ...Records.Release.parse(entry.value), runtimeID: "runtime-b", bindingEpoch: 2 }
        },
      },
      {
        name: "changed-release-acceptance",
        change(entries) {
          const entry = entries.find((entry) => key(entry)[2] === "releases")
          if (!entry) throw new Error("Fixture has no grant retention")
          const release = Records.Release.parse(entry.value)
          entry.value = { ...release, acceptedAt: release.acceptedAt + 1 }
        },
      },
      {
        name: "changed-accepted-attempt",
        change(entries) {
          const entry = entries.find((entry) => key(entry).at(-1) === "original" && key(entry).at(-2) === "attempts")
          if (!entry) throw new Error("Fixture has no accepted attempt")
          const attempt = Command.Attempt.parse(entry.value)
          entry.value = { ...attempt, permit: { ...attempt.permit, payloadHash: "f".repeat(64) } }
        },
      },
      {
        name: "foreign-session-release",
        change(entries) {
          const entry = entries.find((entry) => key(entry)[2] === "releases")
          if (!entry) throw new Error("Fixture has no grant retention")
          entry.value = { ...Records.Release.parse(entry.value), sessionID: "another-session" }
        },
      },
      {
        name: "foreign-owner-key",
        change(entries) {
          const entry = entries.find((entry) => entry.metadata.transferOwner === "organization-runtime")
          if (!entry) throw new Error("Fixture has no organization owner")
          entries.push({
            ...entry,
            id: "foreign-key",
            metadata: { ...entry.metadata, key: ["organization-trust", "synthetic-rule"] },
            value: { granted: true },
          })
        },
      },
    ]
    const acceptedVariants: string[] = []
    for (const variant of cases) {
      const handoffID = "invalid-" + variant.name
      const entries = structuredClone(original)
      variant.change(entries)
      const header = entries.find((entry) => key(entry)[0] === "organization-session-transfer")
      if (!header) throw new Error("Fixture has no organization transfer header")
      header.metadata.key = ["organization-session-transfer", handoffID, frozen.root.id, "header"]
      header.id = JSON.stringify(header.metadata.key)
      header.value = {
        ...z.record(z.string(), z.unknown()).parse(header.value),
        handoffID,
        records: entries.filter((entry) => entry.metadata.transferOwner === "organization-runtime").length - 1,
      }
      const root = await Stream.write({
        owners: frozen.prepared.root.owners,
        store,
        entries: (async function* () {
          for (const entry of entries)
            yield {
              ...entry,
              content: (async function* () {
                yield new TextEncoder().encode(JSON.stringify(entry.value))
              })(),
            }
        })(),
      })
      await Staging.receive({ handoffID, root, store })
      const context = await Staging.context({
        handoffID,
        ownerID: "organization-runtime",
        session: frozen.root,
        rootSessionID: frozen.root.id,
        mapping: {},
        signal: new AbortController().signal,
      })
      const accepted = await Owners.validate("organization-runtime", context).then(
        () => true,
        () => false,
      )
      if (accepted) acceptedVariants.push(variant.name)
      expect((await Storage.readMany([["sessions", binding.projectID, frozen.root.id, "info"]]))[0]).toBeUndefined()
    }
    expect(acceptedVariants).toEqual([])
    await Staging.receive({ handoffID: frozen.epoch.handoffID, root: frozen.prepared.root, store })
    await Epochs.reserve(frozen.epoch, frozen.prepared.manifestHash)
    const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
    for (const ownerID of Object.keys(frozen.prepared.root.owners).sort((a, b) =>
      a === "session-core" ? -1 : b === "session-core" ? 1 : a.localeCompare(b),
    )) {
      const context = await Staging.context({
        handoffID: frozen.epoch.handoffID,
        ownerID,
        session: frozen.root,
        rootSessionID: frozen.root.id,
        mapping: {},
        signal: new AbortController().signal,
      })
      await Owners.validate(ownerID, context)
      contexts.push({ ownerID, context })
    }
    const permit = Handoff.Permit.parse({
      schemaVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: identity.deploymentIncarnation,
      handoffID: frozen.epoch.handoffID,
      sessionID: frozen.root.id,
      sourceRuntimeID: "runtime-a",
      targetRuntimeID: "runtime-b",
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 0,
      purpose: "handoff-activation",
      permitID: "activate",
      keyID: identity.keyID,
      manifestHash: frozen.prepared.manifestHash,
      preparedHash: "a".repeat(64),
      sourceBinding: binding,
      createdAt: Date.now(),
    })
    const connection = Runtime.Connected.parse({
      type: "handshake",
      protocolVersion: 1,
      orgID: binding.orgID,
      deploymentIncarnation: identity.deploymentIncarnation,
      runtimeID: "runtime-b",
      connectionEpoch: 1,
      signingIdentity: identity,
      heartbeatMs: 1000,
      offlineMs: 10000,
    })
    await Adoption.run({ permit, signature: await Handoff.signPermit(permit, keys.privateKey) }, connection, () =>
      Epochs.activateMany({
        bindings: [frozen.epoch],
        manifestHash: permit.manifestHash,
        publish: () => Staging.publish({ handoffID: permit.handoffID, contexts }),
      }),
    )
    expect(await Storage.read(Keys.state(binding.orgID, frozen.root.id))).toMatchObject({
      runtimeID: "runtime-b",
      bindingEpoch: 2,
      commandSeq: 4,
    })
    expect(
      await Storage.readMany([
        Keys.request(binding.orgID, binding.creatorID, "original"),
        Keys.request(binding.orgID, binding.creatorID, "skipped"),
        Keys.request(binding.orgID, binding.creatorID, "expired"),
        Keys.request(binding.orgID, binding.creatorID, "late"),
      ]),
    ).toEqual(frozen.requests)
    expect(await Storage.read(Keys.release(binding.orgID, binding.creatorID, "original"))).toEqual(frozen.release)
    const observer = createCommandIntake({
      identity,
      runtimeID: "runtime-b",
      accountID: binding.creatorID,
      connectionEpoch: 1,
      signal: new AbortController().signal,
    })
    expect(await observer.releaseEntries()).toEqual([])
    expect((await Storage.readMany([Keys.request(binding.orgID, "other-actor", "foreign")]))[0]).toBeUndefined()
    expect((await SessionInbox.list(frozen.root.id)).map((item) => item.id)).toEqual(
      frozen.first.accepted ? [frozen.first.accepted.effect.itemID] : [],
    )
    expect((await Session.get(frozen.root.id)).paused).toBeDefined()
  })
}, 20000)
