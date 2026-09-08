import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LocalProcessBackend } from "../../src/tools/process/local"

test("local process operations require background ownership and preserve output through termination", async () => {
  await using directory = await tmpdir()
  await ScopeContext.provide({
    scope: await directory.scope(),
    async fn() {
      const child = spawn(process.execPath, ["-e", 'process.stdin.on("data", data => process.stdout.write(data))'], {
        cwd: directory.path,
        stdio: "pipe",
      })
      const closed = once(child, "close")
      const processInfo = ProcessRegistry.create({
        command: "native stdin echo",
        description: "Research worker",
        cwd: directory.path,
        child,
      })
      child.stdout.on("data", (data: Buffer) => ProcessRegistry.appendOutput(processInfo, data.toString()))
      try {
        for (const action of ["poll", "log", "write", "send-keys", "kill"] as const) {
          expect((await LocalProcessBackend.execute({ action, processId: processInfo.id })).metadata.status).toBe(
            "error",
          )
        }
        ProcessRegistry.markBackgrounded(processInfo)
        expect((await LocalProcessBackend.execute({ action: "list" })).output).toContain("Research worker")
        expect(
          (await LocalProcessBackend.execute({ action: "clear", processId: processInfo.id })).metadata.status,
        ).toBe("error")
        const output = once(child.stdout, "data")
        expect(
          (await LocalProcessBackend.execute({ action: "write", processId: processInfo.id, data: "first\nsecond\n" }))
            .metadata.status,
        ).toBe("running")
        await output
        expect(
          (await LocalProcessBackend.execute({ action: "log", processId: processInfo.id, offset: 1, limit: 1 })).output,
        ).toBe("second")
        expect((await LocalProcessBackend.execute({ action: "poll", processId: processInfo.id })).output).toContain(
          "still running",
        )
        expect(
          (await LocalProcessBackend.execute({ action: "send-keys", processId: processInfo.id, keys: [] })).title,
        ).toBe("No keys provided")
        expect(
          (await LocalProcessBackend.execute({ action: "send-keys", processId: processInfo.id, keys: [""] })).title,
        ).toBe("No key data")
        const keyOutput = once(child.stdout, "data")
        expect(
          (await LocalProcessBackend.execute({ action: "send-keys", processId: processInfo.id, keys: ["Enter"] }))
            .metadata.status,
        ).toBe("running")
        await keyOutput
        expect((await LocalProcessBackend.execute({ action: "kill", processId: processInfo.id })).metadata.status).toBe(
          "killed",
        )
        await closed
        expect((await LocalProcessBackend.execute({ action: "poll", processId: processInfo.id })).metadata.status).toBe(
          "killed",
        )
        expect((await LocalProcessBackend.execute({ action: "log", processId: processInfo.id })).output).toContain(
          "first",
        )
        expect(
          (await LocalProcessBackend.execute({ action: "clear", processId: processInfo.id })).metadata.status,
        ).toBe("cleared")
      } finally {
        child.kill("SIGKILL")
        await closed
        ProcessRegistry.remove(processInfo.id)
      }
    },
  })
}, 30_000)

test("local process operations distinguish missing processes and remove history idempotently", async () => {
  await expect(LocalProcessBackend.execute({ action: "poll" })).rejects.toThrow("processId is required")
  for (const action of ["poll", "log", "write", "send-keys", "kill", "clear"] as const) {
    expect((await LocalProcessBackend.execute({ action, processId: "missing-owned-process" })).metadata.status).toBe(
      "not_found",
    )
  }
  expect(
    (await LocalProcessBackend.execute({ action: "remove", processId: "missing-owned-process" })).metadata.status,
  ).toBe("removed")
})

test("completed local process history reports failure and supports paged logs", async () => {
  await using directory = await tmpdir()
  await ScopeContext.provide({
    scope: await directory.scope(),
    async fn() {
      const child = spawn(process.execPath, ["-e", 'process.stdout.write("one\\ntwo\\n");process.exit(2)'], {
        stdio: "pipe",
      })
      const closed = once(child, "close")
      const processInfo = ProcessRegistry.create({ command: "completed worker", child })
      child.stdout.on("data", (data: Buffer) => ProcessRegistry.appendOutput(processInfo, data.toString()))
      try {
        const [code, signal] = await closed
        ProcessRegistry.markExited(processInfo, code, signal)
        expect(
          (await LocalProcessBackend.execute({ action: "poll", processId: processInfo.id })).metadata,
        ).toMatchObject({ status: "failed", exitCode: 2 })
        expect(
          (await LocalProcessBackend.execute({ action: "log", processId: processInfo.id, offset: 1, limit: 1 })).output,
        ).toBe("two")
        expect((await LocalProcessBackend.execute({ action: "list" })).output).toContain("failed")
        expect(
          (await LocalProcessBackend.execute({ action: "remove", processId: processInfo.id })).metadata.status,
        ).toBe("removed")
      } finally {
        ProcessRegistry.remove(processInfo.id)
      }
    },
  })
})
