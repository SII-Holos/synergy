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
import { SnapshotCapture } from "../../src/session/snapshot-capture"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { WorkspaceAccess } from "../../src/workspace/access"
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
        {
          using history = spyOn(SessionHistory, "rawMessages")
          await SessionFileChanges.finish(continued)
          expect(history).not.toHaveBeenCalled()
        }
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

test.each([false, true])(
  "independent workspace endpoints overlap and drain before settlement (publication failure=%s)",
  async (failPublication) => {
    await using isolated = await testRuntime({
      register: () =>
        WorkspaceAccess.register({
          async acquire(input) {
            return { id: input.id, async release() {}, async bindProcess() {} }
          },
        }),
    })
    await isolated.run(async () => {
      await using first = await tmpdir()
      await using second = await tmpdir()
      await using third = await tmpdir()
      const scope = await first.scope()
      const directories = [first.path, second.path, third.path]
      const workspaces = await Promise.all(
        directories.map((directory) =>
          ScopeContext.provide({
            scope,
            workspace: { type: "directory", scopeID: scope.id, path: directory },
            fn: () => ScopeContext.current.workspace!,
          }),
        ),
      )
      await ScopeContext.provide({
        scope,
        workspace: workspaces[0],
        async fn() {
          const session = await Session.create({})
          const input = await turn(session.id)
          for (const [index, directory] of directories.entries())
            await Bun.write(path.join(directory, "entry.txt"), `before ${index}\n`)
          await SessionFileChanges.begin(input)
          await SessionFileChanges.provide(
            {
              owner: { kind: "session", scopeID: scope.id, sessionID: session.id },
              runID: input.rootID,
              messageID: input.rootID,
              toolCallID: "workspace-use",
              tool: "fixture",
              args: {},
            },
            () => WorkspaceAccess.task({ sessionID: session.id }, () => WorkspaceAccess.use(workspaces.slice(1))),
          )
          for (const [index, directory] of directories.entries())
            await Bun.write(path.join(directory, "entry.txt"), `after ${index}\n`)

          const entered = new Set<string>()
          const ready = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const refresh = SnapshotCapture.refresh
          using capture = spyOn(SnapshotCapture, "refresh").mockImplementation(async (...args) => {
            entered.add(args[0].workspace)
            if (entered.size === directories.length) ready.resolve()
            await release.promise
            return refresh(...args)
          })
          const updatePart = Session.updatePart
          using publish = spyOn(Session, "updatePart").mockImplementation(
            Object.assign(async (value: Parameters<typeof updatePart>[0]) => {
              const part = "part" in value ? value.part : value
              if (
                failPublication &&
                part.type === "patch" &&
                part.workspace?.id === workspaces[0]!.id &&
                part.checkpoint?.ended
              )
                throw new Error("Endpoint publication unavailable")
              return updatePart(value)
            }, updatePart),
          )
          using summary = spyOn(SessionSummary, "summarize")
          let settled = false
          const finishing = SessionFileChanges.finish(input).then(() => {
            settled = true
          })
          const timeout = setTimeout(() => ready.reject(new Error("Workspace captures did not overlap")), 5000)
          try {
            await ready.promise
            expect(settled).toBe(false)
          } finally {
            clearTimeout(timeout)
            release.resolve()
            await finishing
          }
          expect(settled).toBe(true)
          expect(summary).toHaveBeenCalledTimes(1)
          const message = await MessageV2.get({ sessionID: session.id, messageID: input.rootID })
          const patches = message.parts.filter((part): part is MessageV2.PatchPart => part.type === "patch")
          expect(patches).toHaveLength(3)
          const repo = SnapshotStore.repository(scope.id)
          for (const [index, workspace] of workspaces.entries()) {
            const part = patches.find((part) => part.workspace?.id === workspace.id)!
            expect(await SnapshotStore.command(repo, ["show", `${part.hash}:entry.txt`])).toBe(`before ${index}`)
            if (failPublication && index === 0) {
              expect(part.checkpoint?.status).toBe("pending")
              continue
            }
            expect(part.checkpoint?.status).toBe("complete")
            expect(part.files).toEqual(["entry.txt"])
            expect(await SnapshotStore.owns(scope.id, session.id, part.checkpoint!.afterHash!)).toBe(true)
            expect(await SnapshotStore.command(repo, ["show", `${part.checkpoint!.afterHash}:entry.txt`])).toBe(
              `after ${index}`,
            )
          }
        },
      })
    })
  },
)

test("settlement drains an admitted baseline before starting its endpoint", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create({})
        const input = await turn(session.id)
        await Bun.write(path.join(directory.path, "baseline.txt"), "captured bytes\n")
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const track = Snapshot.track
        let baselineComplete = false
        let captures = 0
        using capture = spyOn(Snapshot, "track").mockImplementation(async (...args) => {
          if (captures++ > 0) expect(baselineComplete).toBe(true)
          entered.resolve()
          await release.promise
          const hash = await track(...args)
          baselineComplete = true
          return hash
        })
        const beginning = SessionFileChanges.begin(input)
        await entered.promise
        const finishing = SessionFileChanges.finish(input)
        release.resolve()
        await Promise.all([beginning, finishing])
        expect(capture).toHaveBeenCalledTimes(2)
        const message = await MessageV2.get({ sessionID: session.id, messageID: input.rootID })
        expect(message.parts.find((part) => part.type === "patch")?.checkpoint?.status).toBe("complete")
      },
    })
  }))
