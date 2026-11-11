import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferStream as Stream,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationHandoffObjects as Objects } from "../src/handoff-objects"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("escaped handoff object handles reject another Store or artifact directory in the same Runtime and a different Runtime", async () => {
  const temporary = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "handoff-object-owners-"))
  const foreignStore = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(temporary, "foreign.sqlite"),
    namespace: "foreign",
  })
  try {
    await using runtime = await testRuntime()
    await using otherRuntime = await testRuntime()
    const bytes = new TextEncoder().encode("Only the captured native Storage owner may retain these bytes")
    const foreignBytes = new TextEncoder().encode("No foreign namespace may receive escaped writes")
    const objectHash = hash(bytes)
    const objects = await runtime.run(async () => {
      const objects = await Objects.open(
        {
          orgID: "org",
          deploymentIncarnation: "deployment",
          role: "source",
          binding: {
            sessionID: "session",
            scopeID: "scope",
            handoffID: "owner-handoff",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          },
        },
        new AbortController().signal,
      )
      await objects.store.put(objectHash, bytes)
      const original = Storage.current()
      const beforeRows = await Storage.query({ prefix: ["organization_handoff_objects"], limit: 100 })
      const beforeBinaries = await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 100 })
      for (const handle of [
        { store: foreignStore, artifactDirectory: path.join(temporary, "foreign-artifacts") },
        { store: original.store, artifactDirectory: path.join(temporary, "redirected-artifacts") },
      ]) {
        await Storage.provide(handle, async () => {
          await expect(objects.store.put(hash(foreignBytes), foreignBytes)).rejects.toThrow("storage owner")
          await expect(objects.store.get(objectHash, bytes.length)).rejects.toThrow("storage owner")
          await expect(objects.inspect()).rejects.toThrow("storage owner")
          await expect(objects.contains(objectHash)).rejects.toThrow("storage owner")
          await expect(objects.sealSource()).rejects.toThrow("storage owner")
          await expect(
            objects.range({ manifestHash: objectHash, hash: objectHash, offset: 0, limit: 16 }),
          ).rejects.toThrow("storage owner")
        })
      }
      await Storage.provide(
        { store: foreignStore, artifactDirectory: path.join(temporary, "foreign-artifacts") },
        async () => {
          expect(await Storage.query({ prefix: ["organization_handoff_objects"], limit: 1 })).toEqual([])
          expect(await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 1 })).toEqual([])
        },
      )
      expect(await Storage.query({ prefix: ["organization_handoff_objects"], limit: 100 })).toEqual(beforeRows)
      expect(await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 100 })).toEqual(
        beforeBinaries,
      )
      expect(await objects.store.get(objectHash, bytes.length)).toEqual(bytes)
      return objects
    })
    await otherRuntime.run(async () => {
      await expect(objects.store.put(hash(foreignBytes), foreignBytes)).rejects.toThrow("another native Runtime")
      await expect(objects.inspect()).rejects.toThrow("another native Runtime")
      await expect(objects.contains(objectHash)).rejects.toThrow("another native Runtime")
      expect(await Storage.query({ prefix: ["organization_handoff_objects"], limit: 1 })).toEqual([])
      expect(await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 1 })).toEqual([])
    })
  } finally {
    await foreignStore.close()
    await fs.rm(temporary, { recursive: true, force: true })
  }
}, 15000)

test("handoff objects expose only the exact frozen package closure and retain scope across native reopening", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const binding = {
          sessionID: session.id,
          scopeID: session.scope.id,
          handoffID: "object-handoff",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const identity = { orgID: "org", deploymentIncarnation: "deployment", role: "source" as const, binding }
        const signal = new AbortController().signal
        const objects = await Objects.open(identity, signal)
        const unrelated = new TextEncoder().encode("Failed preparation's private, unreachable bytes")
        await objects.store.put(hash(unrelated), unrelated)
        await expect(
          objects.range({ manifestHash: hash(unrelated), hash: hash(unrelated), offset: 0, limit: 128 }),
        ).rejects.toThrow("sealed")
        await expect(objects.store.put("0".repeat(64), unrelated)).rejects.toThrow("checksum")
        await expect(
          objects.store.put(hash(new Uint8Array(Stream.chunkBytes + 1)), new Uint8Array(Stream.chunkBytes + 1)),
        ).rejects.toThrow("frame")
        const prepared = await Source.prepare({ binding, store: objects.store, signal, async verify() {} })
        const sealed = await objects.sealSource()
        expect(sealed.manifestHash).toBe(prepared.manifestHash)
        expect(sealed.objects).toBeGreaterThan(1)
        const reopened = await Objects.open(identity, signal)
        const first = await reopened.range({
          manifestHash: prepared.manifestHash,
          hash: prepared.manifestHash,
          offset: 0,
          limit: 19,
        })
        expect(first.nextOffset).toBe(19)
        expect(first.complete).toBe(false)
        const rest = await reopened.range({
          manifestHash: prepared.manifestHash,
          hash: prepared.manifestHash,
          offset: 19,
          limit: 128 * 1024,
        })
        const rootBytes = Buffer.concat([Buffer.from(first.data, "base64url"), Buffer.from(rest.data, "base64url")])
        expect(JSON.parse(rootBytes.toString())).toEqual(prepared.root)
        expect(hash(rootBytes)).toBe(prepared.manifestHash)
        expect(rest.complete).toBe(true)
        await expect(
          reopened.range({ manifestHash: prepared.manifestHash, hash: hash(unrelated), offset: 0, limit: 128 }),
        ).rejects.toThrow("closure")
        await expect(
          Objects.open({ ...identity, binding: { ...binding, sessionID: "other-session" } }, signal),
        ).rejects.toThrow("binding")
        const foreign = await Objects.open({ ...identity, deploymentIncarnation: "restored-deployment" }, signal)
        await expect(
          foreign.range({ manifestHash: prepared.manifestHash, hash: prepared.manifestHash, offset: 0, limit: 128 }),
        ).rejects.toThrow("sealed")
        const allowed = await reopened.inspect()
        expect(allowed).toEqual(sealed)
        const references = await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 100 })
        const rootReference = references.find((entry) => entry.key.at(-1) === prepared.manifestHash)
        if (!rootReference) throw new Error("Expected retained package root")
        await Storage.writeBinary(rootReference.key, new Uint8Array([0]))
        await expect(
          reopened.range({ manifestHash: prepared.manifestHash, hash: prepared.manifestHash, offset: 0, limit: 128 }),
        ).rejects.toThrow("checksum")
      },
    }),
  )
}, 15000)

test("sealed handoff bytes survive a native restart but cancellation and aborted readers retain their fences", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "handoff-objects-restart-"))
  try {
    const source = await testRuntime({ home, register: Core.register })
    const captured = await source.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspaceID: null, environmentID: null })
          const identity: Objects.Identity = {
            orgID: "org",
            deploymentIncarnation: "restart-deployment",
            role: "source",
            binding: {
              sessionID: session.id,
              scopeID: session.scope.id,
              handoffID: "restart-handoff",
              sourceID: "runtime-a",
              targetID: "runtime-b",
              fromEpoch: 1,
              toEpoch: 2,
            },
          }
          const objects = await Objects.open(identity, new AbortController().signal)
          const prepared = await Source.prepare({
            binding: identity.binding,
            store: objects.store,
            signal: new AbortController().signal,
            async verify() {},
          })
          await objects.sealSource()
          return { identity, manifestHash: prepared.manifestHash }
        },
      }),
    )
    await source.close()
    await using reopened = await testRuntime({ home, register: Core.register })
    await reopened.run(async () => {
      const controller = new AbortController()
      const objects = await Objects.open(captured.identity, controller.signal)
      const range = { manifestHash: captured.manifestHash, hash: captured.manifestHash, offset: 0, limit: 128 * 1024 }
      expect((await objects.range(range)).complete).toBe(true)
      const reason = new Error("Connection replaced before returning object bytes")
      controller.abort(reason)
      await expect(objects.range(range)).rejects.toBe(reason)
      const active = await Objects.open(captured.identity, new AbortController().signal)
      await Epochs.cancel(captured.identity.binding)
      await expect(active.range(range)).rejects.toThrow("not sealed")
      expect((await Session.get(captured.identity.binding.sessionID)).paused).toBeTruthy()
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}, 15000)
