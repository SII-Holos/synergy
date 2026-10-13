import { expect, test } from "bun:test"
import { commands, status } from "../src/cli-adapter"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "./support/runtime"

test("Holos CLI exposes its own command and disconnected status without activating Clarus", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect(commands.map((entry) => entry.command)).toEqual(["holos"])
        expect((await commands[0]!.load()).command).toContain("holos")
        expect(await status(false, () => {})).toEqual([])
        const rows = await status(true, () => {})
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ label: "Holos", kind: "muted" })
      },
    }),
  )
})
