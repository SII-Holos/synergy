import { expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { Worktree } from "../../src/workspace/worktree"

async function fixture(run: (root: string) => Promise<void>) {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir({ git: true })
  await runtime.run(async () => {
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(tmp.path).quiet()
    await ScopeContext.provide({ scope: await tmp.scope(), fn: () => run(tmp.path) })
  })
}

async function present(directory: string) {
  return fs.stat(directory).then(
    () => true,
    () => false,
  )
}

test(
  "running owner archives its checkout without archiving or stopping the conversation",
  () =>
    fixture(async (root) => {
      const session = await Session.create()
      const tree = await Worktree.create({
        name: "owner-archive",
        baseRef: "current",
        sessionID: session.id,
        bind: true,
      })
      const selected = await Session.get(session.id)
      const lease = SessionManager.acquire(session.id)!
      try {
        await ScopeContext.provide({
          scope: selected.scope,
          workspace: selected.workspace,
          fn: () =>
            WorkspaceAccess.task({ sessionID: session.id, workspace: selected.workspace }, async () => {
              const result = await Worktree.archive({ sessionID: session.id, target: tree.id })
              expect(result.cleanup).toEqual({ performed: true })
              expect(ScopeContext.current.directory).toBe(root)
              expect(SessionManager.isRunning(session.id)).toBe(true)
              expect((await Session.get(session.id)).time.archived).toBeUndefined()
              await WorkspaceAccess.write([root], () =>
                Bun.write(path.join(root, "after-archive.txt"), "still running"),
              )
            }),
        })
      } finally {
        await SessionManager.release(lease)
      }
      expect(await present(tree.path)).toBe(false)
      expect((await $`git rev-parse --verify refs/heads/${tree.branch}`.cwd(root).quiet().nothrow()).exitCode).toBe(0)
      expect((await Session.get(session.id)).workspace?.path).toBe(root)
    }),
  20_000,
)

test.each(["dirty", "ignored_files", "local_only_commits", "foreign_lock"] as const)(
  "archive keeps checkout with %s and returns its reason",
  (reason) =>
    fixture(async (root) => {
      const session = await Session.create()
      const tree = await Worktree.create({ name: reason, baseRef: "current", sessionID: session.id, bind: true })
      if (reason === "dirty") await Bun.write(path.join(tree.path, "wip.txt"), "keep")
      if (reason === "ignored_files") {
        await fs.appendFile(path.join(root, ".git/info/exclude"), "\nprivate.bin\n")
        await Bun.write(path.join(tree.path, "private.bin"), new Uint8Array([0, 1, 2]))
      }
      if (reason === "local_only_commits") {
        await $`git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m local-only`
          .cwd(tree.path)
          .quiet()
      }
      if (reason === "foreign_lock") await $`git worktree lock --reason pinned ${tree.path}`.cwd(root).quiet()
      const result = await Worktree.archive({ sessionID: session.id, target: tree.id })
      expect(result.cleanup).toMatchObject({ performed: false, reason })
      expect(await present(tree.path)).toBe(true)
      expect((await Session.get(session.id)).workspace?.path).toBe(root)
      expect((await Worktree.resolve(tree.id)).lifecycle).toBe("gc_candidate")
      const sweep = await Worktree.sweep({ maxManaged: 0 })
      expect(sweep.skipped).toContainEqual({ id: tree.id, name: tree.name, reason })
      expect(await present(tree.path)).toBe(true)
      if (reason !== "foreign_lock") {
        await Worktree.enter({ sessionID: session.id, target: tree.id })
        expect((await Worktree.resolve(tree.id)).lifecycle).toBe("active")
      }
    }),
)

test("archive migrates idle, child and archived canonical references missing from registry", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "references", baseRef: "current", sessionID: owner.id, bind: true })
    const workspace = (await Session.get(owner.id)).workspace
    const child = await Session.create({ parentID: owner.id, workspace })
    const archived = await Session.create({ workspace })
    await Session.update(archived.id, (draft) => {
      draft.time.archived = Date.now()
    })
    expect((await Worktree.resolve(tree.id)).bindings).not.toContain(archived.id)
    const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
    expect(result.cleanup.performed).toBe(true)
    for (const id of [owner.id, child.id, archived.id]) expect((await Session.get(id)).workspace?.path).toBe(root)
    expect((await Session.get(archived.id)).time.archived).toBeDefined()
  }))

test("competing running session preserves checkout while caller leaves", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "busy", baseRef: "current", sessionID: owner.id, bind: true })
    const other = await Session.create({ workspace: (await Session.get(owner.id)).workspace })
    const lease = SessionManager.acquire(other.id)!
    try {
      const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
      expect(result.cleanup).toMatchObject({ performed: false, reason: "running" })
      expect((await Session.get(owner.id)).workspace?.path).toBe(root)
      expect((await Session.get(other.id)).workspace?.path).toBe(tree.path)
      expect(await present(tree.path)).toBe(true)
    } finally {
      await SessionManager.release(lease)
    }
  }))

test.each(["cross-scope", "nested-directory"] as const)(
  "archive and cap cleanup retain a checkout with a %s lazy running reference",
  (reference) =>
    fixture(async (root) => {
      const owner = await Session.create()
      const tree = await Worktree.create({ name: reference, baseRef: "current", sessionID: owner.id, bind: true })
      const ownerWorkspaceID = (await Session.get(owner.id)).workspaceID!
      await using otherRoot = await tmpdir({ git: true })
      const scope = reference === "cross-scope" ? await otherRoot.scope() : owner.scope
      const directory = reference === "cross-scope" ? tree.path : path.join(tree.path, "subproject")
      if (reference === "nested-directory") await fs.mkdir(directory)
      const ready = Promise.withResolvers<Session.Info>()
      const release = Promise.withResolvers<void>()
      const use = ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          const other = await Session.create({ workspace: { type: "main", path: directory, scopeID: scope.id } })
          const lease = SessionManager.acquire(other.id)!
          try {
            await WorkspaceAccess.task({ sessionID: other.id, workspace: other.workspace, lazy: true }, async () => {
              ready.resolve(other)
              await release.promise
              expect((await Session.get(other.id)).workspace?.path).toBe(directory)
              expect(SessionManager.isRunning(other.id)).toBe(true)
            })
          } finally {
            await SessionManager.release(lease)
          }
        },
      })
      const other = await ready.promise
      try {
        const archived = await Worktree.archive({ sessionID: owner.id, target: tree.id })
        expect(archived.cleanup).toMatchObject({ performed: false, reason: "referenced" })
        expect(archived.cleanup.state).toBeUndefined()
        expect((await Session.get(owner.id)).workspace?.path).toBe(root)
        expect(await present(tree.path)).toBe(true)
        expect((await WorkspaceCatalog.get(ownerWorkspaceID, owner.scope.id)).lifecycle).toBe("active")
        const sweep = await Worktree.sweep({ maxManaged: 0 })
        expect(sweep.removed).not.toContain(tree.id)
        expect(await present(directory)).toBe(true)
        expect((await WorkspaceCatalog.get(other.workspaceID!, scope.id)).lifecycle).toBe("active")
      } finally {
        release.resolve()
        await use
      }
    }),
  30_000,
)

test.each(["archive", "cap cleanup"] as const)(
  "%s ignores same-Scope unbound historical worktree authority",
  (operation) =>
    fixture(async (root) => {
      const owner = await Session.create()
      const tree = await Worktree.create({
        name: "imported-history",
        baseRef: "current",
        sessionID: owner.id,
        bind: true,
      })
      const workspaceID = (await Session.get(owner.id)).workspaceID!
      const authority = await WorkspaceCatalog.get(workspaceID, owner.scope.id)
      const imported = await WorkspaceCatalog.importRecord(authority)
      expect(imported.id).not.toBe(authority.id)
      expect(imported.binding.state).toBe("unbound")
      expect(imported.metadata.worktreeID).toBe(tree.id)
      if (operation === "archive") {
        const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
        expect(result.cleanup).toEqual({ performed: true })
      } else {
        await Worktree.leave(owner.id)
        const result = await Worktree.sweep({ maxManaged: 0 })
        expect(result.removed).toContain(tree.id)
      }
      expect(await present(tree.path)).toBe(false)
      expect((await Session.get(owner.id)).workspace?.path).toBe(root)
      expect((await WorkspaceCatalog.get(authority.id, owner.scope.id)).lifecycle).toBe("deleted")
      expect(await WorkspaceCatalog.get(imported.id, owner.scope.id)).toEqual(imported)
      await expect(
        WorkspaceCatalog.resolve(imported.id, { scopeID: owner.scope.id, hostID: authority.binding.hostID }),
      ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
    }),
  30_000,
)

test.each([
  ["archive", "imported"],
  ["cap cleanup", "imported"],
  ["missing-directory recovery", "imported"],
  ["archive", "foreign-host"],
  ["cap cleanup", "foreign-host"],
  ["missing-directory recovery", "foreign-host"],
] as const)(
  "%s preserves a %s Session's unavailable historical authority",
  (operation, reference) =>
    fixture(async (root) => {
      const owner = await Session.create()
      const tree = await Worktree.create({
        name: "imported-session",
        baseRef: "current",
        sessionID: owner.id,
        bind: true,
      })
      const authority = await WorkspaceCatalog.get((await Session.get(owner.id)).workspaceID!, owner.scope.id)
      const imported =
        reference === "imported"
          ? await WorkspaceCatalog.importRecord(authority)
          : await WorkspaceCatalog.register({
              scopeID: authority.scopeID,
              type: authority.type,
              hostID: "foreign-host",
              path: tree.path,
              physicalID: authority.binding.physicalID,
              metadata: authority.metadata,
            })
      const history = await Session.create({ workspaceID: imported.id })
      expect(history.workspace?.path).toBe(tree.path)
      await expect(Session.assertWorkspaceAvailable(history.id)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
      if (operation === "archive") {
        const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
        expect(result.cleanup).toEqual({ performed: true })
      } else {
        await Worktree.leave(owner.id)
        if (operation === "missing-directory recovery") await fs.rm(tree.path, { recursive: true })
        const result = await Worktree.sweep({ maxManaged: 0 })
        expect(operation === "cap cleanup" ? result.removed : result.reconciled).toContain(tree.id)
      }
      expect(await present(tree.path)).toBe(false)
      expect((await Session.get(owner.id)).workspace?.path).toBe(root)
      expect((await Session.get(history.id)).workspaceID).toBe(imported.id)
      expect((await Session.get(history.id)).workspace?.bindingState).toBe(imported.binding.state)
      expect(await WorkspaceCatalog.get(imported.id, owner.scope.id)).toEqual(imported)
      await expect(Session.assertWorkspaceAvailable(history.id)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
    }),
  30_000,
)

test("historical caller cannot acquire source checkout authority by archiving its stored path", () =>
  fixture(async () => {
    const owner = await Session.create()
    const tree = await Worktree.create({
      name: "historical-caller",
      baseRef: "current",
      sessionID: owner.id,
      bind: true,
    })
    const authority = await WorkspaceCatalog.get((await Session.get(owner.id)).workspaceID!, owner.scope.id)
    const imported = await WorkspaceCatalog.importRecord(authority)
    const history = await Session.create({ workspaceID: imported.id })
    const result = await Worktree.archive({ sessionID: history.id, target: tree.id })
    expect(result.cleanup.performed).toBe(false)
    expect(result.restored).toBeUndefined()
    expect((await Session.get(history.id)).workspaceID).toBe(imported.id)
    await expect(Session.assertWorkspaceAvailable(history.id)).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
    expect(await present(tree.path)).toBe(true)
    expect(await WorkspaceCatalog.get(imported.id, owner.scope.id)).toEqual(imported)
    expect((await Session.get(owner.id)).workspaceID).toBe(authority.id)
  }))

test(
  "archive rechecks a Session selection changed after canonical census",
  () =>
    fixture(async (root) => {
      const owner = await Session.create()
      const tree = await Worktree.create({ name: "census-race", baseRef: "current", sessionID: owner.id, bind: true })
      const selected = await Session.get(owner.id)
      const idle = await Session.create({ workspace: selected.workspace })
      const sibling = await Worktree.create({ name: "census-destination", baseRef: "current", bind: false })
      const destination = await Session.create({
        workspace: { type: "main", path: sibling.path, scopeID: owner.scope.id },
      })
      const list = Session.listAll
      let changed = false
      using census = spyOn(Session, "listAll").mockImplementation(async function* () {
        const snapshot = []
        for await (const session of list()) snapshot.push(session)
        if (!changed && (await WorkspaceCatalog.get(selected.workspaceID!, owner.scope.id)).lifecycle === "deleting") {
          changed = true
          await Session.updateWorkspace(idle.id, destination.workspace!)
        }
        yield* snapshot
      })
      const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
      expect(changed).toBe(true)
      expect(result.cleanup).toEqual({ performed: true })
      expect((await Session.get(idle.id)).workspaceID).toBe(destination.workspaceID)
      expect((await Session.get(idle.id)).workspace?.path).toBe(sibling.path)
      expect((await Session.get(owner.id)).workspace?.path).toBe(root)
      expect(await present(sibling.path)).toBe(true)
    }),
  20_000,
)

test("anonymous native resource use prevents deletion without rolling back the caller", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "occupied", baseRef: "current", sessionID: owner.id, bind: true })
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const use = WorkspaceAccess.task({ workspace: (await Session.get(owner.id)).workspace }, async () => {
      ready.resolve()
      await release.promise
    })
    await ready.promise
    try {
      const result = await Worktree.archive({ sessionID: owner.id, target: tree.id })
      expect(result.cleanup.performed).toBe(false)
      expect(result.cleanup.reason).toBe("removal_failed")
      expect((await Session.get(owner.id)).workspace?.path).toBe(root)
      expect(await present(tree.path)).toBe(true)
    } finally {
      release.resolve()
      await use
    }
  }))

test("cancelled archive preserves binding and filesystem before effects", () =>
  fixture(async () => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "cancelled", baseRef: "current", sessionID: owner.id, bind: true })
    const controller = new AbortController()
    controller.abort(new Error("cancel archive"))
    await expect(
      WorkspaceAccess.task({ signal: controller.signal }, () =>
        Worktree.archive({ sessionID: owner.id, target: tree.id }),
      ),
    ).rejects.toThrow("cancel archive")
    expect((await Session.get(owner.id)).workspace?.path).toBe(tree.path)
    expect(await present(tree.path)).toBe(true)
  }))

test("main and external worktrees cannot be archived", () =>
  fixture(async (root) => {
    const session = await Session.create()
    await expect(Worktree.archive({ sessionID: session.id, target: root })).rejects.toThrow("managed")
    const external = path.join(root, "external")
    await $`git worktree add -b external ${external}`.cwd(root).quiet()
    await expect(Worktree.archive({ sessionID: session.id, target: external })).rejects.toThrow("managed")
    expect(await present(external)).toBe(true)
    expect((await Session.get(session.id)).workspace?.path).toBe(root)
  }))

test("janitor retries archived candidates below the cap and preserves the branch", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "retry", baseRef: "current", sessionID: owner.id, bind: true })
    await Bun.write(path.join(tree.path, "wip.txt"), "keep")
    const archive = await Worktree.archive({ sessionID: owner.id, target: tree.id })
    expect(archive.cleanup).toMatchObject({ performed: false, reason: "dirty" })
    await fs.unlink(path.join(tree.path, "wip.txt"))
    const idle = await Session.create({
      workspace: {
        ...(await Session.get(owner.id)).workspace!,
        type: "git_worktree",
        path: tree.path,
        worktreeID: tree.id,
      },
    })
    const report = await Worktree.sweep()
    expect(report.removed).toContain(tree.id)
    expect(await present(tree.path)).toBe(false)
    expect((await Session.get(idle.id)).workspace?.path).toBe(root)
    expect((await $`git rev-parse --verify refs/heads/${tree.branch}`.cwd(root).quiet().nothrow()).exitCode).toBe(0)
  }))

test("a failed Catalog completion remains fenced until a missing-directory sweep reconciles it", () =>
  fixture(async () => {
    const owner = await Session.create()
    const tree = await Worktree.create({
      name: "completion-failure",
      baseRef: "current",
      sessionID: owner.id,
      bind: true,
    })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    const complete = WorkspaceCatalog.completeRetirement
    using fault = spyOn(WorkspaceCatalog, "completeRetirement").mockImplementation(async (records, lifecycle) => {
      if (lifecycle === "deleted") throw new Error("Catalog completion unavailable")
      return complete(records, lifecycle)
    })
    const archived = await Worktree.archive({ sessionID: owner.id, target: tree.id })
    expect(archived.cleanup.performed).toBe(true)
    expect(archived.cleanup.error).toContain("Catalog completion unavailable")
    expect(await present(tree.path)).toBe(false)
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleting")
    fault.mockRestore()
    expect((await Worktree.sweep()).reconciled).toContain(tree.id)
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleted")
    expect((await Worktree.list()).some((entry) => entry.id === tree.id)).toBe(false)
  }))

test("directory replacement after fencing never restores active authority or deletes new bytes", () =>
  fixture(async () => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "replacement", baseRef: "current", sessionID: owner.id, bind: true })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    const retire = WorkspaceAccess.retire
    let replaced = false
    using fault = spyOn(WorkspaceAccess, "retire").mockImplementation(async (roots, fn, options) => {
      if (!replaced && roots.includes(tree.path)) {
        replaced = true
        await fs.rename(tree.path, `${tree.path}-original`)
        await fs.mkdir(tree.path)
        await Bun.write(path.join(tree.path, "replacement.txt"), "foreign bytes")
      }
      return retire(roots, fn, options)
    })
    const archived = await Worktree.archive({ sessionID: owner.id, target: tree.id })
    expect(replaced).toBe(true)
    expect(archived.cleanup).toMatchObject({ performed: false, state: "unknown" })
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleting")
    expect(await Bun.file(path.join(tree.path, "replacement.txt")).text()).toBe("foreign bytes")
    expect(await present(`${tree.path}-original`)).toBe(true)
    expect((await Worktree.sweep()).removed).not.toContain(tree.id)
    expect(await Bun.file(path.join(tree.path, "replacement.txt")).text()).toBe("foreign bytes")
    expect((await Worktree.archive({ sessionID: owner.id, target: tree.id })).cleanup).toMatchObject({
      performed: false,
      state: "unknown",
    })
  }))

test("cancel after fencing restores only verified authority and does not roll the caller back", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "fenced-cancel", baseRef: "current", sessionID: owner.id, bind: true })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    const begin = WorkspaceCatalog.beginRetirement
    const controller = new AbortController()
    using fault = spyOn(WorkspaceCatalog, "beginRetirement").mockImplementation(async (records) => {
      const fence = await begin(records)
      controller.abort(new Error("cancel after fence"))
      return fence
    })
    await expect(Worktree.archive({ sessionID: owner.id, target: tree.id, signal: controller.signal })).rejects.toThrow(
      "cancel after fence",
    )
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("active")
    expect((await Session.get(owner.id)).workspace?.path).toBe(root)
    expect(await present(tree.path)).toBe(true)
  }))

test(
  "dirty retry of an uncertain retirement restores authority only under a verified native claim",
  () =>
    fixture(async () => {
      const owner = await Session.create()
      const tree = await Worktree.create({ name: "fenced-retry", baseRef: "current", sessionID: owner.id, bind: true })
      const workspaceID = (await Session.get(owner.id)).workspaceID!
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const use = WorkspaceAccess.task({ workspace: (await Session.get(owner.id)).workspace }, async () => {
        ready.resolve()
        await release.promise
      })
      await ready.promise
      try {
        const archived = await Worktree.archive({ sessionID: owner.id, target: tree.id })
        expect(archived.cleanup).toMatchObject({ performed: false, state: "unknown" })
        expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleting")
      } finally {
        release.resolve()
        await use
      }
      await Bun.write(path.join(tree.path, "wip.txt"), "retained work")
      const report = await Worktree.sweep()
      expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "dirty" })
      expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("active")
      expect(await Bun.file(path.join(tree.path, "wip.txt")).text()).toBe("retained work")
    }),
  20_000,
)

test("a committed Catalog completion with a lost acknowledgement still reconciles stale registry metadata", () =>
  fixture(async () => {
    const owner = await Session.create()
    const tree = await Worktree.create({
      name: "committed-completion",
      baseRef: "current",
      sessionID: owner.id,
      bind: true,
    })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    const complete = WorkspaceCatalog.completeRetirement
    using fault = spyOn(WorkspaceCatalog, "completeRetirement").mockImplementation(async (records, lifecycle) => {
      const result = await complete(records, lifecycle)
      if (lifecycle === "deleted") throw new Error("Completion acknowledgement lost")
      return result
    })
    const archived = await Worktree.archive({ sessionID: owner.id, target: tree.id })
    expect(archived.cleanup.performed).toBe(true)
    expect(archived.cleanup.error).toContain("Completion acknowledgement lost")
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleted")
    fault.mockRestore()
    expect((await Worktree.sweep()).reconciled).toContain(tree.id)
    expect((await Worktree.list()).some((entry) => entry.id === tree.id)).toBe(false)
  }))

test("deleted Sessions left in the registry are stale hints rather than reclamation blockers", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "stale-hint", baseRef: "current", sessionID: owner.id, bind: true })
    const idle = await Session.create({ workspace: (await Session.get(owner.id)).workspace })
    const registry = path.join(root, ".synergy/worktrees/.registry", `${tree.id}.json`)
    const metadata = await Bun.file(registry).json()
    metadata.bindings.push(idle.id)
    await Session.remove(idle.id)
    await Bun.write(registry, JSON.stringify(metadata))
    expect((await Worktree.archive({ sessionID: owner.id, target: tree.id })).cleanup.performed).toBe(true)
    expect(await present(tree.path)).toBe(false)
  }))

test("below-cap reporting enumerates canonical Sessions once for multiple worktrees", () =>
  fixture(async () => {
    await Worktree.create({ name: "report-one", baseRef: "current", bind: false })
    await Worktree.create({ name: "report-two", baseRef: "current", bind: false })
    await Worktree.create({ name: "report-three", baseRef: "current", bind: false })
    using reads = spyOn(Session, "listAll")
    const report = await Worktree.sweep()
    expect(report.removed).toEqual([])
    expect(reads).toHaveBeenCalledTimes(1)
  }))

test("post-delete Session read failures retain the fence and registry for reconciliation", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "read-recovery", baseRef: "current", sessionID: owner.id, bind: true })
    const selected = await Session.get(owner.id)
    const idle = await Session.create({ workspace: selected.workspace })
    const get = Session.get
    let injected = false
    using fault = spyOn(Session, "get").mockImplementation(
      Object.assign(
        async (id: string) => {
          if (!injected && id === idle.id && !(await present(tree.path))) {
            injected = true
            throw new Error("Canonical Session read unavailable")
          }
          return get(id)
        },
        { force: get.force, schema: get.schema },
      ),
    )
    const report = await Worktree.sweep({ maxManaged: 0 })
    expect(injected).toBe(true)
    expect(report.removed).toContain(tree.id)
    expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "removal_failed" })
    expect((await WorkspaceCatalog.get(selected.workspaceID!, owner.scope.id)).lifecycle).toBe("deleting")
    expect(await Bun.file(path.join(root, ".synergy/worktrees/.registry", `${tree.id}.json`)).exists()).toBe(true)
    fault.mockRestore()
    expect((await Session.get(idle.id)).workspaceID).toBe(selected.workspaceID)
    expect((await Worktree.sweep()).reconciled).toContain(tree.id)
    expect((await Session.get(idle.id)).workspace?.path).toBe(root)
    expect((await WorkspaceCatalog.get(selected.workspaceID!, owner.scope.id)).lifecycle).toBe("deleted")
  }))

test("creating again after cap reclamation skips the retired catalog location", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({ name: "reuse-name", baseRef: "current", sessionID: owner.id, bind: true })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    expect((await Worktree.sweep({ maxManaged: 0 })).removed).toContain(tree.id)
    expect(
      (await $`git show-ref --verify --quiet refs/heads/${tree.branch}`.cwd(root).quiet().nothrow()).exitCode,
    ).not.toBe(0)
    const restored = await Session.get(owner.id)
    expect(restored.workspace?.path).toBe(root)
    const next = await ScopeContext.provide({
      scope: restored.scope,
      workspace: restored.workspace,
      fn: () => Worktree.create({ name: "reuse-name", baseRef: "current", sessionID: owner.id, bind: true }),
    })
    expect(next.path).not.toBe(tree.path)
    expect(next.id).not.toBe(tree.id)
    expect(await present(next.path)).toBe(true)
    expect((await Session.get(owner.id)).workspaceID).not.toBe(workspaceID)
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("deleted")
  }))
