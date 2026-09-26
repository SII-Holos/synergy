import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceFileIndexer } from "../../src/workspace-file/indexer"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { FileWatcher } from "../../src/file/watcher"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { waitForLinuxSubscription } from "../support/watcher"

test("file indexes and Git status follow each Session Workspace in one Scope", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const scope = await first.scope()
    await Bun.write(path.join(first.path, "first.txt"), "first")
    await Bun.write(path.join(second.path, "second.txt"), "second")
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    const snapshot = (session: Session.Info) =>
      ScopeContext.provide({
        scope,
        workspace: session.workspace,
        fn: async () => ({
          index: await WorkspaceFileIndexer.snapshot(),
          status: await WorkspaceFileStatus.summary(),
        }),
      })
    const [a, b] = await Promise.all(sessions.map(snapshot))
    expect(a!.index.files).toContain("first.txt")
    expect(a!.index.files).not.toContain("second.txt")
    expect(b!.index.files).toContain("second.txt")
    expect(b!.index.files).not.toContain("first.txt")
    expect(a!.status.files.map((file) => file.path)).toEqual(["first.txt"])
    expect(b!.status.files.map((file) => file.path)).toEqual(["second.txt"])
    expect((await snapshot(sessions[0]!)).index.files).toEqual(a!.index.files)
  })
})

test("native watcher delivers changes only to the owning Workspace subscribers", async () => {
  await using runtime = await testRuntime({ env: { SYNERGY_DISABLE_FILEWATCHER: "false" } })
  await runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const scope = await first.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    const events: string[][] = [[], []]
    const received = Promise.withResolvers<void>()
    const unsubscribers = []
    for (const [index, session] of sessions.entries()) {
      unsubscribers.push(
        await ScopeRuntime.provide({
          scope,
          workspace: session.workspace,
          fn: async () => {
            const unsubscribe = WorkspaceEvents.subscribe(FileWatcher.Event.Updated, (event) => {
              if (event.properties.file !== "observed.txt") return
              events[index]!.push(event.properties.workspaceID)
              if (index === 1) received.resolve()
            })
            try {
              await waitForLinuxSubscription(session.workspace!.path)
              return unsubscribe
            } catch (error) {
              unsubscribe()
              throw error
            }
          },
        }),
      )
    }
    try {
      await Bun.write(path.join(second.path, "observed.txt"), "native watcher")
      await Promise.race([
        received.promise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Native Workspace event was not delivered")), 4_000)
          received.promise.finally(() => clearTimeout(timer))
        }),
      ])
      expect(events[0]).toEqual([])
      expect(events[1]!.every((id) => id === sessions[1]!.workspaceID)).toBe(true)
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe()
      await ScopeRuntime.dispose(scope.id)
    }
  })
}, 10_000)

test("Git discovery and relative status belong to the Workspace, including names with whitespace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using owner = await tmpdir()
    await using repository = await tmpdir({ git: true })
    const scope = await owner.scope()
    const directory = path.join(repository.path, "nested")
    const filename = "with space\tand newline\n.txt"
    await Bun.write(path.join(repository.path, "outside.txt"), "outside")
    await Bun.write(path.join(directory, filename), "inside")
    await ScopeContext.provide({
      scope,
      workspace: { type: "directory", scopeID: scope.id, path: directory },
      fn: async () => {
        const status = await WorkspaceFileStatus.summary()
        expect(status.files.map((file) => file.path)).toEqual([filename])
      },
    })
  })
})
