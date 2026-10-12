import { expect, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
import { connectionStatusRows } from "../src/startup-status"
import { testRuntime } from "./support/runtime"

test("Connections status composes selected owners and releases live reports with the Scope", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({})
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const reports: RuntimeStatusRow[][] = []
        expect(await connectionStatusRows((rows) => reports.push(rows))).toEqual([
          { label: "Channels", value: "none configured", kind: "muted" },
          { label: "Holos", value: "agent network disconnected", kind: "muted" },
        ])
        await Bus.publish(Channel.Event.Connected, { channelType: "fixture", accountId: "one" })
        expect(reports).toEqual([[{ label: "Channels", value: "fixture:one reconnected", kind: "success" }]])
        await ScopedState.dispose(scope.id)
        await Bus.publish(Channel.Event.Disconnected, { channelType: "fixture", accountId: "one", reason: "closed" })
        expect(reports).toHaveLength(1)
      },
    })
  })
})
