import { expect, test } from "bun:test"
import { commands, status } from "../src/cli-adapter"
import { ChannelSetup } from "../src/channel/setup"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "./support/runtime"

test("Channels CLI loads only its command and leaves absent provider setup unavailable", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect(commands.map((entry) => entry.command)).toEqual(["channel"])
        expect((await commands[0]!.load()).command).toContain("channel")
        expect(ChannelSetup.list()).toEqual([])
        expect(ChannelSetup.get("feishu")).toBeUndefined()
        expect(await status(false, () => {})).toEqual([])
        expect(await status(true, () => {})).toEqual([{ label: "Channels", value: "none configured", kind: "muted" }])
      },
    }),
  )
})
