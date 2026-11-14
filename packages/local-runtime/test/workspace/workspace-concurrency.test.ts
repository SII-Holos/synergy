import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, spyOn, test } from "bun:test"
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
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import * as FileLocks from "@ericsanchezok/synergy-util/fs-lock"
import * as ProcessIdentity from "@ericsanchezok/synergy-util/process-identity"
import * as FilesystemIdentity from "@ericsanchezok/synergy-util/filesystem-identity"
import { FileCoordination } from "../../src/file/coordination"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { OwnedTree } from "../../src/process/owned-tree"

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
    const stage = (value: string, facts: Record<string, boolean | number | string | null> = {}) => {
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
    const selectedRuntime = await runtime.run(() => RuntimeContext.current())
    let diagnosingExclusive = false
    const selected = () => diagnosingExclusive && RuntimeContext.tryCurrent() === selectedRuntime
    const admission = RuntimeMaintenance.assertAdmission
    using admissionStages =
      process.platform === "win32"
        ? spyOn(RuntimeMaintenance, "assertAdmission").mockImplementation(async (...args) => {
            if (!selected()) return admission(...args)
            stage("exclusive-owner-admission-enter")
            try {
              return await admission(...args)
            } finally {
              stage("exclusive-owner-admission-settled")
            }
          })
        : undefined
    const publish = AtomicFile.writeJsonAtomic
    using publicationStages =
      process.platform === "win32"
        ? spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (...args) => {
            if (!selected() || path.basename(args[0]) !== "workspace-claims-v1.json") return publish(...args)
            stage("exclusive-ledger-publication-enter")
            try {
              return await publish(...args)
            } finally {
              stage("exclusive-ledger-publication-settled")
            }
          })
        : undefined
    const inspectTree = OwnedTree.inspect
    using treeStages =
      process.platform === "win32"
        ? spyOn(OwnedTree, "inspect").mockImplementation((reference) => {
            if (!selected()) return inspectTree(reference)
            stage("exclusive-native-tree-inspect-enter")
            try {
              const result = inspectTree(reference)
              stage("exclusive-native-tree-inspect-returned", { active: result.state === "active" })
              return result
            } finally {
              stage("exclusive-native-tree-inspect-settled")
            }
          })
        : undefined
    const acquire = WorkspaceCoordinator.prototype.acquire
    using acquireStages =
      process.platform === "win32"
        ? spyOn(WorkspaceCoordinator.prototype, "acquire").mockImplementation(function (
            this: WorkspaceCoordinator,
            input,
          ) {
            if (!selected() || input.kind !== "exclusive") return acquire.call(this, input)
            stage("exclusive-native-enter", { timeoutMs: input.timeoutMs ?? null, roots: input.roots?.length ?? null })
            return acquire.call(this, input).then(
              (lease) => {
                stage("exclusive-native-acquired")
                return lease
              },
              (error: unknown) => {
                stage("exclusive-native-rejected", { name: error instanceof Error ? error.name : "unknown" })
                throw error
              },
            )
          })
        : undefined
    const canonical = FileCoordination.canonical
    using canonicalStages =
      process.platform === "win32"
        ? spyOn(FileCoordination, "canonical").mockImplementation(async (input) => {
            if (!selected()) return canonical(input)
            stage("exclusive-canonical-enter")
            try {
              return await canonical(input)
            } finally {
              stage("exclusive-canonical-settled")
            }
          })
        : undefined
    const physical = FilesystemIdentity.identifyFilesystemObject
    using physicalStages =
      process.platform === "win32"
        ? spyOn(FilesystemIdentity, "identifyFilesystemObject").mockImplementation(async (...args) => {
            if (!selected()) return physical(...args)
            stage("exclusive-physical-enter")
            try {
              return await physical(...args)
            } finally {
              stage("exclusive-physical-settled")
            }
          })
        : undefined
    const identity = ProcessIdentity.processStartIdentity
    using identityStages =
      process.platform === "win32"
        ? spyOn(ProcessIdentity, "processStartIdentity").mockImplementation(async (pid) => {
            if (!selected()) return identity(pid)
            stage("exclusive-process-identity-enter", { own: pid === process.pid })
            try {
              const result = await identity(pid)
              stage("exclusive-process-identity-returned", { known: result !== undefined })
              return result
            } finally {
              stage("exclusive-process-identity-settled")
            }
          })
        : undefined
    const lock = FileLocks.withFileLock
    const observeLock = <T>(options: Parameters<typeof lock>[0], body: () => Promise<T>): Promise<T> => {
      if (!selected() || options.key !== "workspace-coordinator-v1") return lock(options, body)
      stage("exclusive-ledger-lock-enter", { timeoutMs: options.timeoutMs ?? null })
      return lock(options, async () => {
        stage("exclusive-ledger-body-enter")
        try {
          return await body()
        } finally {
          stage("exclusive-ledger-body-settled")
        }
      }).finally(() => stage("exclusive-ledger-lock-settled"))
    }
    using lockStages =
      process.platform === "win32" ? spyOn(FileLocks, "withFileLock").mockImplementation(observeLock) : undefined
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
                      diagnosingExclusive = true
                      try {
                        await expect(WorkspaceAccess.exclusive([first.path], async () => {})).rejects.toMatchObject({
                          name: "WorkspaceBusyError",
                        })
                      } finally {
                        diagnosingExclusive = false
                      }
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
