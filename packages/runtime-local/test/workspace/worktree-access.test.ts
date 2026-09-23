import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { $ } from "bun"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { OwnedProcess } from "../../src/process/owned-process"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { FileMutation } from "../../src/file/mutation"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "../../src/workspace/worktree"
import { testRuntime } from "../support/runtime"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test.skipIf(process.platform === "win32")(
  "cancelling an active checkout hook removes only its owned unfinished worktree",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await using scripts = await tmpdir()
      const marker = path.join(scripts.path, "started")
      const hook = path.join(scripts.path, "hook.ts")
      await fs.writeFile(hook, "await Bun.write(process.argv[2]!, process.cwd()); setInterval(() => {}, 1000)")
      const hooks = path.join(tmp.path, ".git", "hooks")
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, "post-checkout"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hook)} ${quote(marker)}\n`,
        { mode: 0o755 },
      )
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create({})
          const controller = new AbortController()
          const creation = WorkspaceAccess.task(
            { sessionID: session.id, workspace: session.workspace, signal: controller.signal },
            () => Worktree.create({ name: "cancel-hook", bind: false, baseRef: "current" }),
          ).then(
            () => undefined,
            (error: unknown) => error,
          )
          await waitUntil(() => Bun.file(marker).exists())
          controller.abort(new DOMException("Cancelled during checkout", "AbortError"))
          const failure = await creation
          if (failure instanceof AggregateError) throw failure
          expect(failure).toBeInstanceOf(Error)
          expect(await Bun.file(marker).text()).toContain("cancel-hook")
          expect(await Worktree.list()).toHaveLength(1)
          expect((await $`git branch --list ${"synergy/cancel-hook-*"}`.cwd(tmp.path).quiet().text()).trim()).toBe("")
        },
      })
    })
  },
  20000,
)

test.skipIf(process.platform === "win32").each(["foreign lock", "new commit"])(
  "cancelled checkout preserves a worktree containing a %s",
  async (change) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await using scripts = await tmpdir()
      const marker = path.join(scripts.path, "started")
      const hook = path.join(scripts.path, "hook.ts")
      await fs.writeFile(
        hook,
        `
        import fs from "node:fs"
        import { spawnSync } from "node:child_process"
        const git = (...args) => {
          const result = spawnSync("git", args, { encoding: "utf8" })
          if (result.status !== 0) throw new Error(result.stderr)
        }
        if (process.argv[3] === "foreign lock") {
          git("worktree", "unlock", process.cwd())
          git("worktree", "lock", "--reason", "user pinned", process.cwd())
        } else {
          fs.writeFileSync("important.txt", "keep this commit")
          git("add", "important.txt")
          git("commit", "-m", "preserved fixture commit")
        }
        fs.writeFileSync(process.argv[2], process.cwd())
        setInterval(() => {}, 1000)
      `,
      )
      const hooks = path.join(tmp.path, ".git", "hooks")
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, "post-checkout"),
        `#!/bin/sh\nexec ${[process.execPath, hook, marker, change].map(quote).join(" ")}\n`,
        { mode: 0o755 },
      )
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const controller = new AbortController()
          const creation = WorkspaceAccess.task({ workspace: null, signal: controller.signal }, () =>
            Worktree.create({ name: "preserve-hook", bind: false, baseRef: "current" }),
          ).catch((error: unknown) => error)
          await waitUntil(() => Bun.file(marker).exists())
          controller.abort(new DOMException("Cancelled during checkout", "AbortError"))
          expect(await creation).toBeInstanceOf(AggregateError)
          const directory = await Bun.file(marker).text()
          const kept = (await Worktree.list()).find((item) => item.path === directory)
          expect(kept).toBeDefined()
          if (change === "foreign lock") expect(kept?.locked).toBe("user pinned")
          else {
            expect(await fs.readFile(path.join(directory, "important.txt"), "utf8")).toBe("keep this commit")
            expect((await $`git log -1 --format=%s`.cwd(directory).quiet().text()).trim()).toBe(
              "preserved fixture commit",
            )
            expect(kept?.locked).toBeUndefined()
          }
        },
      })
    })
  },
  20000,
)

test("cancelled worktree creation has no Git or filesystem effects", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const controller = new AbortController()
        const result = await WorkspaceAccess.task(
          { sessionID: session.id, workspace: session.workspace, signal: controller.signal },
          async () => {
            controller.abort(new DOMException("Cancelled before creation", "AbortError"))
            return Worktree.create({ name: "cancelled", bind: false, baseRef: "current" })
          },
        ).catch((error: unknown) => error)
        expect(result).toBeInstanceOf(Error)
        expect((await Worktree.list()).length).toBe(1)
        expect(await Bun.file(path.join(tmp.path, ".git/info/exclude")).text()).not.toContain(".synergy/worktrees/")
      },
    })
  })
})

test.skipIf(process.platform === "win32")(
  "worktree setup settles its detached descendants before reporting completion",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await using scripts = await tmpdir()
      const marker = path.join(scripts.path, "finished")
      const child = path.join(scripts.path, "child.ts")
      const parent = path.join(scripts.path, "parent.ts")
      await Bun.write(child, `await Bun.sleep(500); await Bun.write(process.argv[2]!, "finished")`)
      await Bun.write(
        parent,
        `import { spawn } from "node:child_process"; spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: "ignore" }).unref()`,
      )
      await Bun.write(
        path.join(tmp.path, ".synergy/worktree-setup.jsonc"),
        JSON.stringify({
          setup: [[process.execPath, parent, child, marker].map(quote).join(" ")],
        }),
      )
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const created = await Worktree.create({ name: "setup-tree", bind: false, baseRef: "current" })
          try {
            expect(created.setupFailed).not.toBe(true)
            expect(await Bun.file(marker).exists()).toBe(true)
          } finally {
            await Bun.sleep(600)
            await Worktree.remove({ target: created.id, force: true })
          }
        },
      })
    })
  },
  20_000,
)

test("worktree removal refuses a Workspace used outside its Session registry", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "external-use", bind: false, baseRef: "current" })
        const session = await Session.create({
          workspace: { type: "directory", scopeID: scope.id, path: created.path },
        })
        const ready = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const use = WorkspaceAccess.task({ sessionID: session.id, workspace: session.workspace }, async () => {
          ready.resolve()
          await release.promise
        })
        await ready.promise
        try {
          const result = await Worktree.remove({ target: created.id, force: true }).catch((error: unknown) => error)
          expect(result).toBeInstanceOf(WorkspaceAccess.BusyError)
          expect((await $`git -C ${created.path} rev-parse --is-inside-work-tree`.quiet().text()).trim()).toBe("true")
        } finally {
          release.resolve()
          await use
        }
        await Worktree.remove({ target: created.id, force: true })
      },
    })
  })
}, 20_000)

async function waitUntil(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await fn())) {
    if (Date.now() >= deadline) throw new Error("Worktree state did not settle")
    await Bun.sleep(20)
  }
}

test("a turn can create, select, edit and remove its managed Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create({}) })
    await SessionManager.run(session.id, async () => {
      const created = await Worktree.create({ sessionID: session.id, name: "own-turn", bind: true, baseRef: "current" })
      expect(ScopeContext.current.directory).toBe(created.path)
      await FileMutation.write({ path: path.join(created.path, "edited.txt"), content: "owned", expectedVersion: null })
      await Worktree.remove({ target: created.id, sessionID: session.id, force: true }, { insideCallerTurn: true })
      expect(ScopeContext.current.directory).toBe(tmp.path)
      expect((await Session.get(session.id)).workspace?.path).toBe(tmp.path)
    })
  })
}, 20_000)

test("Git metadata locks do not reserve a read-only turn's Workspace writer", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "reader", bind: false, baseRef: "current" })
        const first = await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: created.path } })
        const second = await Session.create({ workspaceID: first.workspaceID })
        const ready = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const reader = WorkspaceAccess.task({ sessionID: first.id, workspace: first.workspace }, async () => {
          await Worktree.lock(created.path)
          ready.resolve()
          await release.promise
          await Worktree.unlock(created.path)
        })
        await ready.promise
        try {
          await WorkspaceAccess.task({ sessionID: second.id, workspace: second.workspace }, () =>
            FileMutation.write({
              path: path.join(created.path, "concurrent.txt"),
              content: "while reading",
              expectedVersion: null,
            }),
          )
          expect(await Bun.file(path.join(created.path, "concurrent.txt")).text()).toBe("while reading")
        } finally {
          release.resolve()
          await reader
        }
        await Worktree.remove({ target: created.id, force: true })
      },
    })
  })
}, 20_000)

test("cancelled turns and native background processes release Git locks after ownership drains", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "background", bind: false, baseRef: "current" })
        const session = await Session.create({
          workspace: { type: "directory", scopeID: scope.id, path: created.path },
        })
        const controller = new AbortController()
        let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
        try {
          await WorkspaceAccess.task(
            { sessionID: session.id, workspace: session.workspace, signal: controller.signal },
            async () => {
              await Worktree.lock(created.path)
              const lease = await WorkspaceAccess.process(null)
              owned = await OwnedProcess.prepare({
                command: process.execPath,
                args: ["-e", "await Bun.sleep(700)"],
                cwd: created.path,
                env: {},
                lease,
              })
              owned.child.stdout.resume()
              owned.child.stderr.resume()
              await owned.activate()
              owned.child.stdin.end()
              controller.abort(new DOMException("Cancelled turn", "AbortError"))
              await Worktree.unlock(created.path)
              expect(owned.child.exitCode).toBeNull()
            },
          )
          await owned!.completion
          await waitUntil(async () => !(await Worktree.list()).find((item) => item.id === created.id)?.locked)
          expect((await Worktree.list()).find((item) => item.id === created.id)?.locked).toBeUndefined()
        } finally {
          await owned?.stop()
        }
        await Worktree.remove({ target: created.id, force: true })
      },
    })
  })
}, 20_000)

test("setup copy paths cannot escape either checkout", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await Bun.write(path.join(tmp.path, "secret-copy.txt"), "must remain in the original checkout")
    await Bun.write(
      path.join(tmp.path, ".synergy/worktree-setup.jsonc"),
      JSON.stringify({ copyIgnored: ["../../secret-copy.txt"] }),
    )
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "invalid-copy", bind: false, baseRef: "current" })
        expect(created.setupFailed).toBe(true)
        expect(created.setupError).toContain("copyIgnored")
        await Worktree.remove({ target: created.id, force: true })
      },
    })
  })
}, 20_000)

test("concurrent creations choose unused names after native write admission", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessions = await Promise.all(Array.from({ length: 4 }, () => Session.create({})))
        const results = await Promise.allSettled(
          sessions.map((session) =>
            Worktree.create({
              sessionID: session.id,
              name: "concurrent",
              bind: false,
              baseRef: "current",
            }),
          ),
        )
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length) throw new AggregateError(failures, "Concurrent worktree creation failed")
        const created = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
        expect(new Set(created.map((item) => item.path)).size).toBe(4)
        expect((await Worktree.list()).length).toBe(5)
        for (const item of created) await Worktree.remove({ target: item.id, force: true })
      },
    })
  })
}, 30_000)

test("independent Runtime instances retain every shared worktree registry binding", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  await using tmp = await tmpdir({ git: true })
  const prepare = (runtime: typeof first) =>
    runtime.run(async () => {
      const scope = await tmp.scope()
      return ScopeContext.provide({ scope, fn: async () => ({ scope, session: await Session.create({}) }) })
    })
  const a = await prepare(first)
  const b = await prepare(second)
  const within = <T>(runtime: typeof first, scope: typeof a.scope, fn: () => Promise<T>) =>
    runtime.run(() => ScopeContext.provide({ scope, fn }))
  const created = await within(first, a.scope, () =>
    Worktree.create({ name: "shared-registry", bind: false, baseRef: "current" }),
  )
  await Promise.all([
    within(first, a.scope, () => Worktree.enter({ sessionID: a.session.id, target: created.id })),
    within(second, b.scope, () => Worktree.enter({ sessionID: b.session.id, target: created.id })),
  ])
  await within(first, a.scope, async () => {
    expect((await Worktree.list()).find((item) => item.id === created.id)?.bindings?.sort()).toEqual(
      [a.session.id, b.session.id].sort(),
    )
    await Worktree.remove({ target: created.id, force: true })
  })
})
