import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

test("target Core preparation rejects a wholly omitted frozen child even when the remaining transport is complete", async () => {
  const started = performance.now()
  const mark = (phase: string) => {
    if (process.env.SYNERGY_TEST_TRANSFER_TIMING !== "1") return
    console.info("transfer-membership-timing", { phase, elapsedMs: Math.round(performance.now() - started) })
  }
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
  await using source = await testRuntime({ register: Core.register })
  mark("source-bootstrap")
  const frozen = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        const child = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        for (const session of [root, child])
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "omitted-member",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.freeze({ ...binding, sessionID: child.id, rootSessionID: root.id })
        await Epochs.freeze(binding)
        const context = {
          session: await Session.get(root.id),
          handoffID: binding.handoffID,
          rootSessionID: root.id,
          signal: new AbortController().signal,
        }
        const rootOnly = await Stream.write({
          store,
          owners: Owners.versions(["session-core"]),
          entries: Owners.entries(context, ["session-core"]),
        })
        const childContext = { ...context, session: await Session.get(child.id) }
        const complete = await Stream.write({
          store,
          owners: Owners.versions(["session-core"]),
          entries: (async function* () {
            yield* Owners.entries(context, ["session-core"])
            yield* Owners.entries(childContext, ["session-core"])
          })(),
        })
        return { binding, root: context.session, child: childContext.session, rootOnly, complete }
      },
    }),
  )
  mark("source-sealed")
  await using target = await testRuntime({ register: Core.register })
  mark("omitted-bootstrap")
  await target.run(async () => {
    const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.rootOnly, store })
    await Epochs.reserve(frozen.binding, received.rootHash)
    await expect(
      Staging.context({
        handoffID: frozen.binding.handoffID,
        ownerID: "session-core",
        session: frozen.root,
        rootSessionID: frozen.root.id,
        mapping: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("child")
    await expect(Session.get(frozen.root.id)).rejects.toThrow()
    expect((await Epochs.inspect(frozen.binding)).phase).toBe("prepared")
  })
  mark("omitted-rejected")
  await using complete = await testRuntime({ register: Core.register })
  mark("complete-bootstrap")
  await complete.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const received = await Staging.receive({ handoffID: frozen.binding.handoffID, root: frozen.complete, store })
        const child = { ...frozen.binding, sessionID: frozen.child.id, rootSessionID: frozen.root.id }
        await Epochs.reserve(frozen.binding, received.rootHash)
        await Epochs.reserve(child, received.rootHash)
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        for (const session of [frozen.root, frozen.child]) {
          const context = await Staging.context({
            ownerID: "session-core",
            handoffID: frozen.binding.handoffID,
            session,
            rootSessionID: frozen.root.id,
            mapping: {},
            signal: new AbortController().signal,
          })
          await Owners.validate("session-core", context)
          contexts.push({ ownerID: "session-core", context })
        }
        await expect(Session.get(frozen.root.id)).rejects.toThrow()
        await expect(Session.get(frozen.child.id)).rejects.toThrow()
        await Epochs.activateMany({
          bindings: [frozen.binding, child],
          manifestHash: received.rootHash,
          publish: () => Staging.publish({ handoffID: frozen.binding.handoffID, contexts }),
        })
        expect((await Session.get(frozen.root.id)).paused).toBeDefined()
        expect((await Session.get(frozen.child.id)).parentID).toBe(frozen.root.id)
        expect(
          (await Session.childPage({ parentID: frozen.root.id, includeArchived: true, limit: 1 })).items.map(
            (item) => item.id,
          ),
        ).toEqual([frozen.child.id])
      },
    }),
  )
  mark("complete-paused")
}, 15000)
