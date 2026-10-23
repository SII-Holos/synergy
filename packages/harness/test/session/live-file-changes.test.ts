import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceObservation } from "../../src/workspace/observation"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionFileChanges } from "../../src/session/file-changes"
import { SessionFileChangeView } from "../../src/session/file-change-view"
import { SessionHistory } from "../../src/session/history"
import { Snapshot } from "../../src/session/snapshot"
import { SessionSummary } from "../../src/session/summary"
import { SessionExport } from "../../src/session/session-export"
import { Bus } from "../../src/bus"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime({ register: () => WorkspaceObservation.register(async () => true) })
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
