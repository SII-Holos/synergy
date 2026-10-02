import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotRecords } from "../../src/session/snapshot-records"
import { SessionSummary } from "../../src/session/summary"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("legacy checkpoints preserve retained endpoints and existing diffs without reading current files", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
          summary: {
            title: "Legacy",
            body: "",
            diffs: [{ file: "old.txt", additions: 2, deletions: 1 }],
            diffState: { status: "ready" },
          },
        })
        const before = await Snapshot.track(session.id)
        await Bun.write(`${directory.path}/old.txt`, "recorded\n")
        const after = await Snapshot.track(session.id)
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: root.id,
          sessionID: session.id,
          type: "patch",
          hash: before!,
          workspace: Snapshot.workspace(),
          files: ["old.txt"],
          operation: { toolCallID: "legacy", status: "complete", afterHash: after! },
        })
        const initialDisplay = await SessionHistoryDisplay.timelinePage(
          { sessionID: session.id },
          { hidden: new Set() },
          session.scope.id,
        )
        expect(
          initialDisplay.items[0].info.role === "user" && initialDisplay.items[0].info.summary?.diffState?.status,
        ).toBe("ready")
        const migration = migrations.find((item) => item.id === "20261003-session-turn-file-checkpoints")!
        expect(migration).toBeDefined()
        const track = spyOn(Snapshot, "track")
        try {
          await migration.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
          await migration.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
          expect(track).not.toHaveBeenCalled()
          const refreshedDisplay = await SessionHistoryDisplay.timelinePage(
            { sessionID: session.id },
            { hidden: new Set() },
            session.scope.id,
          )
          expect(
            refreshedDisplay.items[0].info.role === "user" && refreshedDisplay.items[0].info.summary?.diffState?.status,
          ).toBe("partial")
          expect(refreshedDisplay.items[0].content.version).not.toBe(initialDisplay.items[0].content.version)
          const updated = await MessageV2.get({ sessionID: session.id, messageID: root.id })
          const checkpoints = updated.parts.filter((part) => part.type === "patch" && part.checkpoint)
          expect(checkpoints).toHaveLength(1)
          expect(SnapshotRecords.partRoots(checkpoints[0]!)).toEqual([before!, after!])
          expect(updated.parts.find((item) => item.id === part.id)).toEqual(part)
          expect(updated.info.role === "user" && updated.info.summary?.diffs).toEqual(
            root.role === "user" && root.summary?.diffs,
          )
          expect(updated.info.role === "user" && updated.info.summary?.diffState?.status).toBe("partial")
          const cursor = await Storage.read<{ version: number }>(
            StoragePath.sessionSummaryCursor(
              Identifier.asScopeID(session.scope.id),
              Identifier.asSessionID(session.id),
            ),
          )
          expect(cursor.version).toBe(4)
        } finally {
          track.mockRestore()
        }
      },
    })
  }))

test("legacy file results without endpoints stay visible and cannot become a ready empty result", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const diff = {
          file: "missing.txt",
          workspace: Snapshot.workspace(),
          additions: 1,
          deletions: 0,
          preview: "+retained",
        }
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
          summary: { diffs: [diff] },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: root.id,
          type: "text",
          text: "Legacy task",
        })
        await migrations.find((item) => item.id === "20261003-session-turn-file-checkpoints")!.upSession!(
          { scopeID: session.scope.id, sessionID: session.id },
          () => {},
        )
        await SessionSummary.summarize({ sessionID: session.id, messageID: root.id, diffOnly: true })
        const message = await MessageV2.get({ sessionID: session.id, messageID: root.id })
        expect(message.info.role === "user" && message.info.summary?.diffs).toEqual([diff])
        expect(message.info.role === "user" && message.info.summary?.diffState?.status).not.toBe("ready")
        const part = message.parts.find((part) => part.type === "patch") as MessageV2.PatchPart
        expect(part.hash).toBe("")
        expect(part.checkpoint?.afterHash).toBeUndefined()
      },
    })
  }))
