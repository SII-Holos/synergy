import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DataTransfer } from "../../src/cli/data/transfer"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function mergeWhenIdle(...input: Parameters<typeof DataTransfer.merge>) {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return await DataTransfer.merge(...input)
    } catch (error) {
      if (!(error instanceof WorkspaceAccess.BusyError) || Date.now() >= deadline) throw error
      await Bun.sleep(50)
    }
  }
}

test.each(["external", "managed", "collision", "shared-location", "foreign", "sharing"] as const)(
  "Home relocation verifies and retains Workspace ownership (%s)",
  (kind) =>
    runtime.run(async () => {
      await using tmp = await tmpdir(),
        outside = await tmpdir(),
        occupied = await tmpdir()
      const sourceRoot = path.join(tmp.path, "source")
      const targetRoot = path.join(tmp.path, "target")
      const original =
        kind === "managed" ? path.join(sourceRoot, "data/channel/workspaces/project/workspace") : outside.path
      await fs.mkdir(original, { recursive: true })
      await fs.writeFile(path.join(original, "owned.txt"), "original bytes")
      const sourceHost = createLocalHost({ root: sourceRoot })
      const targetHost = createLocalHost({ root: targetRoot })
      const project = await tmp.scope()
      if (project.type !== "project") throw new Error("Expected a project fixture")
      const scope = {
        ...project,
        local: { directory: original, worktree: original, sandboxes: [original] },
      }
      const source = await StorageBootstrap.prepare({ root: sourceRoot })
      let workspace!: WorkspaceCatalog.Info
      let sessionID!: string
      let agendaID!: string
      try {
        await Storage.provide({ store: source.store, artifactDirectory: path.join(sourceRoot, "data") }, () =>
          ScopeContext.provide({
            scope,
            workspace: null,
            async fn() {
              await Storage.write(["projects", scope.id], { ...scope, futureField: original })
              workspace = await WorkspaceCatalog.register({
                scopeID: scope.id,
                type: "directory",
                hostID: kind === "foreign" ? "foreign-host" : await sourceHost.workspaceLocation!.hostID(),
                ...(await sourceHost.workspaceLocation!.identify(original)),
              })
              if (kind === "sharing") {
                const shared = await WorkspaceCatalog.register({
                  scopeID: scope.id,
                  type: "directory",
                  hostID: workspace.binding.hostID,
                  ...(await sourceHost.workspaceLocation!.identify(occupied.path)),
                })
                workspace = await WorkspaceCatalog.setSharing(workspace.id, {
                  scopeID: scope.id,
                  expectedRevision: workspace.revision,
                  workspaceIDs: [shared.id],
                })
              }
              const session = await Session.create({ workspaceID: workspace.id })
              sessionID = session.id
              await Storage.write(
                ["sessions", scope.id, sessionID, "summary"],
                [
                  {
                    file: "owned.txt",
                    additions: 1,
                    deletions: 0,
                    workspace: { id: workspace.id, root: workspace.binding.path, generation: 1 },
                  },
                ],
              )
              const agenda = await AgendaStore.create({
                title: "Captured ownership",
                prompt: "test",
                createdBy: "user",
                sessionID,
              })
              agendaID = agenda.id
              await Storage.write(["channel", "managed_ownership", "fixture"], {
                scopeID: scope.id,
                directory: original,
                futureField: original,
              })
              await Storage.write(
                ["channel", "providers", "github", "accounts", "fixture", "workspaces", "index", "fixture"],
                { scopeID: scope.id, workspaceID: workspace.id, directory: original, futureField: original },
              )
            },
          }),
        )
        await source.activate()
      } finally {
        await source.store.close()
      }
      const target = await StorageBootstrap.prepare({ root: targetRoot })
      let existing: WorkspaceCatalog.Info | undefined
      try {
        if (kind === "collision" || kind === "shared-location")
          await Storage.provide({ store: target.store, artifactDirectory: path.join(targetRoot, "data") }, async () => {
            if (kind === "collision") {
              existing = {
                ...workspace,
                binding: {
                  ...workspace.binding,
                  hostID: await targetHost.workspaceLocation!.hostID(),
                  ...(await targetHost.workspaceLocation!.identify(occupied.path)),
                },
              }
              await Storage.transaction((tx) => WorkspaceCatalog.writeRelocated(existing!, tx))
            } else {
              existing = await WorkspaceCatalog.register({
                scopeID: scope.id,
                type: "directory",
                hostID: await targetHost.workspaceLocation!.hostID(),
                ...(await targetHost.workspaceLocation!.identify(original)),
              })
            }
          })
        await target.activate()
      } finally {
        await target.store.close()
      }
      await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
      await mergeWhenIdle(sourceRoot, targetRoot, { trusted: true })
      const restored = (await StorageBootstrap.inspect(targetRoot))!
      try {
        const info = await restored.store.read<{ workspaceID: string; scope: typeof scope }>([
          "sessions",
          scope.id,
          sessionID,
          "info",
        ])
        const imported = await restored.store.read<WorkspaceCatalog.Info>(["workspace", info.workspaceID])
        const expectedPath = kind === "managed" ? path.join(targetRoot, path.relative(sourceRoot, original)) : original
        if (kind === "foreign") {
          expect(imported.binding.state).toBe("unbound")
        } else {
          expect(imported.binding).toMatchObject({
            state: "bound",
            hostID: await targetHost.workspaceLocation!.hostID(),
            ...(await targetHost.workspaceLocation!.identify(expectedPath)),
            generation: kind === "managed" ? 2 : 1,
          })
          if (kind === "collision") expect(info.workspaceID).not.toBe(workspace.id)
          if (kind === "shared-location") expect(info.workspaceID).toBe(existing!.id)
        }
        if (kind === "sharing") {
          expect(imported.sharedWritableWorkspaceIDs).toHaveLength(1)
          expect(
            (await restored.store.read<WorkspaceCatalog.Info>(["workspace", imported.sharedWritableWorkspaceIDs[0]]))
              .binding,
          ).toMatchObject({
            state: "bound",
            hostID: await targetHost.workspaceLocation!.hostID(),
            ...(await targetHost.workspaceLocation!.identify(occupied.path)),
          })
        }
        const project = await restored.store.read<typeof scope & { futureField: string }>(["projects", scope.id])
        expect(project.local).toEqual({ directory: expectedPath, worktree: expectedPath, sandboxes: [expectedPath] })
        expect(project.futureField).toBe(original)
        expect(info.scope.local).toEqual(project.local)
        const agenda = await restored.store.read<{ origin: { workspaceID: string; scope: typeof scope } }>([
          "agenda",
          "items",
          scope.id,
          agendaID,
        ])
        expect(agenda.origin.workspaceID).toBe(info.workspaceID)
        expect(agenda.origin.scope.local).toEqual(project.local)
        const summary = await restored.store.read<Array<{ workspace: { root: string; generation: number } }>>([
          "sessions",
          scope.id,
          sessionID,
          "summary",
        ])
        expect(summary[0].workspace).toMatchObject({ root: workspace.binding.path!, generation: 1 })
        const channel = await restored.store.read<{ directory: string; futureField: string }>([
          "channel",
          "managed_ownership",
          "fixture",
        ])
        expect(channel).toMatchObject({ directory: expectedPath, futureField: original })
        const github = await restored.store.read<{ directory: string; workspaceID: string }>([
          "channel",
          "providers",
          "github",
          "accounts",
          "fixture",
          "workspaces",
          "index",
          "fixture",
        ])
        expect(github.directory).toBe(expectedPath)
        expect(github.workspaceID).toBe(info.workspaceID)
        const ids = await restored.store.scan(["workspace"])
        await restored.store.close()
        await mergeWhenIdle(sourceRoot, targetRoot, { trusted: true })
        const repeated = (await StorageBootstrap.inspect(targetRoot))!
        try {
          expect(await repeated.store.scan(["workspace"])).toEqual(ids)
        } finally {
          await repeated.store.close()
        }
      } finally {
        await restored.store.close()
      }
    }),
  30_000,
)

test("Home relocation refuses a replaced native binding and preserves the source", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const sourceRoot = path.join(tmp.path, "source")
    const targetRoot = path.join(tmp.path, "target")
    const directory = path.join(tmp.path, "workspace")
    await fs.mkdir(directory)
    const host = createLocalHost({ root: sourceRoot })
    const scope = await tmp.scope()
    const source = await StorageBootstrap.prepare({ root: sourceRoot })
    try {
      await Storage.provide({ store: source.store, artifactDirectory: path.join(sourceRoot, "data") }, async () => {
        await WorkspaceCatalog.register({
          scopeID: scope.id,
          type: "directory",
          hostID: await host.workspaceLocation!.hostID(),
          ...(await host.workspaceLocation!.identify(directory)),
        })
      })
      await source.activate()
    } finally {
      await source.store.close()
    }
    const target = await StorageBootstrap.prepare({ root: targetRoot })
    await target.activate()
    await target.store.close()
    await fs.rename(directory, directory + "-old")
    await fs.mkdir(directory)
    await using locks = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
    await expect(DataTransfer.merge(sourceRoot, targetRoot, { trusted: true })).rejects.toThrow(
      "Workspace directory changed",
    )
    expect(await fs.stat(sourceRoot).then((stat) => stat.isDirectory())).toBe(true)
  }))

test("Home relocation rejects overlapping locations including native aliases before copying", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "source")
    await fs.mkdir(source)
    const alias = path.join(tmp.path, "alias")
    await fs.symlink(source, alias, process.platform === "win32" ? "junction" : "dir")
    for (const target of [source, path.join(source, "new"), tmp.path, path.join(alias, "new")])
      await expect(DataTransfer.merge(source, target, { trusted: true })).rejects.toThrow("must not overlap")
    expect(await fs.readdir(source)).toEqual([])
  }))

test.each(["source", "target"] as const)(
  "Home transfer refuses an independently active Workspace under the %s Home",
  (kind) =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const sourceRoot = path.join(tmp.path, "source")
      const targetRoot = path.join(tmp.path, "target")
      for (const root of [sourceRoot, targetRoot]) {
        const store = await StorageBootstrap.prepare({ root })
        await store.activate()
        await store.store.close()
      }
      await fs.writeFile(path.join(sourceRoot, "data", "owned-file"), "stable bytes")
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const active = WorkspaceAccess.task(
        { workspace: { type: "directory", scopeID: "home", path: kind === "source" ? sourceRoot : targetRoot } },
        async () => {
          entered.resolve()
          await release.promise
        },
      )
      try {
        await entered.promise
        await using homes = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
        const error = await DataTransfer.merge(sourceRoot, targetRoot, { trusted: true }).then(
          () => undefined,
          (error) => error,
        )
        expect(error).toBeInstanceOf(WorkspaceAccess.BusyError)
        expect(await fs.stat(path.join(targetRoot, "data", "owned-file")).catch(() => undefined)).toBeUndefined()
      } finally {
        release.resolve()
        await active
      }
      await using homes = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
      await mergeWhenIdle(sourceRoot, targetRoot, { trusted: true })
      expect(await fs.readFile(path.join(targetRoot, "data", "owned-file"), "utf8")).toBe("stable bytes")
    }),
)

test.each(["complete", "absolute-common", "external", "target-conflict"] as const)(
  "Home relocation protects copied Git relationships (%s)",
  (kind) =>
    runtime.run(async () => {
      await using tmp = await tmpdir(),
        repository = await tmpdir({ git: true })
      const sourceRoot = path.join(tmp.path, "source")
      const targetRoot = path.join(tmp.path, "target")
      const main = path.join(sourceRoot, "data", "projects", "main")
      const linked =
        kind === "external" ? path.join(tmp.path, "external") : path.join(sourceRoot, "data", "projects", "linked")
      await fs.cp(repository.path, main, { recursive: true })
      const git = async (directory: string, args: string[]) => {
        const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (code !== 0) throw new Error(stderr)
        return stdout
      }
      await git(main, ["worktree", "add", "--detach", linked, "HEAD"])
      const originalLink = await fs.readFile(path.join(linked, ".git"), "utf8")
      if (kind === "absolute-common") {
        const gitdir = originalLink.slice(8).replace(/\r?\n$/, "")
        await fs.writeFile(path.join(gitdir, "commondir"), path.join(main, ".git") + "\n")
        await git(main, ["config", "core.worktree", main])
      }
      const source = await StorageBootstrap.prepare({ root: sourceRoot })
      const host = createLocalHost({ root: sourceRoot })
      let linkedID!: string
      try {
        await Storage.provide({ store: source.store, artifactDirectory: path.join(sourceRoot, "data") }, async () => {
          for (const directory of [main, linked]) {
            const workspace = await WorkspaceCatalog.register({
              scopeID: "home",
              type: directory === linked ? "git_worktree" : "main",
              hostID: await host.workspaceLocation!.hostID(),
              ...(await host.workspaceLocation!.identify(directory)),
              metadata: { originalCheckout: main, futureField: main },
            })
            if (directory === linked) linkedID = workspace.id
          }
        })
        await source.activate()
      } finally {
        await source.store.close()
      }
      const target = await StorageBootstrap.prepare({ root: targetRoot })
      await target.activate()
      await target.store.close()
      const unrelated = path.join(tmp.path, "unrelated.git")
      if (kind === "target-conflict") {
        await fs.writeFile(unrelated, "unrelated Git metadata")
        const extra = path.join(targetRoot, path.relative(sourceRoot, main), ".git", "worktrees", "unrelated")
        await fs.mkdir(extra, { recursive: true })
        await fs.writeFile(path.join(extra, "gitdir"), unrelated + "\n")
      }
      await using homes = await SnapshotArchive.lockHomes([sourceRoot, targetRoot])
      if (kind === "external" || kind === "target-conflict") {
        await expect(DataTransfer.merge(sourceRoot, targetRoot, { trusted: true })).rejects.toThrow(
          kind === "external" ? "external Git metadata" : "unrelated worktrees",
        )
        expect(await fs.readFile(path.join(linked, ".git"), "utf8")).toBe(originalLink)
        expect(path.resolve((await git(linked, ["rev-parse", "--git-common-dir"])).trim())).toBe(
          path.join(main, ".git"),
        )
        if (kind === "target-conflict") expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated Git metadata")
        const unchanged = (await StorageBootstrap.inspect(targetRoot))!
        try {
          expect(await unchanged.store.scan(["workspace"])).toEqual([])
        } finally {
          await unchanged.store.close()
        }
        return
      }
      await mergeWhenIdle(sourceRoot, targetRoot, { trusted: true })
      expect(await fs.readFile(path.join(linked, ".git"), "utf8")).toBe(originalLink)
      expect(path.resolve((await git(linked, ["rev-parse", "--git-common-dir"])).trim())).toBe(path.join(main, ".git"))
      await fs.rename(sourceRoot, sourceRoot + "-preserved")
      const movedMain = path.join(targetRoot, path.relative(sourceRoot, main))
      const movedLinked = path.join(targetRoot, path.relative(sourceRoot, linked))
      const restored = (await StorageBootstrap.inspect(targetRoot))!
      try {
        const workspace = await restored.store.read<WorkspaceCatalog.Info>(["workspace", linkedID])
        expect(workspace.metadata.originalCheckout).toBe(movedMain)
        expect(workspace.metadata.futureField).toBe(main)
      } finally {
        await restored.store.close()
      }
      expect(path.resolve((await git(movedLinked, ["rev-parse", "--git-common-dir"])).trim())).toBe(
        path.join(movedMain, ".git"),
      )
      expect(await git(movedLinked, ["status", "--porcelain"])).toBe("")
      expect(await git(movedMain, ["status", "--porcelain"])).toBe("")
    }),
  30_000,
)
