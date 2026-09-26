import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorktreeProcess } from "../../src/workspace/process"
import { testRuntime } from "../support/runtime"

test("worktree command cancellation drains the activated native process before releasing ownership", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "started")
    const controller = new AbortController()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const running = WorktreeProcess.run({
          command: [
            process.execPath,
            "-e",
            "await Bun.write(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
            marker,
          ],
          directory: tmp.path,
          roots: null,
          signal: controller.signal,
        }).catch((error: unknown) => error)
        try {
          await waitUntil(() => Bun.file(marker).exists())
          const pid = Number(await Bun.file(marker).text())
          controller.abort(new DOMException("Cancelled after activation", "AbortError"))
          const result = await running
          expect(result).toBeInstanceOf(DOMException)
          expect(ProcessInspection.alive(pid)).toBe(false)
          await WorkspaceAccess.write([tmp.path], async () => {
            await fs.writeFile(path.join(tmp.path, "next-write"), "released")
          })
          expect(await fs.readFile(path.join(tmp.path, "next-write"), "utf8")).toBe("released")
        } finally {
          controller.abort(new DOMException("Worktree process fixture closed", "AbortError"))
          await running
        }
      },
    })
  })
}, 20000)

async function waitUntil(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await fn())) {
    if (Date.now() >= deadline) throw new Error("Worktree process did not start")
    await Bun.sleep(20)
  }
}
