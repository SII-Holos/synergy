import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog, WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { Worktree } from "../../src/workspace/worktree"

test("explicit source creates in a second repository, inherits only its shared folders and resolves after leaving that source", async () => {
  await using runtime = await testRuntime()
  await using a = await tmpdir({ git: true })
  await using b = await tmpdir({ git: true })
  await using shared = await tmpdir()
  await runtime.run(async () => {
    const scope = await a.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = await WorkspaceBinding.register(scope.id, b.path)
        const extra = await WorkspaceBinding.register(scope.id, shared.path)
        await WorkspaceBinding.setSharing(source.id, {
          scopeID: scope.id,
          expectedRevision: source.revision,
          workspaceIDs: [extra.id],
        })
        const tree = await Worktree.create({
          sourceWorkspaceID: source.id,
          name: "second-repo",
          bind: false,
          baseRef: "current",
        })
        expect(tree.sourceDirectory).toBe(b.path)
        expect(tree.path).toStartWith(b.path)
        const record = (await WorkspaceCatalog.list(scope.id)).find((item) => item.binding.path === tree.path)!
        expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(record)!)).toEqual([
          tree.path,
          shared.path,
        ])
        expect((await Worktree.resolve(tree.id)).sourceDirectory).toBe(b.path)
        await Worktree.remove({ target: tree.id, force: true })
        expect(await Bun.file(`${tree.path}/.git`).exists()).toBe(false)
      },
    })
  })
})

test("default file search includes the shared folder while explicit paths remain scoped", async () => {
  const { GrepTool } = await import("../../src/tools/grep")
  const { GlobTool } = await import("../../src/tools/glob")
  await using runtime = await testRuntime()
  await using main = await tmpdir()
  await using extra = await tmpdir()
  await Bun.write(`${main.path}/main.txt`, "project-marker")
  await Bun.write(`${extra.path}/extra.txt`, "project-marker")
  await runtime.run(async () => {
    const scope = await main.scope()
    const primary = await WorkspaceBinding.register(scope.id, main.path)
    const shared = await WorkspaceBinding.register(scope.id, extra.path)
    await WorkspaceBinding.setSharing(primary.id, {
      scopeID: scope.id,
      expectedRevision: primary.revision,
      workspaceIDs: [shared.id],
    })
    await ScopeContext.provide({
      scope,
      workspace: WorkspaceCatalog.projection(primary),
      fn: async () => {
        const ctx = {
          sessionID: "test",
          messageID: "",
          callID: "",
          agent: PrimaryAgentIdentity.names.general,
          abort: AbortSignal.any([]),
          metadata() {},
          async ask() {},
        }
        const grep = await GrepTool.init()
        expect((await grep.execute({ pattern: "project-marker" }, ctx)).output).toContain(`${extra.path}/extra.txt`)
        expect((await grep.execute({ pattern: "project-marker", path: main.path }, ctx)).output).not.toContain(
          extra.path,
        )
        const glob = await GlobTool.init()
        expect((await glob.execute({ pattern: "*.txt" }, ctx)).output).toContain(`${extra.path}/extra.txt`)
      },
    })
  })
})
