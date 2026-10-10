import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionTransfer } from "@ericsanchezok/synergy-harness/session/transfer"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionTransferArchive } from "../../../harness/src/session/transfer-archive"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"

test("transfers dirty files, binaries, modes and links to a new private Workspace", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "changed.txt"), "uncommitted edit")
  await Bun.write(path.join(directory.path, "untracked.bin"), new Uint8Array([0, 255, 19]))
  await Bun.write(path.join(directory.path, "script.sh"), "#!/bin/sh\nexit 0\n")
  await fs.chmod(path.join(directory.path, "script.sh"), 0o755)
  await fs.symlink("changed.txt", path.join(directory.path, "link"))
  const inSource = <T>(fn: () => Promise<T>) =>
    source.run(() => directory.scope().then((scope) => ScopeContext.provide({ scope, fn })))
  const session = await inSource(async () => {
    const workspace = await WorkspaceBinding.register(ScopeContext.current.scope.id, directory.path)
    const session = await Session.create({ workspaceID: workspace.id })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    return session
  })
  const rootID = Identifier.ascending("message")
  let snapshot: string | undefined
  await inSource(async () => {
    const info = await Session.get(session.id)
    await ScopeContext.provide({
      scope: info.scope,
      workspace: info.workspace,
      fn: async () => {
        snapshot = await Snapshot.track(session.id)
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID,
          agent: "general",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: rootID,
          type: "step-start",
          snapshot,
          workspace: Snapshot.workspace(),
        })
      },
    })
  })
  expect(snapshot).toBeString()
  const destination = await target.run(() => SessionTransfer.host())
  await inSource(() =>
    SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() }),
  )
  const blob = await inSource(() => SessionTransfer.archive(session.id))
  const receipt = await target.run(() => SessionTransfer.stage(blob))
  const proof = await inSource(() => SessionTransfer.commit(session.id, receipt))
  const activated = await target.run(() => SessionTransfer.activate(proof))
  await inSource(() => SessionTransfer.complete(session.id, activated))
  const moved = await target.run(() => Session.get(session.id))
  expect(await target.run(() => SnapshotStore.owns(session.scope.id, session.id, snapshot!))).toBe(true)
  expect(
    await target.run(() =>
      SnapshotStore.command(SnapshotStore.repository(session.scope.id), ["show", `${snapshot}:changed.txt`]),
    ),
  ).toBe("uncommitted edit")
  expect(await inSource(() => Bun.file(SessionTransferArchive.filename(proof.migrationID)).exists())).toBe(false)
  expect(await target.run(() => Bun.file(SessionTransferArchive.filename(proof.migrationID)).exists())).toBe(false)
  expect(moved.workspaceID).not.toBe(session.workspaceID)
  expect(moved.workspace?.path).not.toBe(directory.path)
  expect(moved.paused?.reason).toBe("interrupted")
  const root = moved.workspace!.path
  expect(await Bun.file(path.join(root, "changed.txt")).text()).toBe("uncommitted edit")
  expect(new Uint8Array(await Bun.file(path.join(root, "untracked.bin")).arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 19]),
  )
  expect((await fs.stat(path.join(root, "script.sh"))).mode & 0o777).toBe(0o755)
  expect(await fs.readlink(path.join(root, "link"))).toBe("changed.txt")
  await Bun.write(path.join(directory.path, "changed.txt"), "later source edit")
  expect(await Bun.file(path.join(root, "changed.txt")).text()).toBe("uncommitted edit")
}, 30_000)

test("rejects linked Git roots before transfer and permits source recovery by cancellation", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, ".git"), "gitdir: /unavailable/shared/git\n")
  const run = <T>(fn: () => Promise<T>) =>
    source.run(() => directory.scope().then((scope) => ScopeContext.provide({ scope, fn })))
  const session = await run(async () => {
    const workspace = await WorkspaceBinding.register(ScopeContext.current.scope.id, directory.path)
    const session = await Session.create({ workspaceID: workspace.id })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    return session
  })
  const destination = await target.run(() => SessionTransfer.host())
  await expect(
    run(() => SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() })),
  ).rejects.toThrow("linked Git")
  expect((await run(() => SessionTransfer.status(session.id)))?.phase).toBe("preparing")
  await run(() => SessionTransfer.cancel(session.id))
  await run(() => SessionLifecycle.clear(session.id))
  expect((await run(() => Session.get(session.id))).paused).toBeUndefined()
})

test("rejects changes in the prepared Workspace and retries the committed destination after repair", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "file.txt"), "frozen bytes")
  const run = <T>(fn: () => Promise<T>) =>
    source.run(() => directory.scope().then((scope) => ScopeContext.provide({ scope, fn })))
  const session = await run(async () => {
    const workspace = await WorkspaceBinding.register(ScopeContext.current.scope.id, directory.path)
    const session = await Session.create({ workspaceID: workspace.id })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    return session
  })
  const destination = await target.run(() => SessionTransfer.host())
  await run(() => SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() }))
  const receipt = await target.run(() => run(() => SessionTransfer.archive(session.id)).then(SessionTransfer.stage))
  const root = await target.run(() =>
    path.join(path.dirname(SessionTransferArchive.filename(receipt.migrationID)), "workspace"),
  )
  await Bun.write(path.join(root, "file.txt"), "modified during staging")
  const proof = await run(() => SessionTransfer.commit(session.id, receipt))
  await expect(target.run(() => SessionTransfer.activate(proof))).rejects.toThrow("Workspace changed")
  await expect(target.run(() => Session.get(session.id))).rejects.toThrow()
  await expect(run(() => SessionLifecycle.clear(session.id))).rejects.toThrow("transfer")
  await Bun.write(path.join(root, "file.txt"), "frozen bytes")
  expect((await target.run(() => SessionTransfer.activate(proof))).phase).toBe("activated")
})

test("a received private Workspace can be moved onward to a third Host", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using third = await testRuntime()
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "onward.txt"), "retained onward")
  const run = <T>(fn: () => Promise<T>) =>
    source.run(() => directory.scope().then((scope) => ScopeContext.provide({ scope, fn })))
  const session = await run(async () => {
    const workspace = await WorkspaceBinding.register(ScopeContext.current.scope.id, directory.path)
    const session = await Session.create({ workspaceID: workspace.id })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    return session
  })
  const destination = await target.run(() => SessionTransfer.host())
  await run(() => SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() }))
  const first = await target.run(() => run(() => SessionTransfer.archive(session.id)).then(SessionTransfer.stage))
  const proof = await run(() => SessionTransfer.commit(session.id, first))
  await target.run(() => SessionTransfer.activate(proof))
  const moved = await target.run(() => Session.get(session.id))
  const inTarget = <T>(fn: () => Promise<T>) =>
    target.run(() => ScopeContext.provide({ scope: moved.scope, workspace: moved.workspace, fn }))
  const next = await third.run(() => SessionTransfer.host())
  await inTarget(() => SessionTransfer.prepare(session.id, { targetID: next.id, migrationID: crypto.randomUUID() }))
  const second = await third.run(() => inTarget(() => SessionTransfer.archive(session.id)).then(SessionTransfer.stage))
  await third.run(async () =>
    SessionTransfer.activate(await inTarget(() => SessionTransfer.commit(session.id, second))),
  )
  const final = await third.run(() => Session.get(session.id))
  expect(final.id).toBe(session.id)
  expect(final.paused).toBeDefined()
  expect(final.workspaceID).not.toBe(moved.workspaceID)
  expect(await Bun.file(path.join(final.workspace!.path, "onward.txt")).text()).toBe("retained onward")
})

test("an arbitrary directory inside Runtime data remains ineligible", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const run = <T>(fn: () => Promise<T>) =>
    source.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn }))
  const session = await run(async () => {
    const directory = path.join(Global.Path.data, "forbidden-workspace")
    await fs.mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, "private.txt"), "must not capture")
    const workspace = await WorkspaceBinding.register("home", directory)
    const session = await Session.create({ workspaceID: workspace.id })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
    return session
  })
  const destination = await target.run(() => SessionTransfer.host())
  await expect(
    run(() => SessionTransfer.prepare(session.id, { targetID: destination.id, migrationID: crypto.randomUUID() })),
  ).rejects.toThrow("overlaps Runtime")
})
