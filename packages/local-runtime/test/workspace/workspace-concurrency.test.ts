import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { Worktree } from "../../src/workspace/worktree"
import { ScanFilesTool } from "../../src/tools/scan-files"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { testRuntime } from "../support/runtime"

test("an exited full-access Bash does not block another worktree while its turn continues", async () => {
  await using runtime = await testRuntime({ env: { SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/sh" } })
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const c = new WorkspaceCoordinator({ directory: path.join(runtime.host.root, "claims") })
    await ScopeContext.provide({
      scope,
      async fn() {
        const trees = [
          await Worktree.create({ name: "analysis-a", bind: false, baseRef: "current" }),
          await Worktree.create({ name: "analysis-b", bind: false, baseRef: "current" }),
        ]
        const sessions = []
        for (const tree of trees) {
          sessions.push(
            await Session.create({
              workspace: {
                type: "git_worktree",
                scopeID: scope.id,
                path: tree.path,
                worktreeID: tree.id,
                originalCheckout: tmp.path,
              },
            }),
          )
        }
        const [a, b] = sessions
        await Bun.write(path.join(b!.workspace!.path, "audit-marker.txt"), "audit-marker-7fd0\n")
        expect(a!.workspace!.id).not.toBe(b!.workspace!.id)
        expect(path.dirname(a!.workspace!.path)).toBe(path.dirname(b!.workspace!.path))
        const ready = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const scanAbort = new AbortController()
        let scan: Promise<unknown> | undefined
        let scanning = false
        const writer = ScopeContext.provide({
          scope,
          workspace: a!.workspace,
          fn: () =>
            WorkspaceAccess.task({ sessionID: a!.id, workspace: a!.workspace, lazy: true }, async () => {
              const result = await LocalBashBackend.execute(
                { command: "echo audit-command-finished", description: "Analysis fixture" },
                {
                  sessionID: a!.id,
                  messageID: "audit-a",
                  callID: "audit-a",
                  agent: "synergy",
                  abort: AbortSignal.timeout(10000),
                  metadata() {},
                  async ask() {},
                  extra: { shellBypassSandbox: true, controlProfile: "full_access" },
                },
              )
              expect(result.output.trim()).toBe("audit-command-finished")
              ready.resolve()
              await release.promise
            }),
        })
        void writer.catch((error) => ready.reject(error))
        try {
          await ready.promise
          const bytes = await Bun.file(path.join(b!.workspace!.path, "audit-marker.txt")).text()
          expect(bytes).toBe("audit-marker-7fd0\n")
          scan = ScopeContext.provide({
            scope,
            workspace: b!.workspace,
            fn: () =>
              WorkspaceAccess.task(
                { sessionID: b!.id, workspace: b!.workspace, signal: scanAbort.signal, lazy: true },
                async () => {
                  const tool = await ScanFilesTool.init()
                  return tool.execute(
                    { pattern: "audit-marker-7fd0", include: "audit-marker.txt" },
                    {
                      sessionID: b!.id,
                      messageID: "audit-b",
                      callID: "audit-b",
                      agent: "synergy",
                      abort: scanAbort.signal,
                      metadata() {},
                      async ask() {
                        scanning = true
                      },
                    },
                  )
                },
              ),
          })
          void scan.catch(() => {})
          const timeout = setTimeout(() => scanAbort.abort(new Error("Independent worktree was blocked")), 2000)
          let result: { output: string }
          try {
            result = (await scan) as { output: string }
          } finally {
            clearTimeout(timeout)
          }
          expect(result.output).toContain("audit-marker-7fd0")
          expect(scanning).toBe(true)
          expect(await Bun.file(path.join(b!.workspace!.path, "audit-marker.txt")).text()).toBe(bytes)
        } finally {
          release.resolve()
          scanAbort.abort()
          await Promise.allSettled([writer, scan])
        }
        expect(await c.inspect()).toHaveLength(0)
      },
    })
  })
}, 30000)

for (const shared of [false, true])
  test(`an active full-access command permits tools in ${shared ? "the same Workspace" : "a sibling worktree"}`, async () => {
    const { ProcessRegistry } = await import("@ericsanchezok/synergy-harness/process/registry")
    await using runtime = await testRuntime({ env: { SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/sh" } })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const first = await Worktree.create({ name: "concurrent-first", bind: false, baseRef: "current" })
          const second = shared
            ? first
            : await Worktree.create({ name: "concurrent-second", bind: false, baseRef: "current" })
          const a = await Session.create({
            workspace: {
              type: "git_worktree",
              scopeID: scope.id,
              path: first.path,
              worktreeID: first.id,
              originalCheckout: tmp.path,
            },
          })
          const b = await Session.create({
            workspace: {
              type: "git_worktree",
              scopeID: scope.id,
              path: second.path,
              worktreeID: second.id,
              originalCheckout: tmp.path,
            },
          })
          const context = (id: string) => ({
            sessionID: id,
            messageID: "test",
            callID: crypto.randomUUID(),
            agent: "synergy",
            abort: AbortSignal.timeout(10_000),
            metadata() {},
            async ask() {},
            extra: { shellBypassSandbox: true, controlProfile: "full_access" },
          })
          const result = await ScopeContext.provide({
            scope,
            workspace: a.workspace,
            fn: () =>
              LocalBashBackend.execute(
                {
                  command: process.platform === "win32" ? "ping -n 30 127.0.0.1 >NUL" : "/bin/sleep 30",
                  description: "live work",
                  yieldSeconds: 0.01,
                },
                context(a.id),
              ),
          })
          const running = ProcessRegistry.get(result.metadata.processId!)!
          expect(result.metadata.background).toBe(true)
          try {
            await ScopeContext.provide({
              scope,
              workspace: b.workspace,
              async fn() {
                const written = await LocalBashBackend.execute(
                  { command: "echo independent > concurrent.txt", description: "concurrent work" },
                  context(b.id),
                )
                expect(written.metadata.exit).toBe(0)
                const scanner = await ScanFilesTool.init()
                expect(
                  (await scanner.execute({ pattern: "independent", include: "concurrent.txt" }, context(b.id))).output,
                ).toContain("independent")
                expect(running.child?.alive?.()).toBe(true)
                await expect(WorkspaceAccess.exclusive([first.path], async () => {})).rejects.toMatchObject({
                  name: "WorkspaceBusyError",
                })
              },
            })
          } finally {
            await ProcessRegistry.terminate(running)
          }
          expect(
            (await Worktree.list())
              .filter((item) => item.id === first.id || item.id === second.id)
              .every((item) => !item.locked),
          ).toBe(true)
        },
      })
    })
  }, 30_000)
