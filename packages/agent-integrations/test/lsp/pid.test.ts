import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { LSPPid } from "../../src/lsp/pid"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { testRuntime } from "../support/runtime"

test("LSP cleanup preserves live owners, unverified identities and PID-only legacy records", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const children = [1, 2].map(() => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }))
    await Promise.all(children.map((child) => once(child, "spawn")))
    try {
      const releases = await Promise.all(children.map((child) => LSPPid.track(child.pid!)))
      await LSPPid.cleanupOrphans()
      for (const child of children) expect(ProcessInspection.alive(child.pid!)).toBe(true)
      const records = await Bun.file(Global.Path.lspPids).json()
      expect(records.processes).toHaveLength(2)
      records.processes[0].ownerIdentity += ":stale"
      records.processes[0].identity += ":unverified"
      await Bun.write(Global.Path.lspPids, JSON.stringify(records))
      await LSPPid.cleanupOrphans()
      expect(ProcessInspection.alive(children[0]!.pid!)).toBe(true)
      await Promise.all(releases.map((release) => release()))
      expect((await Bun.file(Global.Path.lspPids).json()).processes).toEqual([])
      await Bun.write(Global.Path.lspPids, JSON.stringify(children.map((child) => child.pid)))
      await LSPPid.cleanupOrphans()
      for (const child of children) expect(ProcessInspection.alive(child.pid!)).toBe(true)
    } finally {
      await Promise.all(
        children.map(async (child) => {
          const closed = once(child, "close")
          child.kill()
          await closed
        }),
      )
    }
  })
})
