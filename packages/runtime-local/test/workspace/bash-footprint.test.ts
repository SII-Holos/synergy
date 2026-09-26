import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import type { BashContext } from "@ericsanchezok/synergy-harness/tool/bash-contract"
import { SandboxBackend } from "../../src/sandbox/backend"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime({ env: { SHELL: "/bin/sh" } })
afterAll(() => runtime.close())
const nativeTest = test.skipIf(process.platform !== "darwin")

function context(options: {
  workspace: string
  mode?: "read_only" | "workspace_write"
  shares?: string[]
  abort?: AbortSignal
}): BashContext {
  return {
    sessionID: crypto.randomUUID(),
    messageID: "message",
    agent: "synergy",
    abort: options.abort ?? new AbortController().signal,
    metadata() {},
    async ask() {},
    extra: options.mode
      ? {
          shellAuthorizationResolved: true,
          sandboxPrepare: async ({ command }: { command: string }) =>
            SandboxBackend.prepareWrapper({
              command: "/bin/sh",
              args: ["-c", command],
              workspace: options.workspace,
              sandboxMode: options.mode!,
              extraWritableRoots: options.shares,
            }),
        }
      : { shellBypassSandbox: true, controlProfile: "full_access" },
  }
}

nativeTest(
  "a genuinely read-only Bash process permits an unconfined writer in the same Workspace",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const running = await LocalBashBackend.execute(
            { command: "/bin/sleep 20", description: "read-only task", yieldSeconds: 0.01 },
            context({ workspace: tmp.path, mode: "read_only" }),
          )
          const processInfo = ProcessRegistry.get(running.metadata.processId!)!
          expect(running.metadata.background).toBe(true)
          try {
            const result = await LocalBashBackend.execute(
              { command: "printf independent", description: "independent writer" },
              context({ workspace: tmp.path, abort: AbortSignal.timeout(5000) }),
            )
            expect(result.output).toBe("independent")
            expect(processInfo.child?.alive?.()).toBe(true)
          } finally {
            await ProcessRegistry.terminate(processInfo)
          }
        },
      })
    }),
  20000,
)

nativeTest(
  "disjoint compiled roots run concurrently, while an explicitly shared root blocks a writer",
  () =>
    runtime.run(async () => {
      await using a = await tmpdir()
      await using b = await tmpdir()
      const scopeA = await a.scope(),
        scopeB = await b.scope()
      for (const shared of [false, true]) {
        const processInfo = await ScopeContext.provide({
          scope: scopeA,
          async fn() {
            const running = await LocalBashBackend.execute(
              { command: "/bin/sleep 20", description: "workspace writer", yieldSeconds: 0.01 },
              context({ workspace: a.path, mode: "workspace_write", shares: shared ? [b.path] : [] }),
            )
            return ProcessRegistry.get(running.metadata.processId!)!
          },
        })
        try {
          await ScopeContext.provide({
            scope: scopeB,
            async fn() {
              const result = LocalBashBackend.execute(
                { command: "printf independent", description: "other workspace writer" },
                context({
                  workspace: b.path,
                  mode: "workspace_write",
                  abort: AbortSignal.timeout(shared ? 200 : 5000),
                }),
              )
              if (shared) await expect(result).rejects.toThrow()
              else expect((await result).output).toBe("independent")
              expect(processInfo.child?.alive?.()).toBe(true)
            },
          })
        } finally {
          await ProcessRegistry.terminate(processInfo)
        }
      }
    }),
  20000,
)
