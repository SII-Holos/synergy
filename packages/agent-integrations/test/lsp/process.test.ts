import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { LSPProcess } from "../../src/lsp/process"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())

test("LSP preparation drains bounded binary output and reports failed native commands", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: () =>
        WorkspaceAccess.withinTask(async () => {
          const result = await LSPProcess.resolving(AbortSignal.timeout(10000), () =>
            LSPProcess.run({
              command: [
                process.execPath,
                "-e",
                "process.stdout.write(Buffer.alloc(1500000,255));process.stderr.write(Buffer.alloc(1500000,0))",
              ],
            }),
          )
          expect(result.value.exitCode).toBe(0)
          expect(result.value.stdout.length + result.value.stderr.length).toBe(1024 * 1024)
          expect(result.value.stdout.every((byte) => byte === 255)).toBe(true)
          await result.dispose()
          await expect(
            LSPProcess.resolving(AbortSignal.timeout(10000), () =>
              LSPProcess.run({
                command: [process.execPath, "-e", "process.stderr.write('fixture failure');process.exit(7)"],
              }),
            ),
          ).rejects.toThrow("7: fixture failure")
        }),
    })
  }))

test(
  "native LSP preparation cancellation drains descendants and removes owned temporary data",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: () =>
          WorkspaceAccess.withinTask(async () => {
            const controller = new AbortController()
            let directory = ""
            const marker = path.join(tmp.path, "preparing")
            const pending = LSPProcess.resolving(controller.signal, async () => {
              directory = await LSPProcess.temporaryDirectory()
              return LSPProcess.run({
                command: [
                  process.execPath,
                  "-e",
                  `await Bun.write(${JSON.stringify(marker)}, 'ready');setInterval(()=>{},1000)`,
                ],
              })
            })
            const failure = pending.then(
              () => undefined,
              (error: unknown) => error,
            )
            try {
              const until = Date.now() + 5000
              while (!(await Bun.file(marker).exists())) {
                if (Date.now() >= until) throw new Error("Preparation did not start")
                await Bun.sleep(10)
              }
              controller.abort()
              expect(await failure).toMatchObject({ name: "AbortError" })
              expect(
                await import("node:fs/promises").then((fs) =>
                  fs.stat(directory).then(
                    () => true,
                    () => false,
                  ),
                ),
              ).toBe(false)
              await WorkspaceAccess.write([tmp.path], async () => {
                await Bun.write(path.join(tmp.path, "after"), "ready")
              })
            } finally {
              controller.abort()
              await pending.catch(() => {})
            }
          }),
      })
    }),
  15000,
)

test(
  "language server temporary data is removed before a completed native claim admits another writer",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: () =>
          WorkspaceAccess.withinTask(async () => {
            const prepared = await LSPProcess.resolving(AbortSignal.timeout(10000), () =>
              LSPProcess.temporaryDirectory(),
            )
            const owned = await LSPProcess.start(
              { command: process.execPath, args: ["-e", "process.stdin.resume()"], cwd: tmp.path },
              AbortSignal.timeout(10000),
              true,
              prepared.dispose,
            )
            owned.child.stdout.resume()
            owned.child.stderr.resume()
            try {
              await owned.activate()
              owned.child.stdin.end()
              await owned.completion
              await WorkspaceAccess.write([tmp.path], async () => {
                const fs = await import("node:fs/promises")
                expect(
                  await fs.stat(prepared.value).then(
                    () => true,
                    () => false,
                  ),
                ).toBe(false)
              })
            } finally {
              await owned.stop()
              await prepared.dispose()
            }
          }),
      })
    }),
  15000,
)
