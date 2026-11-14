import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionInteraction } from "../../src/session/interaction"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"

const owner: Owners.Contribution = {
  version: 2,
  reads: [2],
  applies: () => true,
  async inspect() {
    return { requirements: [], children: (async function* () {})() }
  },
  async freeze() {},
  async *export() {},
  async validate(context) {
    for await (const record of context.staged.records())
      if (record.key[0] !== "portable-fixture") throw new Error("Unrelated record")
  },
  async publish(context) {
    await Session.create({
      id: context.session.id,
      parentID: context.session.parentID,
      interaction: context.session.interaction,
      scope: Scope.home(),
      workspace: null,
      environmentID: null,
    })
    await Session.update(context.session.id, (draft) => {
      draft.paused = context.session.paused
    })
    for await (const record of context.staged.records()) await Storage.write(record.key, record.value)
    for await (const artifact of context.staged.artifacts()) await artifact.publish(artifact.key)
    if (context.mapping.fail) throw new Error("owner publication interrupted")
  },
}

test("portable staging verifies private bytes before one paused activation and keeps unknown retries idempotent", async () => {
  await using directory = await tmpdir()
  const objects = path.join(directory.path, "objects")
  await fs.mkdir(objects)
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects, hash))
      if (file.size > maximumBytes) throw new Error("Oversized blob")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime()
  const session = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        await Storage.writeBinary(
          ["sessions", "home", session.id, "rollout", "blobs", "retained"],
          new Uint8Array([0, 255, 12]),
        )
        return Session.get(session.id)
      },
    }),
  )
  const recordKey = ["portable-fixture", session.id]
  const artifactKey = ["sessions", "home", session.id, "rollout", "blobs", "retained"]
  const root = await source.run(() =>
    Stream.write({
      store,
      owners: { fixture: 2 },
      entries: (async function* () {
        yield {
          id: "record",
          kind: "record" as const,
          metadata: { transferOwner: "fixture", transferSessionID: session.id, key: recordKey },
          content: (async function* () {
            yield Buffer.from(JSON.stringify({ completed: "keep /old-host/verbatim" }))
          })(),
        }
        yield {
          id: "artifact",
          kind: "artifact" as const,
          metadata: { transferOwner: "fixture", transferSessionID: session.id, key: artifactKey },
          content: Storage.readBinaryStream(artifactKey),
        }
      })(),
    }),
  )
  await using target = await testRuntime({
    register() {
      Owners.register("fixture", owner)
    },
  })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: "staging", root, store })
        expect(received.phase).toBe("verified")
        expect((await Staging.verify("staging")).rootHash).toBe(received.rootHash)
        expect(await Staging.receive({ handoffID: "staging", root, store })).toEqual(received)
        await expect(Session.get(session.id)).rejects.toThrow()
        await expect(Storage.read(recordKey)).rejects.toThrow()
        const context = await Staging.context({
          handoffID: "staging",
          ownerID: "fixture",
          session,
          rootSessionID: session.id,
          mapping: {},
          signal: new AbortController().signal,
        })
        await Owners.validate("fixture", context)
        await expect(
          Storage.transaction(() =>
            Staging.publish({ handoffID: "staging", contexts: [{ ownerID: "fixture", context }] }),
          ),
        ).rejects.toThrow("activation authority")
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "staging",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.reserve(binding, received.rootHash)
        const failing = await Staging.context({
          handoffID: "staging",
          ownerID: "fixture",
          session,
          rootSessionID: session.id,
          mapping: { fail: true },
          signal: new AbortController().signal,
        })
        await expect(
          Epochs.activate(binding, received.rootHash, () =>
            Staging.publish({ handoffID: "staging", contexts: [{ ownerID: "fixture", context: failing }] }),
          ),
        ).rejects.toThrow("interrupted")
        await expect(Session.get(session.id)).rejects.toThrow()
        await expect(Storage.readBinary(artifactKey)).rejects.toThrow()
        expect((await Staging.inspect("staging")).phase).toBe("verified")
        await Epochs.activate(binding, received.rootHash, () =>
          Staging.publish({ handoffID: "staging", contexts: [{ ownerID: "fixture", context }] }),
        )
        expect(await Storage.read(recordKey)).toEqual({ completed: "keep /old-host/verbatim" })
        expect(await Storage.readBinary(artifactKey)).toEqual(new Uint8Array([0, 255, 12]))
        expect((await Session.get(session.id)).paused).toEqual(session.paused)
        expect((await Staging.inspect("staging")).phase).toBe("activated")
      },
    }),
  )
})

test("staged aggregate partitions each owner's records by Session and requires every child context", async () => {
  await using directory = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized blob")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime()
  const sessions = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const child = await Session.create({
          parentID: root.id,
          workspace: null,
          interaction: SessionInteraction.unattended("machine-fixture"),
        })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        return [await Session.get(root.id), child]
      },
    }),
  )
  const manifest = await Stream.write({
    store,
    owners: { fixture: 2 },
    entries: (async function* () {
      for (const session of sessions)
        yield {
          id: session.id,
          kind: "record" as const,
          metadata: { transferOwner: "fixture", transferSessionID: session.id, key: ["portable-fixture", session.id] },
          content: (async function* () {
            yield Buffer.from(JSON.stringify({ sessionID: session.id }))
          })(),
        }
    })(),
  })
  await using target = await testRuntime({
    register() {
      Owners.register("fixture", owner)
    },
  })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: "aggregate", root: manifest, store })
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        const bindings: Epochs.Binding[] = []
        for (const session of sessions) {
          const context = await Staging.context({
            handoffID: "aggregate",
            ownerID: "fixture",
            session,
            rootSessionID: sessions[0]!.id,
            mapping: {},
            signal: new AbortController().signal,
          })
          const records = []
          for await (const record of context.staged.records()) records.push(record)
          expect(records).toEqual([{ key: ["portable-fixture", session.id], value: { sessionID: session.id } }])
          expect(await context.staged.record(["portable-fixture", session.id])).toEqual(records[0])
          const foreign = sessions.find((other) => other.id !== session.id)!
          expect(await context.staged.record(["portable-fixture", foreign.id])).toBeUndefined()
          contexts.push({ ownerID: "fixture", context })
          const binding = {
            sessionID: session.id,
            rootSessionID: session.parentID ? sessions[0]!.id : undefined,
            scopeID: "home",
            handoffID: "aggregate",
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.reserve(binding, received.rootHash)
          bindings.push(binding)
        }
        await expect(
          Epochs.activateMany({
            bindings,
            manifestHash: received.rootHash,
            publish: () => Staging.publish({ handoffID: "aggregate", contexts: contexts.slice(0, 1) }),
          }),
        ).rejects.toThrow("required Session owner")
        await expect(Session.get(sessions[0]!.id)).rejects.toThrow()
        await Epochs.activateMany({
          bindings,
          manifestHash: received.rootHash,
          publish: () => Staging.publish({ handoffID: "aggregate", contexts }),
        })
        expect((await Session.get(sessions[1]!.id)).parentID).toBe(sessions[0]!.id)
        expect((await Session.get(sessions[1]!.id)).paused).toBeUndefined()
        expect(await Epochs.isFrozen(sessions[1]!.id)).toBe(true)
      },
    }),
  )
})
