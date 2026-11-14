import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Identifier } from "../../src/id/id"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotPortableSource as Source } from "../../src/session/snapshot-portable-source"
import { SnapshotPortableTarget as Target } from "../../src/session/snapshot-portable-target"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { SessionTransferSnapshots } from "../../src/session/transfer-snapshots"

function register() {
  Core.register()
  SessionTransferSnapshots.register()
}

test("an empty Snapshot owner prepares and adopts without requiring a historical pack", async () => {
  await using objects = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime({ register })
  const frozen = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        await SnapshotStore.initialize(await SnapshotStore.resolveRepository("home", session.id))
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "empty-snapshot",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze(binding)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        expect(await Source.capture(context)).toMatchObject({ roots: 0, packs: 0 })
        const owners = await Owners.selected(context)
        const root = await Stream.write({
          store,
          owners: Owners.versions(owners),
          entries: Owners.entries(context, owners),
        })
        return { binding, session: context.session, root }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.root, store })
        await Epochs.reserve(frozen.binding, received.rootHash)
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const ownerID of ["session-core", "session-snapshots"])
          contexts.push({
            ownerID,
            context: await Staging.context({
              ownerID,
              handoffID: frozen.binding.handoffID,
              session: frozen.session,
              rootSessionID: frozen.session.id,
              mapping: {},
              signal: new AbortController().signal,
            }),
          })
        for (const item of contexts) await Owners.validate(item.ownerID, item.context)
        expect(await SnapshotStore.owner("home", frozen.session.id)).toBeUndefined()
        await Epochs.activate(frozen.binding, received.rootHash, () =>
          Staging.publish({ handoffID: frozen.binding.handoffID, contexts }),
        )
        expect((await Session.get(frozen.session.id)).paused).toBeDefined()
        const owner = await SnapshotStore.owner("home", frozen.session.id)
        expect(owner?.backend).toBe("shared")
        expect(owner?.retentionID).not.toBe(frozen.session.id)
        expect(await Array.fromAsync(SnapshotStore.roots("home", frozen.session.id))).toEqual([])
      },
    }),
  )
}, 15000)

test("Snapshot target preparation pins private history and epoch activation atomically publishes only paused ownership", async () => {
  await using objects = await tmpdir()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(objects.path, hash), bytes)
    },
    async get(hash: string, maximumBytes: number) {
      const file = Bun.file(path.join(objects.path, hash))
      if (file.size > maximumBytes) throw new Error("Oversized object")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime({ register })
  const frozen = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const blob = await SnapshotStore.command(
          operation.repository,
          ["hash-object", "-w", "--stdin"],
          undefined,
          "complete old file",
        )
        const hash = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          "100644 blob " + blob + "\told.txt\n",
        )
        await SnapshotStore.retainMany("home", session.id, [hash])
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID: messageID,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "snapshot",
          snapshot: hash,
        })
        await Session.flushPartWrites(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "snapshot-target",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        const owners = await Owners.selected(context)
        await Owners.freeze(context, owners)
        await Epochs.freeze(binding)
        await Source.capture(context)
        const root = await Stream.write({
          store,
          owners: Owners.versions(owners),
          entries: Owners.entries(context, owners),
        })
        return { session: await Session.get(session.id), binding, root, hash }
      },
    }),
  )
  await using target = await testRuntime({ register })
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.root, store })
        await Epochs.reserve(frozen.binding, received.rootHash)
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const ownerID of ["session-core", "session-snapshots"])
          contexts.push({
            ownerID,
            context: await Staging.context({
              ownerID,
              handoffID: frozen.binding.handoffID,
              session: frozen.session,
              rootSessionID: frozen.session.id,
              mapping: {},
              signal: new AbortController().signal,
            }),
          })
        for (const entry of contexts) await Owners.validate(entry.ownerID, entry.context)
        expect(Target.prepared(contexts[1].context).digest).toHaveLength(64)
        await expect(Session.get(frozen.session.id)).rejects.toThrow()
        expect(await SnapshotStore.owns("home", frozen.session.id, frozen.hash)).toBe(false)
        const publish = () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts })
        await expect(
          Epochs.activate(frozen.binding, received.rootHash, async () => {
            await publish()
            throw new Error("activation rolled back")
          }),
        ).rejects.toThrow("activation rolled back")
        expect(await SnapshotStore.owns("home", frozen.session.id, frozen.hash)).toBe(false)
        await expect(Session.get(frozen.session.id)).rejects.toThrow()
        await Epochs.activate(frozen.binding, received.rootHash, publish)
        expect((await Session.get(frozen.session.id)).paused).toBeDefined()
        expect(await SnapshotStore.owns("home", frozen.session.id, frozen.hash)).toBe(true)
        const owner = await SnapshotStore.owner("home", frozen.session.id)
        expect(owner?.retentionID).not.toBe(frozen.session.id)
        expect(await SnapshotStore.owner("home", owner!.retentionID)).toBeUndefined()
        expect(await SnapshotStore.command(SnapshotStore.repository("home"), ["show", frozen.hash + ":old.txt"])).toBe(
          "complete old file",
        )
        await expect(Target.retire(frozen.binding)).rejects.toThrow("retirement")
      },
    }),
  )
  const omitted = await source.run(() =>
    Stream.write({
      store,
      owners: frozen.root.owners,
      entries: (async function* () {
        const context = {
          session: frozen.session,
          rootSessionID: frozen.session.id,
          handoffID: frozen.binding.handoffID,
          signal: new AbortController().signal,
        }
        for await (const entry of Owners.entries(context, Object.keys(frozen.root.owners))) {
          const key = entry.metadata.key
          if (entry.metadata.transferOwner === "session-snapshots" && Array.isArray(key)) {
            if (key.includes("roots")) continue
            if (key.at(-1) === "manifest") {
              yield {
                ...entry,
                content: (async function* () {
                  yield Buffer.from(
                    JSON.stringify({
                      version: 1,
                      scopeID: "home",
                      sessionID: frozen.session.id,
                      rootSessionID: frozen.session.id,
                      handoffID: frozen.binding.handoffID,
                      roots: 0,
                      packs: 1,
                    }),
                  )
                })(),
              }
              continue
            }
          }
          yield entry
        }
      })(),
    }),
  )
  await using missing = await testRuntime({ register })
  await missing.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: omitted, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    const context = await Staging.context({
      ownerID: "session-snapshots",
      handoffID: frozen.binding.handoffID,
      session: frozen.session,
      rootSessionID: frozen.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    await expect(Owners.validate("session-snapshots", context)).rejects.toThrow("required core root")
    expect(await SnapshotStore.owner("home", frozen.session.id)).toBeUndefined()
    expect(() => Target.prepared(context)).toThrow("prepared context")
  })
  const invalidPack = new Uint8Array([1, 2, 3])
  const corrupted = await source.run(() =>
    Stream.write({
      store,
      owners: frozen.root.owners,
      entries: (async function* () {
        const context = {
          session: frozen.session,
          rootSessionID: frozen.session.id,
          handoffID: frozen.binding.handoffID,
          signal: new AbortController().signal,
        }
        for await (const entry of Owners.entries(context, Object.keys(frozen.root.owners))) {
          const key = entry.metadata.key
          if (entry.metadata.transferOwner !== "session-snapshots" || !Array.isArray(key) || !key.includes("packs")) {
            yield entry
            continue
          }
          yield {
            ...entry,
            content: (async function* () {
              if (entry.kind === "history") yield invalidPack
              else
                yield Buffer.from(
                  JSON.stringify({
                    version: 1,
                    ordinal: 0,
                    bytes: invalidPack.length,
                    sha256: createHash("sha256").update(invalidPack).digest("hex"),
                  }),
                )
            })(),
          }
        }
      })(),
    }),
  )
  await using corrupt = await testRuntime({ register })
  await corrupt.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: corrupted, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    const context = await Staging.context({
      ownerID: "session-snapshots",
      handoffID: frozen.binding.handoffID,
      session: frozen.session,
      rootSessionID: frozen.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    await expect(Owners.validate("session-snapshots", context)).rejects.toThrow()
    expect(await SnapshotStore.owner("home", frozen.session.id)).toBeUndefined()
    expect(() => Target.prepared(context)).toThrow("prepared context")
  })
  await using cancelled = await testRuntime({
    register() {
      register()
      SnapshotStore.registerStorage(storedSnapshots())
    },
  })
  await cancelled.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.root, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    const context = await Staging.context({
      ownerID: "session-snapshots",
      handoffID: frozen.binding.handoffID,
      session: frozen.session,
      rootSessionID: frozen.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    await Owners.validate("session-snapshots", context)
    await Epochs.neverActivate(frozen.binding, received.rootHash)
    await Target.retire(frozen.binding)
    await Target.retire(frozen.binding)
    expect(await SnapshotStore.owns("home", frozen.session.id, frozen.hash)).toBe(false)
    await expect(Session.get(frozen.session.id)).rejects.toThrow()
    await expect(Owners.validate("session-snapshots", context)).rejects.toThrow("reserved handoff")
  })
  await using restartHome = await tmpdir()
  const preparing = await testRuntime({ home: restartHome.path, register })
  const packageHash = await preparing.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.root, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    const context = await Staging.context({
      ownerID: "session-snapshots",
      handoffID: frozen.binding.handoffID,
      session: frozen.session,
      rootSessionID: frozen.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    await Owners.validate("session-snapshots", context)
    return received.rootHash
  })
  await preparing.close()
  await using restarted = await testRuntime({ home: restartHome.path, register })
  await restarted.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const ownerID of ["session-core", "session-snapshots"])
          contexts.push({
            ownerID,
            context: await Staging.context({
              ownerID,
              handoffID: frozen.binding.handoffID,
              session: frozen.session,
              rootSessionID: frozen.session.id,
              mapping: {},
              signal: new AbortController().signal,
            }),
          })
        const publish = () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts })
        await expect(Epochs.activate(frozen.binding, packageHash, publish)).rejects.toThrow("prepared context")
        expect(await SnapshotStore.owner("home", frozen.session.id)).toBeUndefined()
        await expect(Session.get(frozen.session.id)).rejects.toThrow()
        for (const entry of contexts) await Owners.validate(entry.ownerID, entry.context)
        await Epochs.activate(frozen.binding, packageHash, publish)
        expect(await SnapshotStore.owns("home", frozen.session.id, frozen.hash)).toBe(true)
        expect((await Session.get(frozen.session.id)).paused).toBeDefined()
      },
    }),
  )
  await using racing = await testRuntime({ register })
  await racing.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.root, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    const context = await Staging.context({
      ownerID: "session-snapshots",
      handoffID: frozen.binding.handoffID,
      session: frozen.session,
      rootSessionID: frozen.session.id,
      mapping: {},
      signal: new AbortController().signal,
    })
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const checked = SnapshotGit.checked
    using blocked = spyOn(SnapshotGit, "checked").mockImplementation(async (repo, args, options) => {
      if (args[0] === "index-pack") {
        enter()
        await released
      }
      return checked(repo, args, options)
    })
    const preparation = Owners.validate("session-snapshots", context).then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ error }),
    )
    try {
      await entered
      await Epochs.neverActivate(frozen.binding, received.rootHash)
      const retirement = Target.retire(frozen.binding).then(
        () => ({ completed: true as const }),
        (error: unknown) => ({ error }),
      )
      release()
      expect(await preparation).toHaveProperty("error")
      expect(await retirement).toEqual({ completed: true })
      expect((await Epochs.inspect(frozen.binding)).phase).toBe("never_activate")
      expect(await SnapshotStore.owner("home", frozen.session.id)).toBeUndefined()
    } finally {
      release()
    }
  })
}, 20000)
