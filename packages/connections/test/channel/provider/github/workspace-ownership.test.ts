import { afterAll, expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { externalIdentityHash } from "@ericsanchezok/synergy-harness/util/identity"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { GithubChannelWorkspace } from "../../../../src/channel/provider/github/workspace"
import { testRuntime } from "../../../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(directory: string, scopeID: string) {
  const accountId = crypto.randomUUID()
  const repository = "fixture/project"
  const hash = new Bun.CryptoHasher("sha256").update(`${repository}#1`).digest("hex").slice(0, 16)
  const workspace = (await WorkspaceCatalog.list(scopeID)).find((item) => item.binding.path === directory)
  const record = {
    workspaceID: workspace?.id,
    workspaceHash: hash,
    repository,
    issueNumber: 1,
    directory,
    scopeID,
    createdAt: 1,
    updatedAt: 1,
  }
  await Storage.write(StoragePath.githubChannelWorkspaceIndexEntry(externalIdentityHash(accountId), hash), record)
  return { accountId, repository, issueNumber: 1 }
}

test("GitHub checkout expiry waits for native Workspace use and preserves its stable identity", () =>
  runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    const scope = await directory.scope()
    const workspace = await WorkspaceBinding.register(scope.id, directory.path)
    const input = await fixture(directory.path, scope.id)
    const git = Bun.spawn(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: directory.path,
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await git.exited).toBe(0)
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const active = WorkspaceAccess.task({ workspace: WorkspaceCatalog.projection(workspace) }, async () => {
      ready.resolve()
      await release.promise
    })
    try {
      await ready.promise
      expect(await GithubChannelWorkspace.sweep({ accountId: input.accountId, workspaceTtlHours: 1 })).toBe(0)
      expect((await fs.stat(directory.path)).isDirectory()).toBe(true)
    } finally {
      release.resolve()
      await active
    }
    expect(await GithubChannelWorkspace.sweep({ accountId: input.accountId, workspaceTtlHours: 1 })).toBe(1)
    expect((await GithubChannelWorkspace.find(input))?.scopeID).toBe(scope.id)
    expect((await WorkspaceCatalog.get(workspace.id, scope.id)).id).toBe(workspace.id)
    expect(await fs.lstat(directory.path).catch(() => null)).toBeNull()
  }))

test("GitHub expiry refuses a replaced Workspace and unverified imported checkout records", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    await WorkspaceBinding.register(scope.id, directory.path)
    const input = await fixture(directory.path, scope.id)
    const original = directory.path + "-original"
    await fs.rename(directory.path, original)
    try {
      await fs.mkdir(directory.path)
      await fs.writeFile(path.join(directory.path, "new-owner"), "keep")
      expect(await GithubChannelWorkspace.sweep({ accountId: input.accountId, workspaceTtlHours: 1 })).toBe(0)
      expect(await fs.readFile(path.join(directory.path, "new-owner"), "utf8")).toBe("keep")
      const unverified = await fixture(original, scope.id)
      expect(await GithubChannelWorkspace.sweep({ accountId: unverified.accountId, workspaceTtlHours: 1 })).toBe(0)
      expect((await fs.stat(original)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(original, { recursive: true, force: true })
    }
  }))

test("GitHub ensure keeps a busy checkout before issuing Git or replacing its directory", () =>
  runtime.run(async () => {
    await using root = await tmpdir()
    const input = {
      accountId: crypto.randomUUID(),
      workspaceDir: root.path,
      repository: "fixture/project",
      issueNumber: 1,
      token: "fixture-only-token",
      workspaceTtlHours: 1,
    }
    const directory = GithubChannelWorkspace.resolveDirectory(input)
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "keep"), "active")
    const project = (await Scope.fromDirectory(directory)).scope
    const workspace = await WorkspaceBinding.register(project.id, directory)
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const active = WorkspaceAccess.task({ workspace: WorkspaceCatalog.projection(workspace) }, async () => {
      ready.resolve()
      await release.promise
    })
    try {
      await ready.promise
      await expect(GithubChannelWorkspace.ensure(input)).rejects.toThrow("busy")
      expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("active")
    } finally {
      release.resolve()
      await active
    }
  }))

test(
  "native GitHub checkouts keep two sessions isolated and rebind only the expired directory",
  () =>
    runtime.run(async () => {
      await using source = await tmpdir({ git: true }),
        root = await tmpdir()
      const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: source.path }).stdout.toString().trim()
      await using isolated = await testRuntime({
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.file://${source.path}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/fixture/project.git",
          GIT_ALLOW_PROTOCOL: "file",
        },
      })
      await isolated.run(async () => {
        const input = {
          accountId: crypto.randomUUID(),
          workspaceDir: root.path,
          repository: "fixture/project",
          token: "fixture-only-token",
          defaultBranch: branch,
          workspaceTtlHours: 1,
        }
        const failed = { ...input, issueNumber: 3, defaultBranch: "branch-does-not-exist" }
        await expect(GithubChannelWorkspace.ensure(failed)).rejects.toThrow("checkout failed")
        expect(await fs.lstat(GithubChannelWorkspace.resolveDirectory(failed)).catch(() => null)).toBeNull()
        const recovered = await GithubChannelWorkspace.ensure({ ...input, issueNumber: 3 })
        expect(await WorkspaceBinding.validate(recovered.record.workspaceID!, recovered.scope.id)).toBeDefined()
        const first = await GithubChannelWorkspace.ensure({ ...input, issueNumber: 1 })
        const second = await GithubChannelWorkspace.ensure({ ...input, issueNumber: 2 })
        expect(first.record.directory).not.toBe(second.record.directory)
        expect(first.record.workspaceID).not.toBe(second.record.workspaceID)
        const Session = (await import("@ericsanchezok/synergy-harness/session")).Session
        const ScopeContext = (await import("@ericsanchezok/synergy-harness/scope/context")).ScopeContext
        const a = await ScopeContext.provide({ scope: first.scope, fn: () => Session.create({}) })
        const b = await ScopeContext.provide({ scope: second.scope, fn: () => Session.create({}) })
        expect(a.workspaceID).toBe(first.record.workspaceID!)
        expect(b.workspaceID).toBe(second.record.workspaceID!)
        const before = await WorkspaceCatalog.get(first.record.workspaceID!, first.scope.id)
        await Storage.write(
          StoragePath.githubChannelWorkspaceIndexEntry(
            externalIdentityHash(input.accountId),
            first.record.workspaceHash,
          ),
          { ...first.record, updatedAt: 1 },
        )
        const recreated = await GithubChannelWorkspace.ensure({ ...input, issueNumber: 1 })
        expect(recreated.record.workspaceID).toBe(first.record.workspaceID)
        const after = await WorkspaceBinding.validate(recreated.record.workspaceID!, recreated.scope.id)
        expect(after.generation).toBe(before.binding.generation + 1)
        await expect(WorkspaceBinding.validate(before.id, before.scopeID, before.binding.generation)).rejects.toThrow()
        expect((await Session.get(a.id)).workspaceID).toBe(before.id)
        expect((await WorkspaceBinding.validate(b.workspaceID!, second.scope.id)).generation).toBe(1)
        const work = path.join(first.record.directory, "uncommitted.txt")
        await fs.writeFile(work, "preserve edits")
        await expect(GithubChannelWorkspace.ensure({ ...input, issueNumber: 1 })).rejects.toThrow("local work")
        expect(await fs.readFile(work, "utf8")).toBe("preserve edits")
        expect(await GithubChannelWorkspace.sweep({ accountId: input.accountId, workspaceTtlHours: 1 })).toBe(0)
        await Session.remove(a.id)
        await Session.remove(b.id)
      })
    }),
  30_000,
)

test("a recreated GitHub checkout advances its generation even when the filesystem reuses its identity", () =>
  runtime.run(async () => {
    await using source = await tmpdir({ git: true }),
      root = await tmpdir()
    const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: source.path }).stdout.toString().trim()
    await using isolated = await testRuntime({
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${source.path}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/fixture/project.git",
        GIT_ALLOW_PROTOCOL: "file",
      },
    })
    await isolated.run(async () => {
      const input = {
        accountId: crypto.randomUUID(),
        workspaceDir: root.path,
        repository: "fixture/project",
        issueNumber: 1,
        token: "fixture-only-token",
        defaultBranch: branch,
        workspaceTtlHours: 1,
      }
      const first = await GithubChannelWorkspace.ensure(input)
      const before = await WorkspaceCatalog.get(first.record.workspaceID!, first.scope.id)
      const location = isolated.host.workspaceLocation!
      const identify = location.identify.bind(location)
      const identity = spyOn(location, "identify").mockImplementation(async (directory, allowMissing) => {
        const current = await identify(directory, allowMissing)
        return current.path === first.record.directory && current.physicalID
          ? { ...current, physicalID: before.binding.physicalID }
          : current
      })
      try {
        const reused = await GithubChannelWorkspace.ensure(input)
        expect((await WorkspaceBinding.validate(reused.record.workspaceID!, reused.scope.id)).generation).toBe(
          before.binding.generation,
        )
        await Storage.write(
          StoragePath.githubChannelWorkspaceIndexEntry(
            externalIdentityHash(input.accountId),
            first.record.workspaceHash,
          ),
          { ...reused.record, updatedAt: 1 },
        )
        const recreated = await GithubChannelWorkspace.ensure(input)
        const after = await WorkspaceCatalog.get(recreated.record.workspaceID!, recreated.scope.id)
        expect(after.id).toBe(before.id)
        expect(after.binding.physicalID).toBe(before.binding.physicalID)
        expect(after.binding.generation).toBe(before.binding.generation + 1)
        await expect(WorkspaceBinding.validate(before.id, before.scopeID, before.binding.generation)).rejects.toThrow(
          "binding changed",
        )
        expect((await WorkspaceBinding.validate(after.id, after.scopeID)).generation).toBe(after.binding.generation)
      } finally {
        identity.mockRestore()
      }
    })
  }))

test("GitHub delivery rejects another selected Workspace before contacting GitHub", () =>
  runtime.run(async () => {
    await using directory = await tmpdir(),
      other = await tmpdir()
    const scope = await directory.scope()
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
    const { SessionEndpoint } = await import("@ericsanchezok/synergy-harness/session/endpoint")
    const { GithubProvider } = await import("../../../../src/channel/provider/github")
    await WorkspaceBinding.register(scope.id, directory.path)
    const input = await fixture(directory.path, scope.id)
    const workspace = await WorkspaceBinding.register(scope.id, other.path)
    await ScopeContext.provide({
      scope,
      async fn() {
        const session = await Session.create({
          workspaceID: workspace.id,
          endpoint: SessionEndpoint.fromChannel({
            type: "github",
            accountId: input.accountId,
            chatId: `${input.repository}#1`,
            chatType: "group",
          }),
        })
        try {
          await expect(
            new GithubProvider().deliverFix({
              sessionID: session.id,
              branch: "synergy/fix/test",
              title: "test",
              body: "test",
            }),
          ).rejects.toThrow("selected Workspace")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  }))

test("GitHub delivery pins the selected Workspace until its external request settles", () =>
  runtime.run(async () => {
    await using directory = await tmpdir(),
      other = await tmpdir()
    const scope = await directory.scope()
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
    const { SessionEndpoint } = await import("@ericsanchezok/synergy-harness/session/endpoint")
    const { GithubProvider } = await import("../../../../src/channel/provider/github")
    const { GitHubChannelAuth } = await import("../../../../src/channel/provider/github/api")
    const workspace = await WorkspaceBinding.register(scope.id, directory.path)
    const destination = await WorkspaceBinding.register(scope.id, other.path)
    const input = await fixture(directory.path, scope.id)
    const waiting = Promise.withResolvers<void>()
    const response = Promise.withResolvers<never>()
    const jwt = spyOn(GitHubChannelAuth, "generateJWT").mockReturnValue("fixture-jwt")
    const send = spyOn(GitHubChannelAuth.GitHubClient, "send").mockImplementation(() => {
      waiting.resolve()
      return response.promise
    })
    try {
      await ScopeContext.provide({
        scope,
        async fn() {
          const session = await Session.create({
            workspaceID: workspace.id,
            endpoint: SessionEndpoint.fromChannel({
              type: "github",
              accountId: input.accountId,
              chatId: `${input.repository}#1`,
              chatType: "group",
            }),
          })
          try {
            const delivered = new GithubProvider()
              .deliverFix({ sessionID: session.id, branch: "synergy/fix/test", title: "test", body: "test" })
              .catch((error: unknown) => error)
            await waiting.promise
            let changed = false
            const selection = Session.updateWorkspace(
              session.id,
              await WorkspaceBinding.validate(destination.id, scope.id),
            ).then(() => {
              changed = true
            })
            await Bun.sleep(50)
            expect(changed).toBe(false)
            response.reject(new Error("fixture request ended"))
            expect(await delivered).toBeInstanceOf(Error)
            await selection
            expect((await Session.get(session.id)).workspaceID).toBe(destination.id)
          } finally {
            response.reject(new Error("fixture ended"))
            await Session.remove(session.id)
          }
        },
      })
    } finally {
      jwt.mockRestore()
      send.mockRestore()
    }
  }))
