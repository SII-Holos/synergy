import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferStaging as Staging } from "../../src/session/transfer-staging"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

const empty: Owners.Contribution = {
  version: 1,
  reads: [1],
  applies: () => true,
  async inspect() {
    return {
      requirements: [],
      children: (async function* () {
        yield* []
      })(),
    }
  },
  async freeze() {},
  async *export() {
    yield* []
  },
  async validate() {},
  async publish() {},
}

test.each(["cycle", "omitted", "uninstalled"] as const)(
  "native staging rejects a %s publication dependency before receiving records",
  async (kind) => {
    await using runtime = await testRuntime({
      register() {
        Owners.register("first", { ...empty, publicationBefore: [kind === "uninstalled" ? "unknown" : "second"] })
        if (kind !== "uninstalled")
          Owners.register("second", { ...empty, publicationBefore: kind === "cycle" ? ["first"] : [] })
      },
    })
    await runtime.run(async () => {
      const root = Stream.Root.parse({
        format: "synergy-portable-session",
        version: 2,
        complete: true,
        entries: 0,
        bytes: 0,
        pages: 0,
        head: null,
        owners: kind === "cycle" ? { first: 1, second: 1 } : { first: 1 },
      })
      let reads = 0
      await expect(
        Staging.receive({
          handoffID: "invalid-order",
          root,
          store: {
            async put() {
              throw new Error("No object writes expected")
            },
            async get() {
              reads++
              throw new Error("No object reads expected")
            },
          },
        }),
      ).rejects.toThrow("publication")
      expect(reads).toBe(0)
      expect(await Storage.readMany([["session_transfer_staging", "invalid-order", "state"]])).toEqual([undefined])
    })
  },
)

test("native Workspace catalogs publish before Core while each owner's aggregate members retain parent order", async () => {
  await using directory = await tmpdir()
  const signal = new AbortController().signal
  const events: string[] = []
  let armed = false
  let mutatePublication: (() => void) | undefined
  const before = ["session-core"]
  const register = () => {
    Core.register()
    Owners.register("a-observer", {
      ...empty,
      stagedDependencies: ["session-core"],
      async *export(context) {
        yield {
          id: "observer-" + context.session.id,
          kind: "record",
          metadata: { key: ["observer-proof", context.session.id] },
          content: (async function* () {
            yield Buffer.from(JSON.stringify({ sessionID: context.session.id }))
          })(),
        }
      },
      async publish(context) {
        await Session.get(context.session.id)
        events.push("observer:" + context.session.id)
      },
    })
    Owners.register("session-workspaces", {
      ...empty,
      publicationBefore: before,
      stagedDependencies: ["session-core"],
      async *export(context) {
        const workspace = await WorkspaceCatalog.get(context.session.workspaceID!, context.session.scope.id)
        yield {
          id: context.session.id,
          kind: "record",
          metadata: { key: ["portable_catalog", context.session.id] },
          content: (async function* () {
            yield Buffer.from(JSON.stringify(workspace))
          })(),
        }
      },
      async validate(context) {
        for await (const record of context.staged.records()) {
          const catalog = WorkspaceCatalog.Info.parse(record.value)
          if (catalog.id !== context.session.workspaceID) throw new Error("Another Workspace")
        }
        const info = await context.staged.relatedRecord!("session-core", [
          "sessions",
          context.session.scope.id,
          context.session.id,
          "info",
        ])
        if (!info) throw new Error("Missing canonical member")
      },
      async publish(context) {
        for await (const record of context.staged.records())
          await WorkspaceCatalog.importRecord(WorkspaceCatalog.Info.parse(record.value))
        events.push("workspace:" + context.session.id)
        if (!context.session.parentID) mutatePublication?.()
      },
    })
    StorageMutationGuard.register("publication-observer", async (_tx, keys) => {
      if (armed)
        for (const key of keys)
          if (key[0] === "sessions" && key.length === 4 && key[3] === "info") events.push("core:" + key[2])
    })
  }
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory.path, hash), bytes)
    },
    async get(hash: string, maximum: number) {
      const file = Bun.file(path.join(directory.path, hash))
      if (file.size > maximum) throw new Error("Oversized frame")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  await using source = await testRuntime({ register })
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "fixture", spec: {} } })
        const root = await Session.create({ workspaceID: workspace.id, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: workspace.id, environmentID: null })
        const binding = {
          sessionID: root.id,
          scopeID: "home",
          handoffID: "catalog-before-core",
          sourceID: "A",
          targetID: "B",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const prepared = await Source.prepare({ binding, signal, store, async verify() {} })
        return { root, child, workspace, binding, prepared }
      },
    }),
  )
  await using target = await testRuntime({ register })
  before.push("not-selected-after-registration")
  await target.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Staging.receive({ handoffID: captured.binding.handoffID, root: captured.prepared.root, store, signal })
        const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
        const bindings: Epochs.Binding[] = []
        for await (const member of Staging.members({
          handoffID: captured.binding.handoffID,
          rootSessionID: captured.root.id,
          scopeID: "home",
          signal,
        })) {
          bindings.push({
            ...captured.binding,
            sessionID: member.session.id,
            ...(member.session.id === captured.root.id ? {} : { rootSessionID: captured.root.id }),
          })
          for (const ownerID of ["session-core", "session-workspaces", "a-observer"]) {
            const context = await Staging.context({
              handoffID: captured.binding.handoffID,
              rootSessionID: captured.root.id,
              session: member.session,
              ownerID,
              signal,
              mapping: { workspaceIDs: { [captured.workspace.id]: captured.workspace.id }, environmentID: null },
            })
            await Owners.validate(ownerID, context)
            contexts.push({ ownerID, context })
          }
        }
        await expect(WorkspaceCatalog.get(captured.workspace.id, "home")).rejects.toThrow()
        await expect(Session.get(captured.root.id)).rejects.toThrow()
        for (const binding of bindings) await Epochs.reserve(binding, captured.prepared.manifestHash)
        mutatePublication = () => contexts.reverse()
        armed = true
        await Epochs.activateMany({
          bindings,
          manifestHash: captured.prepared.manifestHash,
          publish: () => Staging.publish({ handoffID: captured.binding.handoffID, contexts }),
        })
        expect(events).toEqual([
          "workspace:" + captured.root.id,
          "workspace:" + captured.child.id,
          "core:" + captured.root.id,
          "core:" + captured.child.id,
          "observer:" + captured.root.id,
          "observer:" + captured.child.id,
        ])
        for (const sessionID of [captured.root.id, captured.child.id]) {
          expect(await Session.get(sessionID)).toMatchObject({
            workspaceID: captured.workspace.id,
            paused: expect.anything(),
          })
        }
        expect((await WorkspaceCatalog.get(captured.workspace.id, "home")).lifecycle).toBe("active")
      },
    }),
  )
}, 15000)
