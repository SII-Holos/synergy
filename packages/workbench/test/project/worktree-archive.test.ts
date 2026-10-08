import { expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime as nativeRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { WorktreeArchiveTool } from "../../src/project/tools/worktree-archive"
import { registerProjectTools } from "../../src/project/tools"

async function fixture(
  run: (root: string) => Promise<void>,
  register?: () => void,
  env?: Record<string, string | undefined>,
) {
  await using runtime = await nativeRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        register?.()
      },
    },
  })
  await using repository = await tmpdir({ git: true })
  await runtime.run(async () => {
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(repository.path).quiet()
    await ScopeContext.provide({ scope: await repository.scope(), fn: () => run(repository.path) })
  })
}

function context(sessionID: string, ask: Tool.Context["ask"] = async () => {}) {
  const controller = new AbortController()
  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const captured: unknown[] = []
  const ctx: Tool.Context = {
    sessionID,
    messageID: "archive-test-message",
    callID: "archive-test-call",
    agent: "coding",
    abort: controller.signal,
    metadata() {},
    async ask(request) {
      asked.push(request)
      await ask(request)
    },
    async captureResult(result) {
      captured.push(result)
    },
  }
  return { ctx, controller, asked, captured }
}

async function present(directory: string) {
  return fs.stat(directory).then(
    () => true,
    () => false,
  )
}

test("a foreign-Scope blocker reports a retained checkout without claiming an admission fence", () =>
  fixture(async (root) => {
    const owner = await Session.create()
    const tree = await Worktree.create({
      name: "foreign-scope-receipt",
      baseRef: "current",
      sessionID: owner.id,
      bind: true,
    })
    const workspaceID = (await Session.get(owner.id)).workspaceID!
    await using otherRoot = await tmpdir({ git: true })
    const otherScope = await otherRoot.scope()
    await ScopeContext.provide({
      scope: otherScope,
      workspace: null,
      fn: () => Session.create({ workspace: { type: "main", path: tree.path, scopeID: otherScope.id } }),
    })
    const tool = await WorktreeArchiveTool.init()
    const { ctx } = context(owner.id)
    const result = await tool.execute({}, ctx)
    expect(result.metadata.cleanup).toMatchObject({ performed: false, reason: "referenced" })
    expect(result.metadata.cleanup?.state).toBeUndefined()
    expect(result.output).toContain("Checkout kept")
    expect(result.output).toContain("Re-enter it with worktree_enter")
    expect(result.output).not.toContain("admission remains fenced")
    expect(await present(tree.path)).toBe(true)
    expect((await WorkspaceCatalog.get(workspaceID, owner.scope.id)).lifecycle).toBe("active")
    expect((await Session.get(owner.id)).workspace?.path).toBe(root)
  }))

test("archive parameters expose an object-root JSON Schema with optional target", async () => {
  const tool = await WorktreeArchiveTool.init()
  const schema = z.toJSONSchema(tool.parameters)
  expect(schema.type).toBe("object")
  expect(schema.properties).toMatchObject({ target: { type: "string" }, reason: { type: "string" } })
  expect(schema.required ?? []).toEqual([])
  expect(tool.parameters.parse({})).toEqual({})
  expect(tool.parameters.safeParse({ target: "" }).success).toBe(false)
})

test("omitted target on the main checkout returns noop without asking permission", () =>
  fixture(async (root) => {
    const session = await Session.create()
    const { ctx, asked, captured } = context(session.id)
    const tool = await WorktreeArchiveTool.init()
    const result = await tool.execute({}, ctx)
    expect(result.metadata.action).toBe("noop")
    expect(result.metadata.cleanup).toBeUndefined()
    expect(asked).toEqual([])
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ title: result.title, output: result.output, metadata: { action: "noop" } })
    expect((await Session.get(session.id)).workspace).toEqual(session.workspace)
    expect(await present(root)).toBe(true)
  }))

test.each(["rule denial", "user rejection"] as const)(
  "%s returns denied without changing bindings, lifecycle or checkout bytes",
  (denial) =>
    fixture(async () => {
      const session = await Session.create()
      const tree = await Worktree.create({
        name: "permission-denied",
        baseRef: "current",
        sessionID: session.id,
        bind: true,
      })
      const dirtyFile = path.join(tree.path, "unfinished.txt")
      await Bun.write(dirtyFile, "keep this work")
      const before = await Session.get(session.id)
      const { ctx, asked, captured } = context(session.id, async (request) => {
        if (denial === "user rejection") throw new PermissionNext.RejectedError()
        await PermissionNext.ask({
          ...request,
          sessionID: session.id,
          ruleset: [{ permission: "worktree_archive", pattern: "*", action: "deny" }],
        })
      })
      const tool = await WorktreeArchiveTool.init()
      const result = await tool.execute({}, ctx)
      expect(result.metadata.action).toBe("denied")
      expect(result.metadata.cleanup).toBeUndefined()
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "worktree_archive", patterns: [tree.path] })
      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({ output: result.output, metadata: { action: "denied" } })
      expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
      expect(await Bun.file(dirtyFile).text()).toBe("keep this work")
      expect(await present(tree.path)).toBe(true)
      expect(await Worktree.resolve(tree.id)).toMatchObject({ lifecycle: "active", bindings: [session.id] })
    }),
)

test("cancellation immediately after permission approval leaves the checkout and binding untouched", () =>
  fixture(async () => {
    const session = await Session.create()
    const tree = await Worktree.create({
      name: "cancel-after-ask",
      baseRef: "current",
      sessionID: session.id,
      bind: true,
    })
    const before = await Session.get(session.id)
    const invocation = context(session.id, async () => {
      invocation.controller.abort(new Error("cancel after permission approval"))
    })
    const tool = await WorktreeArchiveTool.init()
    await expect(tool.execute({}, invocation.ctx)).rejects.toThrow("cancel after permission approval")
    expect(invocation.asked).toHaveLength(1)
    expect(invocation.captured).toEqual([])
    expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
    expect(await present(tree.path)).toBe(true)
    expect(await Worktree.resolve(tree.id)).toMatchObject({ lifecycle: "active", bindings: [session.id] })
  }))

test("running owner archives through the tool and continues a real write in its restored checkout", () =>
  fixture(async (root) => {
    const session = await Session.create()
    const tree = await Worktree.create({ name: "running-owner", baseRef: "current", sessionID: session.id, bind: true })
    const branch = tree.branch
    if (!branch) throw new Error("Fixture worktree has no branch to retain")
    const selected = await Session.get(session.id)
    const { ctx, asked, captured } = context(session.id)
    const tool = (await ToolRegistry.tools("openai")).find((entry) => entry.id === "worktree_archive")
    if (!tool) throw new Error("Registered archive tool is missing from provider resolution")
    const lease = SessionManager.acquire(session.id)
    if (!lease) throw new Error("Fixture session could not acquire its running-owner lease")
    try {
      await ScopeContext.provide({
        scope: selected.scope,
        workspace: selected.workspace,
        fn: () =>
          WorkspaceAccess.task({ sessionID: session.id, workspace: selected.workspace }, async () => {
            const result = await tool.execute({ reason: "isolated work finished" }, ctx)
            expect(asked).toEqual([
              {
                permission: "worktree_archive",
                patterns: [tree.path],
                metadata: { target: tree.id, branch: tree.branch, reason: "isolated work finished" },
              },
            ])
            expect(result.metadata).toMatchObject({
              action: "archived",
              worktree: { id: tree.id, name: tree.name, path: tree.path, branch: tree.branch },
              restored: { type: "main", path: root },
              cleanup: { performed: true },
            })
            expect(result.output).toContain("Checkout removed")
            expect(result.output).toContain(branch)
            expect(result.output).toContain(root)
            expect(captured).toHaveLength(1)
            expect(captured[0]).toMatchObject({
              title: result.title,
              output: result.output,
              metadata: { action: "archived", restored: { path: root }, cleanup: { performed: true } },
            })
            expect(ScopeContext.current.directory).toBe(root)
            expect(SessionManager.isRunning(session.id)).toBe(true)
            expect(lease.signal.aborted).toBe(false)
            const persisted = await Session.get(session.id)
            expect(persisted.workspaceID).toBe(session.workspaceID)
            expect(persisted.workspace).toEqual(session.workspace)
            expect(persisted.time.archived).toBeUndefined()
            await WorkspaceAccess.write([root], () => Bun.write(path.join(root, "continued.txt"), "turn continued"))
          }),
      })
    } finally {
      await SessionManager.release(lease)
    }
    expect(await Bun.file(path.join(root, "continued.txt")).text()).toBe("turn continued")
    expect(await present(tree.path)).toBe(false)
    expect((await $`git rev-parse --verify refs/heads/${tree.branch}`.cwd(root).quiet().nothrow()).exitCode).toBe(0)
    expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID)
  }, registerProjectTools))

test("explicit idle target rebinds its owner without changing another caller's binding", () =>
  fixture(async (root) => {
    const idleOwner = await Session.create()
    const target = await Worktree.create({
      name: "idle-target",
      baseRef: "current",
      sessionID: idleOwner.id,
      bind: true,
    })
    const caller = await Session.create({ workspace: idleOwner.workspace })
    const ownTree = await Worktree.create({
      name: "caller-checkout",
      baseRef: "current",
      sessionID: caller.id,
      bind: true,
    })
    const before = await Session.get(caller.id)
    const { ctx, asked } = context(caller.id)
    const tool = await WorktreeArchiveTool.init()
    await ScopeContext.provide({
      scope: before.scope,
      workspace: before.workspace,
      fn: async () => {
        const result = await tool.execute({ target: target.name }, ctx)
        expect(result.metadata).toMatchObject({
          action: "archived",
          worktree: { id: target.id },
          cleanup: { performed: true },
        })
        expect(result.metadata.restored).toBeUndefined()
      },
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ permission: "worktree_archive", patterns: [target.path] })
    expect((await Session.get(caller.id)).workspaceID).toBe(before.workspaceID)
    expect((await Session.get(caller.id)).workspace).toEqual(before.workspace)
    expect((await Session.get(idleOwner.id)).workspaceID).toBe(idleOwner.workspaceID)
    expect((await Session.get(idleOwner.id)).workspace?.path).toBe(root)
    expect(await present(target.path)).toBe(false)
    expect(await present(ownTree.path)).toBe(true)
    expect((await Worktree.resolve(ownTree.id)).bindings).toContain(caller.id)
  }))

test("dirty checkout output reports kept with its path and reason rather than removed", () =>
  fixture(async (root) => {
    const session = await Session.create()
    const tree = await Worktree.create({
      name: "unfinished-output",
      baseRef: "current",
      sessionID: session.id,
      bind: true,
    })
    const dirtyFile = path.join(tree.path, "unfinished.bin")
    const bytes = new Uint8Array([0, 255, 17, 128])
    await Bun.write(dirtyFile, bytes)
    const { ctx, captured } = context(session.id)
    const tool = await WorktreeArchiveTool.init()
    const result = await tool.execute({}, ctx)
    expect(result.metadata).toMatchObject({
      action: "archived",
      restored: { path: root },
      cleanup: { performed: false, reason: "dirty" },
    })
    expect(result.output).toContain("Checkout kept")
    expect(result.output).toContain(tree.path)
    expect(result.output).toContain("dirty")
    expect(result.output).not.toContain("Checkout removed")
    expect(result.metadata.message).toBe(result.output)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      output: result.output,
      metadata: { cleanup: { performed: false, reason: "dirty" } },
    })
    expect(new Uint8Array(await Bun.file(dirtyFile).arrayBuffer())).toEqual(bytes)
    expect(await present(tree.path)).toBe(true)
    expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID)
    expect((await Worktree.resolve(tree.id)).lifecycle).toBe("gc_candidate")
  }))

test.skipIf(process.platform === "win32")(
  "unconfirmed removal output does not claim the checkout is kept or advertise re-entry",
  async () => {
    const git = Bun.which("git")
    if (!git) throw new Error("Fixture requires Git")
    await using commands = await tmpdir()
    const marker = path.join(commands.path, "removal-completed")
    await fs.writeFile(
      path.join(commands.path, "git"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const child = Bun.spawnSync([${JSON.stringify(git)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
if (child.exitCode === 0 && args[0] === "worktree" && args[1] === "remove") {
  await Bun.write(${JSON.stringify(marker)}, "removed without a success acknowledgement")
  console.error("removal completion unavailable")
  process.exit(73)
}
process.exit(child.exitCode)
`,
      { mode: 0o755 },
    )
    await fixture(
      async (root) => {
        const session = await Session.create()
        const tree = await Worktree.create({
          name: "unconfirmed-removal",
          baseRef: "current",
          sessionID: session.id,
          bind: true,
        })
        const workspaceID = (await Session.get(session.id)).workspaceID!
        const { ctx, captured } = context(session.id)
        const tool = await WorktreeArchiveTool.init()
        const result = await tool.execute({}, ctx)
        expect(await Bun.file(marker).text()).toBe("removed without a success acknowledgement")
        expect(await present(tree.path)).toBe(false)
        expect((await Session.get(session.id)).workspace?.path).toBe(root)
        expect(result.metadata.cleanup).toMatchObject({
          performed: false,
          state: "unknown",
          reason: "removal_failed",
          error: expect.stringContaining("removal completion unavailable"),
        })
        expect(result.output).toMatch(/removal[^.\n]*(?:unconfirmed|could not be confirmed)/i)
        expect(result.metadata.worktree?.path).toBe(tree.path)
        expect(result.output).not.toMatch(/Checkout (?:kept|removed)|Re-enter (?:it|the|this)|worktree_enter/i)
        expect(result.metadata.message).toBe(result.output)
        expect(captured).toHaveLength(1)
        expect(captured[0]).toMatchObject({ output: result.output, metadata: { cleanup: { state: "unknown" } } })
        expect((await WorkspaceCatalog.get(workspaceID, session.scope.id)).lifecycle).toBe("deleting")
        expect((await Worktree.sweep()).reconciled).toContain(tree.id)
        expect((await WorkspaceCatalog.get(workspaceID, session.scope.id)).lifecycle).toBe("deleted")
        expect((await Worktree.list()).some((entry) => entry.id === tree.id)).toBe(false)
      },
      undefined,
      { PATH: `${commands.path}${path.delimiter}${process.env.PATH ?? ""}` },
    )
  },
  20_000,
)

test("a repeated archive of replaced bytes reports unknown without promising re-entry", () =>
  fixture(async (root) => {
    const session = await Session.create()
    const tree = await Worktree.create({
      name: "replaced-output",
      baseRef: "current",
      sessionID: session.id,
      bind: true,
    })
    const workspaceID = (await Session.get(session.id)).workspaceID!
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
    const tool = await WorktreeArchiveTool.init()
    for (let attempt = 0; attempt < 2; attempt++) {
      const { ctx, captured } = context(session.id)
      const result = await tool.execute({ target: tree.id }, ctx)
      expect(result.metadata.cleanup).toMatchObject({ performed: false, state: "unknown" })
      expect(result.output).toMatch(/removal[^.\n]*(?:unconfirmed|could not be confirmed)/i)
      expect(result.output).not.toMatch(/Checkout (?:kept|removed)|Re-enter (?:it|the|this)|worktree_enter/i)
      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({ output: result.output, metadata: { cleanup: { state: "unknown" } } })
      expect((await WorkspaceCatalog.get(workspaceID, session.scope.id)).lifecycle).toBe("deleting")
      expect(await Bun.file(path.join(tree.path, "replacement.txt")).text()).toBe("foreign bytes")
    }
    expect(replaced).toBe(true)
    expect((await Session.get(session.id)).workspace?.path).toBe(root)
    expect(await present(`${tree.path}-original`)).toBe(true)
  }))

test("registry admission failure with a retained deleting fence does not advertise re-entry", () =>
  fixture(async (root) => {
    const session = await Session.create()
    const tree = await Worktree.create({
      name: "registry-fence-failure",
      baseRef: "current",
      sessionID: session.id,
      bind: true,
    })
    const selected = await Session.get(session.id)
    await Worktree.leave(session.id)
    const record = await WorkspaceCatalog.get(selected.workspaceID!, session.scope.id)
    await WorkspaceCatalog.beginRetirement([record])
    const metadata = WorkspaceAccess.metadata
    let injected = false
    using fault = spyOn(WorkspaceAccess, "metadata").mockImplementation(async (roots, fn, options) => {
      if (roots.includes(path.join(root, ".synergy/worktrees/.registry"))) {
        injected = true
        throw new Error("Registry mutation unavailable")
      }
      return metadata(roots, fn, options)
    })
    const tool = await WorktreeArchiveTool.init()
    const { ctx } = context(session.id)
    const result = await tool.execute({ target: tree.id }, ctx)
    expect(injected).toBe(true)
    expect(result.metadata.cleanup).toMatchObject({ performed: false, state: "unknown", reason: "removal_failed" })
    expect(result.output).not.toMatch(/Checkout (?:kept|removed)|Re-enter (?:it|the|this)|worktree_enter/i)
    expect(result.output).toContain("Registry mutation unavailable")
    expect((await WorkspaceCatalog.get(record.id, session.scope.id)).lifecycle).toBe("deleting")
    expect(await present(tree.path)).toBe(true)
  }))

test("ctx.abort cancels an asynchronous binding transition without an ambient signal", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let cancellingSessionID: string | undefined
  await fixture(
    async () => {
      const session = await Session.create()
      const tree = await Worktree.create({
        name: "cancel-async",
        baseRef: "current",
        sessionID: session.id,
        bind: true,
      })
      const before = await Session.get(session.id)
      const { ctx, controller, asked, captured } = context(session.id)
      const tool = await WorktreeArchiveTool.init()
      cancellingSessionID = session.id
      expect(WorkspaceAccess.signal()).toBeUndefined()
      const invocation = tool.execute({}, ctx).then(
        (result) => ({ status: "fulfilled", result }),
        (error: unknown) => ({ status: "rejected", error }),
      )
      try {
        const phase = await Promise.race([
          entered.promise.then(() => ({ entered: true })),
          invocation.then((outcome) => ({ entered: false, outcome })),
        ])
        expect(phase).toEqual({ entered: true })
        expect(asked).toHaveLength(1)
        expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
        expect(await present(tree.path)).toBe(true)
        controller.abort(new Error("cancel asynchronous archive"))
        release.resolve()
        expect(await invocation).toMatchObject({
          status: "rejected",
          error: { message: "cancel asynchronous archive" },
        })
        expect(captured).toEqual([])
        expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
        expect(await present(tree.path)).toBe(true)
        expect(await Worktree.resolve(tree.id)).toMatchObject({ lifecycle: "active", bindings: [session.id] })
      } finally {
        release.resolve()
        await invocation
      }
    },
    () =>
      SessionWorkspaceRuntime.registerTransition("archive-cancellation-barrier", async (session) => {
        if (session.id !== cancellingSessionID) return
        entered.resolve()
        await release.promise
      }),
  )
})
