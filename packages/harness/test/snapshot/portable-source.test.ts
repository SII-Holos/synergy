import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Identifier } from "../../src/id/id"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotPortableSource as Portable } from "../../src/session/snapshot-portable-source"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { Storage } from "../../src/storage/storage"

test("frozen Snapshot capture exports standalone pack streams and reuses the same sealed source after restart", async () => {
  await using home = await tmpdir()
  await using targetDirectory = await tmpdir()
  const runtime = await testRuntime({ home: home.path })
  const retained = await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const operation = await SnapshotStore.resolveRepository("home", session.id)
        await SnapshotStore.initialize(operation)
        const roots: string[] = []
        for (const text of ["first historical file", "second historical file", "retained unreferenced history"]) {
          const blob = await SnapshotStore.command(
            operation.repository,
            ["hash-object", "-w", "--stdin"],
            undefined,
            text,
          )
          roots.push(
            await SnapshotStore.command(
              operation.repository,
              ["mktree"],
              undefined,
              "100644 blob " + blob + "\tfile.txt\n",
            ),
          )
        }
        await SnapshotStore.retainMany("home", session.id, roots)
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
        for (const hash of roots.slice(0, 2))
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID,
            sessionID: session.id,
            type: "snapshot",
            snapshot: hash,
          })
        await Session.flushPartWrites(session.id)
        const context = {
          session: await Session.get(session.id),
          rootSessionID: session.id,
          handoffID: "snapshot-source",
          signal: new AbortController().signal,
        }
        await expect(Portable.capture(context)).rejects.toThrow("frozen")
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: context.handoffID,
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await Epochs.freeze(binding)
        const manifest = await Portable.capture(context)
        expect(manifest.roots).toBe(3)
        expect(manifest.packs).toBe(1)
        expect(await Portable.capture(context)).toEqual(manifest)
        const target = path.join(targetDirectory.path, "history.git")
        await SnapshotStore.initializeBareRepository(target)
        let packs = 0
        let records = 0
        for await (const entry of Portable.entries(context)) {
          if (entry.kind === "record") {
            records++
            continue
          }
          const file = path.join(targetDirectory.path, String(packs++) + ".pack")
          const sink = await fs.open(file, "wx", 0o600)
          try {
            for await (const block of entry.content) await sink.writeFile(block)
          } finally {
            await sink.close()
          }
          await SnapshotGit.checked(target, ["index-pack", "--stdin", "--strict"], { input: file })
        }
        expect(records).toBe(5)
        expect(packs).toBe(1)
        expect(await SnapshotStore.command(target, ["show", roots[0] + ":file.txt"])).toBe("first historical file")
        expect(await SnapshotStore.command(target, ["show", roots[2] + ":file.txt"])).toBe(
          "retained unreferenced history",
        )
        return { sessionID: session.id, manifest, roots, binding }
      },
    }),
  )
  await runtime.close()
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(async () => {
    const context = {
      session: await Session.get(retained.sessionID),
      rootSessionID: retained.sessionID,
      handoffID: "snapshot-source",
      signal: new AbortController().signal,
    }
    expect(await Portable.capture(context)).toEqual(retained.manifest)
    let packs = 0
    for await (const entry of Portable.entries(context))
      if (entry.kind === "history") {
        let bytes = 0
        for await (const block of entry.content) bytes += block.length
        expect(bytes).toBeGreaterThan(0)
        packs++
      }
    expect(packs).toBe(1)
    await expect(Portable.discardCancelled(retained.binding)).rejects.toThrow("cancellation")
    await Epochs.cancel(retained.binding)
    await Portable.discardCancelled(retained.binding)
    expect(await SnapshotStore.owns("home", retained.sessionID, retained.roots[0])).toBe(true)
    expect((await Session.get(retained.sessionID)).paused).toBeDefined()
    expect(
      await Storage.artifactReferences({
        prefix: ["snapshot_portable_source", "snapshot-source", retained.sessionID],
        limit: 1,
      }),
    ).toEqual([])
  })
}, 15000)
