import { expect, test } from "bun:test"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LocalBashBackend } from "../src/tools/bash/local"
import { testRuntime } from "./support/runtime"

test("closing a Runtime drains a background child even after its history entry is removed", async () => {
  await using runtime = await testRuntime({ env: { SHELL: process.platform === "win32" ? undefined : "/bin/sh" } })
  await using directory = await tmpdir({ git: true })
  const child = await runtime.run(async () =>
    ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const script = Buffer.from("setTimeout(() => process.stdout.write('finished'), 1500)").toString("base64")
        const command = `"${process.execPath}" -e "eval(Buffer.from('${script}', 'base64').toString())"`
        const result = await LocalBashBackend.execute(
          { command, description: "owned shutdown probe", yieldSeconds: 0.01 },
          {
            sessionID: "process-owner",
            messageID: "message",
            agent: "synergy",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
            extra: { shellBypassSandbox: true },
          },
        )
        expect(result.metadata.background).toBe(true)
        const owned = ProcessRegistry.get(result.metadata.processId!)!
        const child = owned.child!
        ProcessRegistry.remove(owned.id)
        return child
      },
    }),
  )
  await runtime.close()
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(child.stdout?.destroyed).toBe(true)
})
