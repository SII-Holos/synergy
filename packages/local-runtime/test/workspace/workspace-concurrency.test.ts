import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { withToolRun } from "@ericsanchezok/synergy-harness/test/support/rollout"
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
            withToolRun({ session: a!, tool: "bash", args: { command: "echo audit-command-finished" } }, (identity) =>
              WorkspaceAccess.task({ sessionID: a!.id, workspace: a!.workspace, lazy: true }, async () => {
                const result = await LocalBashBackend.execute(
                  { command: "echo audit-command-finished" },
                  {
                    ...{
                      ...identity,
                      agent: PrimaryAgentIdentity.names.general,
                      abort: AbortSignal.timeout(10000),
                      metadata() {},
                      async ask() {},
                      extra: { shellBypassSandbox: true, controlProfile: "full_access" },
                    },
                    workBrief: "Analysis fixture",
                  },
                )
                expect(result.output.trim()).toBe("audit-command-finished")
                ready.resolve()
                await release.promise
              }),
            ),
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
                  const params = { pattern: "audit-marker-7fd0", include: "audit-marker.txt" }
                  return withToolRun({ session: b!, tool: "scan_files", args: params }, (identity) =>
                    tool.execute(params, {
                      ...identity,
                      agent: PrimaryAgentIdentity.names.general,
                      abort: scanAbort.signal,
                      metadata() {},
                      async ask() {
                        scanning = true
                      },
                    }),
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
    const started = performance.now()
    const stage = (value: string, facts: Record<string, boolean | number | null> = {}) => {
      if (process.platform === "win32")
        console.info(
          JSON.stringify({
            fixture: "workspace-concurrency",
            shared,
            stage: value,
            elapsedMs: performance.now() - started,
            ...facts,
          }),
        )
    }
    stage("test-enter")
    const { ProcessRegistry } = await import("@ericsanchezok/synergy-harness/process/registry")
    stage("registry-imported")
    await using runtime = await testRuntime({ env: { SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/sh" } })
    stage("runtime-ready")
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      stage("fixture-ready")
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
          stage("worktrees-and-sessions-ready")
          const context = (identity: { sessionID: string; messageID: string; callID: string }) => ({
            ...identity,
            agent: PrimaryAgentIdentity.names.general,
            abort: AbortSignal.timeout(10_000),
            metadata() {},
            async ask() {},
            extra: { shellBypassSandbox: true, controlProfile: "full_access" },
          })
          await ScopeContext.provide({
            scope,
            workspace: a.workspace,
            async fn() {
              const params = {
                command: process.platform === "win32" ? "ping -n 30 127.0.0.1 >NUL" : "/bin/sleep 30",
                yieldSeconds: 0.01,
              }
              stage("a-run-admission")
              await withToolRun({ session: a, tool: "bash", args: params }, async (identity) => {
                stage("a-native-execute")
                const result = await LocalBashBackend.execute(params, { ...context(identity), workBrief: "live work" })
                const running = ProcessRegistry.get(result.metadata.processId!)!
                stage("a-native-returned", {
                  background: result.metadata.background === true,
                  registryPresent: Boolean(running),
                })
                expect(result.metadata.background).toBe(true)
                try {
                  stage("b-scope-enter")
                  await ScopeContext.provide({
                    scope,
                    workspace: b.workspace,
                    async fn() {
                      const params = { command: "echo independent > concurrent.txt" }
                      stage("b-run-admission")
                      const written = await withToolRun(
                        { session: b, tool: "bash", args: params },
                        async (identity) => {
                          stage("b-native-execute")
                          const value = await LocalBashBackend.execute(params, {
                            ...context(identity),
                            workBrief: "concurrent work",
                          })
                          stage("b-native-returned", { exit: value.metadata.exit ?? null })
                          return value
                        },
                      )
                      stage("b-run-returned", { exit: written.metadata.exit ?? null })
                      expect(written.metadata.exit).toBe(0)
                      stage("scan-init")
                      const scanner = await ScanFilesTool.init()
                      const scanParams = { pattern: "independent", include: "concurrent.txt" }
                      stage("scan-run-admission")
                      const scanned = await withToolRun(
                        { session: b, tool: "scan_files", args: scanParams },
                        async (identity) => {
                          stage("scan-execute")
                          const value = await scanner.execute(scanParams, context(identity))
                          stage("scan-returned")
                          return value
                        },
                      )
                      stage("scan-run-returned")
                      expect(scanned.output).toContain("independent")
                      expect(running.child?.alive?.()).toBe(true)
                      stage("exclusive-must-be-busy")
                      await expect(WorkspaceAccess.exclusive([first.path], async () => {})).rejects.toMatchObject({
                        name: "WorkspaceBusyError",
                      })
                      stage("exclusive-busy-verified")
                    },
                  })
                  stage("b-scope-returned")
                } finally {
                  stage("a-terminate")
                  await ProcessRegistry.terminate(running)
                  stage("a-terminated")
                }
                stage("worktree-lock-inspection")
                expect(
                  (await Worktree.list())
                    .filter((item) => item.id === first.id || item.id === second.id)
                    .every((item) => !item.locked),
                ).toBe(true)
                stage("a-tool-callback-return")
              })
              stage("a-run-returned")
            },
          })
        },
      })
    })
    stage("test-body-returned")
  }, 30_000)
