import { describe, expect, test } from "bun:test"
import path from "path"
import { ProcessTool } from "@ericsanchezok/synergy-local-runtime/tools/process"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const ctx = {
  sessionID: "test",
  messageID: "message_test",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.process", () => {
  test("rejects removed envID instead of falling back to local process control", () =>
    runtime.run(async () => {
      const process = await ProcessTool.init()
      expect(process.parameters.safeParse({ action: "list", envID: "legacy" }).success).toBe(false)
    }))
  test("promotes finished process artifacts on poll", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const filepath = path.join(tmp.path, "report.pdf")
      await Bun.write(filepath, "fake pdf")

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const proc = ProcessRegistry.create({
            command: "generate report",
            description: "Generate report",
            cwd: tmp.path,
          })
          ProcessRegistry.markBackgrounded(proc)
          ProcessRegistry.appendOutput(proc, `${filepath}\n`)
          ProcessRegistry.markExited(proc, 0, null)

          const process = await ProcessTool.init()
          const result = await process.execute(
            {
              action: "poll",
              processId: proc.id,
            },
            ctx,
          )

          expect(result.output).toContain("Process exited")
          expect(result.attachments).toHaveLength(1)
          expect(result.attachments?.[0].filename).toBe("report.pdf")
          expect(result.attachments?.[0].mime).toBe("application/pdf")

          ProcessRegistry.remove(proc.id)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
