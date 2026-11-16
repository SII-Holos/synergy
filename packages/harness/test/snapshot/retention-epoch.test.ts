import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StoredSnapshotContent as Content } from "../../src/session/stored-snapshot-content"
import { runMigrations } from "../../src/migration"

for (const phase of ["frozen", "surrendered"] as const)
  test(`a live logical Snapshot owner can retain new history behind a ${phase} execution identity`, async () => {
    await using runtime = await testRuntime({
      register() {
        SnapshotStore.registerStorage(storedSnapshots())
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const original = await Session.create({ workspace: null })
          const alias = await Session.create({ workspace: null })
          const operation = await SnapshotStore.resolveRepository("home", original.id)
          await SnapshotStore.initialize(operation)
          const tree = async (text: string) => {
            const blob = await SnapshotStore.command(
              operation.repository,
              ["hash-object", "-w", "--stdin"],
              undefined,
              text,
            )
            return SnapshotStore.command(operation.repository, ["mktree"], undefined, `100644 blob ${blob}\tfile.txt\n`)
          }
          const first = await tree("Immutable source history")
          await SnapshotStore.retainMany("home", original.id, [first])
          const current = Content.Header.parse(await Content.read("home", original.id, first))
          const references = await Array.fromAsync(
            Content.references({ scopeID: "home", retentionID: original.id, manifest: current }),
          )
          const legacy = {
            version: 1 as const,
            root: first,
            packs: [{ chunks: references.map(({ sha256, bytes }) => ({ sha256, bytes })) }],
          }
          await Storage.transaction(async (tx) => {
            for (const ref of references) {
              const location = await tx.artifact(ref.key)
              if (!location) throw new Error("Historical fixture chunk is missing")
              await tx.writeArtifacts([
                { key: [...Content.legacyKey("home", original.id, first), "packs", "0", String(ref.index)], location },
              ])
            }
            await Storage.write([...Content.legacyKey("home", original.id, first), "manifest"], legacy)
            await Storage.removeTree(Content.key("home", original.id, first))
            await Storage.remove(Content.legacyFenceKey("home", original.id, first))
          })
          await Storage.write(StoragePath.snapshotOwner("home", alias.id), {
            version: 3,
            backend: "shared",
            retentionID: original.id,
          })
          await SessionLifecycle.pause({ sessionID: original.id, reason: "interrupted" })
          const binding = {
            sessionID: original.id,
            scopeID: "home",
            handoffID: "original-owner",
            sourceID: "source",
            targetID: "target",
            fromEpoch: 1,
            toEpoch: 2,
          }
          await Epochs.freeze(binding)
          if (phase === "surrendered") {
            await Epochs.seal(binding, "a".repeat(64))
            await Epochs.surrender(binding, "b".repeat(64))
          }
          const source = await Session.get(original.id)
          await runMigrations({ targetDomain: "stored-snapshot-content", maintenance: true, output: "silent" })
          expect((await Content.read("home", original.id, first))?.version).toBe(2)
          expect(await Storage.read([...Content.legacyKey("home", original.id, first), "manifest"])).toEqual(legacy)
          const added = await tree("New alias history")
          await SnapshotStore.retainMany("home", alias.id, [added])
          expect(await SnapshotStore.owns("home", alias.id, added)).toBeTrue()
          expect(await SnapshotStore.owns("home", alias.id, first)).toBeTrue()
          expect((await Epochs.inspect(binding)).phase).toBe(phase)
          expect(await Session.get(original.id)).toEqual(source)
          const forbidden = await tree("The frozen logical source cannot publish this")
          await expect(SnapshotStore.retainMany("home", original.id, [forbidden])).rejects.toThrow("transfer")
          expect(await Content.read("home", original.id, forbidden)).toBeUndefined()
          await expect(SnapshotStore.releaseContent("home", original.id, alias.id)).rejects.toThrow("transfer")
          await expect(
            Session.update(original.id, (draft) => {
              draft.title = "forbidden"
            }),
          ).rejects.toThrow("transfer")
          await Storage.removeTree(Content.key("home", original.id, first))
          expect(await Content.read("home", original.id, first)).toBeUndefined()
          expect(await Array.fromAsync(Content.roots("home", original.id))).toEqual([added])
        },
      }),
    )
  })
