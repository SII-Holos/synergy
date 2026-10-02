import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Session } from "../../src/session"
import { SessionFileChanges } from "../../src/session/file-changes"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotRecords } from "../../src/session/snapshot-records"
import { SessionHistory } from "../../src/session/history"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("fork and export retain both checkpoint versions after deleting the source and pruning", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const source = await Session.create({})
        const input = await turn(source.id)
        await Bun.write(path.join(directory.path, "retained.txt"), "before\n")
        await SessionFileChanges.begin(input)
        await Bun.write(path.join(directory.path, "retained.txt"), "after\n")
        await SessionFileChanges.finish(input)
        const fork = await Session.fork({ sessionID: source.id })
        const report = await SessionExport.generate({ sessionID: source.id, mode: "full" })
        const imported = await SessionImport.fromReport(report)
        await Session.remove(source.id)
        await SnapshotMaintenance.compact(ScopeContext.current.scope.id, { apply: true, prune: true })
        for (const sessionID of [fork.id, imported.rootSessionID]) {
          const messages = await SessionHistory.rawMessages({ sessionID })
          const root = messages.find((message) => message.info.role === "user")!
          const checkpoint = root.parts.find((part) => part.type === "patch" && part.checkpoint) as MessageV2.PatchPart
          expect(checkpoint.checkpoint?.rootID).toBe(root.info.id)
          expect(SnapshotRecords.partRoots(checkpoint)).toHaveLength(2)
          const workspace = checkpoint.workspace!
          const diff = await SessionHistory.fileDiff({
            sessionID,
            messageID: root.info.id,
            workspaceID: workspace.id,
            generation: workspace.generation,
            file: "retained.txt",
          })
          expect(diff.patch).toContain("-before")
          expect(diff.patch).toContain("+after")
        }
      },
    })
  }))

async function turn(sessionID: string) {
  const root = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot: true,
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: root.id,
    type: "text",
    text: "Inspect changes",
  })
  return { sessionID, rootID: root.id, segmentID: crypto.randomUUID() }
}

test("a segment captures workspace net changes, including external writes, once at each boundary", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(directory.path, "existing.txt"), "pre-existing dirty content\n")
        const input = await turn(session.id)
        const capture = spyOn(Snapshot, "track")
        try {
          await SessionFileChanges.begin(input)
          await Promise.all(
            Array.from({ length: 20 }, () => Bun.file(path.join(directory.path, "existing.txt")).text()),
          )
          await Bun.write(path.join(directory.path, "existing.txt"), "intermediate\n")
          await Bun.write(path.join(directory.path, "existing.txt"), "final\n")
          await Bun.write(path.join(directory.path, "external.txt"), "another writer\n")
          await SessionFileChanges.finish(input)
          expect(capture).toHaveBeenCalledTimes(2)
          const message = await MessageV2.get({ sessionID: session.id, messageID: input.rootID })
          expect(message.info.role === "user" && message.info.summary?.diffState).toEqual({ status: "ready" })
          const diffs = message.info.role === "user" ? message.info.summary!.diffs : []
          expect(diffs.map((diff) => diff.file).sort()).toEqual(["existing.txt", "external.txt"])
          expect(diffs.find((diff) => diff.file === "existing.txt")).toMatchObject({ additions: 1, deletions: 1 })
          const part = message.parts.find((part) => part.type === "patch")!
          expect(MessageV2.isSystemPart(part)).toBe(true)
          expect(SnapshotRecords.partRoots(part)).toHaveLength(2)
          await Bun.write(path.join(directory.path, "existing.txt"), "later\n")
          await SessionFileChanges.finish(input)
          expect(capture).toHaveBeenCalledTimes(2)
          expect((await MessageV2.get({ sessionID: session.id, messageID: input.rootID })).info).toEqual(message.info)
        } finally {
          capture.mockRestore()
        }
      },
    })
  }))

test("continuation keeps the root baseline and session aggregation cancels reverted changes", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(directory.path, "note.txt")
        await Bun.write(file, "before\n")
        const first = await turn(session.id)
        await SessionFileChanges.begin(first)
        await Bun.write(file, "during\n")
        await SessionFileChanges.finish(first)
        const continued = { ...first, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(continued)
        await Bun.write(file, "final\n")
        await SessionFileChanges.finish(continued)
        const message = await MessageV2.get({ sessionID: session.id, messageID: first.rootID })
        expect(message.info.role === "user" && message.info.summary?.diffs).toHaveLength(1)
        expect(message.info.role === "user" && message.info.summary?.diffs[0]).toMatchObject({
          additions: 1,
          deletions: 1,
        })
        const second = await turn(session.id)
        await SessionFileChanges.begin(second)
        await Bun.write(file, "before\n")
        await SessionFileChanges.finish(second)
        expect(await Session.diff(session.id)).toEqual([])
        await SessionSummary.summarize({ sessionID: session.id, messageID: first.rootID, diffOnly: true })
        expect(await Session.diff(session.id)).toEqual([])
      },
    })
  }))

test("missing start evidence never becomes a fabricated baseline", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const input = await turn(session.id)
        const capture = spyOn(Snapshot, "track").mockRejectedValueOnce(new Error("capture unavailable"))
        try {
          await SessionFileChanges.begin(input)
          await Bun.write(path.join(directory.path, "new.txt"), "actual change\n")
          await SessionFileChanges.finish(input)
          const message = await MessageV2.get({ sessionID: session.id, messageID: input.rootID })
          expect(message.info.role === "user" && message.info.summary?.diffState?.status).toBe("error")
          expect(capture).toHaveBeenCalledTimes(1)
        } finally {
          capture.mockRestore()
        }
      },
    })
  }))

test("an oversized endpoint cannot become a deletion and valid files remain reviewable", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(directory.path, "large.txt"), "original\n")
        await Bun.write(path.join(directory.path, "valid.txt"), "before\n")
        const input = await turn(session.id)
        await SessionFileChanges.begin(input)
        await Bun.write(path.join(directory.path, "large.txt"), "x".repeat(3 * 1024 * 1024))
        await Bun.write(path.join(directory.path, "valid.txt"), "after\n")
        await Bun.write(path.join(directory.path, "temporary.txt"), "temporary\n")
        await fs.unlink(path.join(directory.path, "temporary.txt"))
        await SessionFileChanges.finish(input)
        const message = await MessageV2.get({ sessionID: session.id, messageID: input.rootID })
        expect(message.info.role === "user" && message.info.summary?.diffState?.status).toBe("partial")
        expect(message.info.role === "user" && message.info.summary?.diffs.map((file) => file.file)).toEqual([
          "valid.txt",
        ])
      },
    })
  }))
