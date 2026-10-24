import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceObservation } from "../../src/workspace/observation"
import { WorkspaceAccess } from "../../src/workspace/access"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionFileChanges } from "../../src/session/file-changes"
import { SessionFileChangeView } from "../../src/session/file-change-view"
import { SessionHistory } from "../../src/session/history"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotLive } from "../../src/session/snapshot-live"
import { SessionSummary } from "../../src/session/summary"
import { SessionExport } from "../../src/session/session-export"
import { Bus } from "../../src/bus"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime({
  register() {
    WorkspaceObservation.register(async () => true)
    WorkspaceAccess.register({
      async acquire(input) {
        return { id: input.id, async release() {}, async bindProcess() {} }
      },
    })
  },
})
afterAll(() => runtime.close())

function summary(sessionID: string, accepts: (value: NonNullable<MessageV2.User["summary"]>) => boolean) {
  return new Promise<NonNullable<MessageV2.User["summary"]>>((resolve, reject) => {
    const stop = Bus.subscribe(MessageV2.Event.Updated, ({ properties: { info } }) => {
      if (info.sessionID !== sessionID || info.role !== "user" || !info.summary || !accepts(info.summary)) return
      clearTimeout(timer)
      stop()
      resolve(info.summary)
    })
    const timer = setTimeout(() => {
      stop()
      reject(new Error("Summary did not converge"))
    }, 5000)
  })
}

test("current turn totals survive net cancellation and Review reads one leased revision through later edits and settlement", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const file = path.join(directory.path, "a.txt")
        await Bun.write(file, "existing dirty\n")
        const session = await Session.create()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "Edit the file",
        })
        const input = { sessionID: session.id, rootID: user.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(input)
        const first = summary(
          session.id,
          (value) => value.diffState?.status === "live" && value.diffTotals?.additions === 2,
        )
        await Bun.write(file, "first\nsecond\n")
        WorkspaceObservation.invalidate({ paths: ["a.txt"] })
        const observed = await first
        expect(observed.diffTotals).toEqual({ files: 1, additions: 2, deletions: 1 })
        expect((await SessionFileChangeView.current(session.id))?.rootID).toBe(user.id)
        const comparison = await SessionFileChangeView.acquire(session.id, user.id, observed.diffRevision)
        expect(comparison.files).toHaveLength(1)
        const fork = await Session.fork({ sessionID: session.id })
        expect((await SessionFileChangeView.current(fork.id))?.summary?.diffRevision).toBeUndefined()
        const exported = await SessionExport.generate({ sessionID: session.id, mode: "full" })
        const exportedRoot = exported.sessions[0]!.messages.find((message) => message.info.id === user.id)!.info
        expect(exportedRoot.role === "user" && exportedRoot.summary?.diffRevision).toBeUndefined()
        await expect(SessionFileChangeView.acquire(fork.id, user.id, observed.diffRevision)).rejects.toThrow("expired")
        const workspace = comparison.files[0]!.workspace!
        const query = {
          sessionID: session.id,
          messageID: user.id,
          revision: comparison.revision,
          workspaceID: workspace.id,
          generation: workspace.generation,
          file: "a.txt",
        }
        const diff = await SessionHistory.fileDiff(query)
        const zero = summary(session.id, (value) => value.diffState?.status === "live" && value.diffTotals?.files === 0)
        await Bun.write(file, "existing dirty\n")
        WorkspaceObservation.invalidate({ paths: ["a.txt"] })
        await zero
        expect(diff.patch).toContain("+first")
        expect((await SessionHistory.fileVersions(query)).after.content).toBe("first\nsecond\n")
        await SessionFileChanges.finish(input)
        expect((await SessionFileChangeView.current(session.id))?.summary).toMatchObject({
          diffState: { status: "ready" },
          diffTotals: { files: 0, additions: 0, deletions: 0 },
        })
        expect((await SessionHistory.fileVersions(query)).after.content).toBe("first\nsecond\n")
        await SessionFileChangeView.release(session.id, comparison.revision)
        await expect(SessionHistory.fileVersions(query)).rejects.toThrow("expired")
      },
    })
  }))

test("failed final publication keeps the last comparison readable and explicitly incomplete", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(input)
        const changed = summary(session.id, (value) => value.diffTotals?.files === 1)
        await Bun.write(path.join(directory.path, "new.txt"), "new\n")
        WorkspaceObservation.invalidate({ paths: ["new.txt"] })
        await changed
        using failure = spyOn(SessionSummary, "summarize").mockRejectedValue(new Error("Publication failed"))
        await SessionFileChanges.finish(input)
        expect((await SessionFileChangeView.current(session.id))?.summary?.diffState).toEqual({
          status: "error",
          code: "incomplete",
        })
        const view = await SessionFileChangeView.acquire(session.id, root.id)
        expect(view.files).toHaveLength(1)
        await SessionFileChangeView.release(session.id, view.revision)
      },
    })
  }))

test("continuation keeps the original baseline and final totals are independent of the message projection", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "Edit files",
        })
        const first = { sessionID: session.id, rootID: user.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(first)
        const files = Array.from({ length: 300 }, (_, index) => `file-${index}.txt`)
        await Promise.all(files.map((file) => Bun.write(path.join(directory.path, file), "one\n")))
        await SessionFileChanges.finish(first)
        const final = (await SessionFileChangeView.current(session.id))?.summary
        expect(final?.diffTotals).toEqual({ files: 300, additions: 300, deletions: 0 })
        const continued = { ...first, segmentID: crypto.randomUUID() }
        const initialized = summary(
          session.id,
          (value) => value.diffState?.status === "live" && value.diffTotals?.files === 300,
        )
        await SessionFileChanges.begin(continued)
        await initialized
        const changed = summary(
          session.id,
          (value) => value.diffState?.status === "live" && value.diffTotals?.additions === 301,
        )
        await Bun.write(path.join(directory.path, files[0]!), "one\ntwo\n")
        WorkspaceObservation.invalidate({ paths: [files[0]!] })
        const observed = await changed
        expect(observed.diffTotals).toEqual({ files: 300, additions: 301, deletions: 0 })
        const view = await SessionFileChangeView.acquire(session.id, user.id)
        expect(view.files).toHaveLength(300)
        await SessionFileChanges.finish(continued)
        expect((await SessionFileChangeView.current(session.id))?.summary?.diffTotals).toEqual(observed.diffTotals)
        await SessionFileChangeView.release(session.id, view.revision)
      },
    })
  }))

test("continuation publishes only after every prior Workspace has initialized", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const scope = await first.scope()
    const workspaces = await Promise.all(
      [first.path, second.path].map((directory) =>
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
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(input)
        await SessionFileChanges.provide(
          {
            owner: { kind: "session", scopeID: scope.id, sessionID: session.id },
            runID: root.id,
            messageID: root.id,
            toolCallID: "workspace-use",
            tool: "fixture",
            args: {},
          },
          () => WorkspaceAccess.task({ sessionID: session.id }, () => WorkspaceAccess.use(workspaces.slice(1))),
        )
        await Bun.write(path.join(second.path, "changed.txt"), "recorded\n")
        await SessionFileChanges.finish(input)
        expect((await SessionFileChangeView.current(session.id))?.summary?.diffTotals?.files).toBe(1)

        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const statistics = Snapshot.statistics
        using comparison = spyOn(Snapshot, "statistics").mockImplementation(async (...args) => {
          entered.resolve()
          await release.promise
          return statistics(...args)
        })
        const counts: number[] = []
        const unsubscribe = Bus.subscribe(MessageV2.Event.Updated, ({ properties: { info } }) => {
          if (info.id === root.id && info.role === "user" && info.summary?.diffState?.status === "live")
            counts.push(info.summary.diffTotals!.files)
        })
        const continued = { ...input, segmentID: crypto.randomUUID() }
        const beginning = SessionFileChanges.begin(continued)
        try {
          await entered.promise
          await Bun.sleep(350)
          expect(counts).toEqual([])
          expect((await SessionFileChangeView.current(session.id))?.summary?.diffTotals?.files).toBe(1)
          await Bun.write(path.join(first.path, "during-initialization.txt"), "another change\n")
          WorkspaceObservation.invalidate({ paths: ["during-initialization.txt"] })
          const initialized = summary(
            session.id,
            (value) => value.diffState?.status === "live" && value.diffTotals?.files === 2,
          )
          release.resolve()
          await beginning
          await initialized
          expect(counts).toEqual([2])
        } finally {
          release.resolve()
          await beginning
          unsubscribe()
          await SessionFileChanges.finish(continued)
        }
      },
    })
  }))

test.each(["retained", "unknown", "live"])("historical comparison failure preserves %s evidence and recovers", (mode) =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using historical = await tmpdir()
    const scope = await directory.scope()
    const workspace = await ScopeContext.provide({
      scope,
      workspace: { type: "directory", scopeID: scope.id, path: historical.path },
      fn: () => ScopeContext.current.workspace!,
    })
    await ScopeContext.provide({
      scope,
      async fn() {
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        if (root.role !== "user") throw new Error("Expected a user root")
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(input)
        await SessionFileChanges.provide(
          {
            owner: { kind: "session", scopeID: scope.id, sessionID: session.id },
            runID: root.id,
            messageID: root.id,
            toolCallID: "historical-workspace-use",
            tool: "fixture",
            args: {},
          },
          () => WorkspaceAccess.task({ sessionID: session.id }, () => WorkspaceAccess.use([workspace])),
        )
        const filename = path.join(historical.path, "changed.txt")
        await Bun.write(filename, "recorded\n")
        await SessionFileChanges.finish(input)
        if (mode === "unknown") await Session.updateMessage({ ...root, summary: { diffs: [] } })
        if (mode === "live") await fs.unlink(filename)
        const previous = (await SessionFileChangeView.current(session.id))?.summary
        const create = SnapshotLive.create
        using live = spyOn(SnapshotLive, "create").mockImplementation(async (...args) => {
          if (mode !== "live" && ScopeContext.current.workspace?.id === workspace.id)
            throw new Error("Live comparison unavailable")
          return create(...args)
        })
        using comparison = spyOn(Snapshot, "statistics").mockRejectedValue(
          new Error("Historical comparison unavailable"),
        )
        const continued = { ...input, segmentID: crypto.randomUUID() }
        const observed = summary(session.id, (value) => value.diffState?.status === "live")
        await SessionFileChanges.begin(continued)
        try {
          const value = await observed
          if (mode === "live") {
            expect(value.diffTotals).toEqual({ files: 0, additions: 0, deletions: 0 })
            expect(value.diffState).toEqual({ status: "live" })
          } else {
            expect(value.diffTotals).toEqual(previous?.diffTotals)
            expect(value.diffRevision).toBe(previous?.diffRevision)
            expect(value.diffObservedAt).toBe(previous?.diffObservedAt)
            expect(value.diffHasChanges).toBe(mode === "retained")
            expect(value.diffIssues).toContainEqual(expect.objectContaining({ code: "comparison_failed" }))
            const attempts = comparison.mock.calls.length
            await Bun.sleep(350)
            expect(comparison.mock.calls).toHaveLength(attempts)
            if (mode === "retained") {
              const failed = summary(
                session.id,
                (value) =>
                  value.diffIssues?.some(
                    (issue) => issue.code === "capture_failed" && issue.workspace?.id !== workspace.id,
                  ) ?? false,
              )
              {
                using statistics = spyOn(Snapshot, "liveStatistics").mockRejectedValueOnce(
                  new Error("Statistics unavailable"),
                )
                await Bun.write(path.join(directory.path, "unpublished.txt"), "pending\n")
                WorkspaceObservation.invalidate({ paths: ["unpublished.txt"] })
                await failed
              }
            }
            comparison.mockRestore()
            const recovered = summary(
              session.id,
              (value) =>
                value.diffTotals?.files === 1 &&
                !!value.diffRevision &&
                !value.diffIssues?.some((issue) => issue.code === "comparison_failed"),
            )
            await ScopeContext.provide({
              scope,
              workspace,
              fn: () => WorkspaceObservation.invalidate({ paths: [""] }),
            })
            const accepted = await recovered
            const view = await SessionFileChangeView.acquire(session.id, root.id, accepted.diffRevision)
            expect(view.files.map((file) => file.file)).toEqual(["changed.txt"])
            await SessionFileChangeView.release(session.id, view.revision)
          }
        } finally {
          comparison.mockRestore()
          await SessionFileChanges.finish(continued)
        }
      },
    })
  }),
)

test("a failed statistics refresh preserves the last revision and resynchronizes all lost dirty paths", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        await SessionFileChanges.begin(input)
        const first = summary(session.id, (value) => value.diffTotals?.files === 1)
        await Bun.write(path.join(directory.path, "a.txt"), "first\n")
        WorkspaceObservation.invalidate({ paths: ["a.txt"] })
        await first
        const failed = summary(
          session.id,
          (value) => value.diffState?.status === "live" && value.diffState.code === "incomplete",
        )
        {
          using failure = spyOn(Snapshot, "liveStatistics").mockRejectedValue(new Error("statistics unavailable"))
          await Bun.write(path.join(directory.path, "b.txt"), "second\n")
          WorkspaceObservation.invalidate({ paths: ["b.txt"] })
          expect((await failed).diffTotals).toEqual({ files: 1, additions: 1, deletions: 0 })
          const retained = await SessionFileChangeView.acquire(session.id, root.id)
          expect(retained.files.map((file) => file.file)).toEqual(["a.txt"])
          const workspace = retained.files[0]!.workspace!
          const query = {
            sessionID: session.id,
            messageID: root.id,
            revision: retained.revision,
            workspaceID: workspace.id,
            generation: workspace.generation,
            file: "a.txt",
          }
          expect((await SessionHistory.fileVersions(query)).after.content).toBe("first\n")
          await SessionFileChangeView.release(session.id, retained.revision)
        }
        const recovered = summary(
          session.id,
          (value) => value.diffTotals?.files === 3 && value.diffState?.status === "live" && !value.diffState.code,
        )
        await Bun.write(path.join(directory.path, "c.txt"), "third\n")
        WorkspaceObservation.invalidate({ paths: ["c.txt"] })
        expect((await recovered).diffTotals).toEqual({ files: 3, additions: 3, deletions: 0 })
        using failure = spyOn(Snapshot, "track").mockRejectedValue(new Error("final capture unavailable"))
        await SessionFileChanges.finish(input)
        expect((await SessionFileChangeView.current(session.id))?.summary).toMatchObject({
          diffState: { status: "error", code: "incomplete" },
          diffTotals: { files: 3, additions: 3, deletions: 0 },
        })
        const retained = await SessionFileChangeView.acquire(session.id, root.id)
        expect(retained.files).toHaveLength(3)
        await SessionFileChangeView.release(session.id, retained.revision)
      },
    })
  }))

test("rejected live publications release unpublished comparison owners before recovery and settlement", () =>
  runtime.run(async () => {
    const fs = await import("node:fs/promises")
    const { Global } = await import("../../src/global")
    const liveRoot = path.join(Global.Path.cache, "snapshot-live")
    const before = (await fs.readdir(liveRoot).catch(() => [])).sort()
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        const started = summary(session.id, (value) => value.diffState?.status === "live")
        await SessionFileChanges.begin(input)
        await started
        for (let attempt = 0; attempt < 2; attempt++) {
          const rejected = Promise.withResolvers<void>()
          using failure = spyOn(SessionSummary, "publishLive").mockImplementation(async () => {
            rejected.resolve()
            throw new Error("Publication rejected")
          })
          await Bun.write(path.join(directory.path, "file.txt"), `change ${attempt}\n`)
          WorkspaceObservation.invalidate({ paths: ["file.txt"] })
          await rejected.promise
        }
        const accepted = summary(session.id, (value) => value.diffTotals?.additions === 2)
        await Bun.write(path.join(directory.path, "file.txt"), "recovered\ncontent\n")
        WorkspaceObservation.invalidate({ paths: ["file.txt"] })
        await accepted
        await SessionFileChanges.finish(input)
        expect((await fs.readdir(liveRoot)).sort()).toEqual(before)
      },
    })
  }))

test("failed checkpoint admission releases observation before the segment is settled", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        for (const failureAt of [1, 2]) {
          const session = await Session.create()
          const root = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            isRoot: true,
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
          })
          const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
          const subscribe = WorkspaceObservation.subscribe,
            update = Session.updatePart
          let closed = 0,
            writes = 0
          using observation = spyOn(WorkspaceObservation, "subscribe").mockImplementation(async (listener) => {
            const watcher = await subscribe(listener)
            return {
              ...watcher,
              close() {
                closed++
                watcher.close()
              },
            }
          })
          {
            using failure = spyOn(Session, "updatePart").mockImplementation(
              Object.assign(
                async (part: Parameters<typeof update>[0]) => {
                  if (++writes === failureAt) throw new Error("Checkpoint rejected")
                  return update(part)
                },
                { force: update.force, schema: update.schema },
              ),
            )
            await expect(SessionFileChanges.begin(input)).rejects.toThrow("Checkpoint rejected")
          }
          try {
            expect(closed).toBe(1)
          } finally {
            await SessionFileChanges.finish(input)
          }
        }
      },
    })
  }))

test("large omission inventories keep live publications bounded and preserve checkpoint evidence", () =>
  runtime.run(async () => {
    const fs = await import("node:fs/promises")
    await using directory = await tmpdir()
    for (let index = 0; index < 512; index++) {
      const file = await fs.open(path.join(directory.path, `${index}-${"x".repeat(180)}.txt`), "w")
      await file.truncate(2 * 1024 * 1024 + 1)
      await file.close()
    }
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create()
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        })
        const input = { sessionID: session.id, rootID: root.id, segmentID: crypto.randomUUID() }
        const observed = summary(session.id, (value) => value.diffState?.status === "live")
        await SessionFileChanges.begin(input)
        try {
          const value = await observed
          expect(value.diffState).toEqual({ status: "live", code: "incomplete" })
          expect(value.diffIssues?.length).toBeGreaterThan(0)
          expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(10 * 1024)
          const current = await SessionFileChangeView.current(session.id)
          expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(10 * 1024)
          const original = await MessageV2.get({ sessionID: session.id, messageID: root.id })
          const checkpoint = original.parts.find((part) => part.type === "patch")
          expect(checkpoint?.type === "patch" && checkpoint.checkpoint?.baselineOmissions).toHaveLength(512)
        } finally {
          await SessionFileChanges.finish(input)
        }
      },
    })
  }))
