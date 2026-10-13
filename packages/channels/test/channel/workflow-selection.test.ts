import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ChannelCommand } from "../../src/channel/command"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"

test("registered workflow owners do not implicitly install Channel commands", async () => {
  await using runtime = await testRuntime({
    register() {
      for (const id of ["plan", "lightloop", "lattice"])
        WorkflowKindRegistry.register({
          id,
          conflicts: [],
          async enable() {
            throw new Error("Unexpected workflow activation")
          },
        })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const context = { channelType: "test", accountId: "fixture", chatId: "chat", messageId: "message" }
        const help = await ChannelCommand.execute("/help", context, Scope.home())
        expect(help.action === "handled" && help.reply).not.toMatch(/\/plan|\/blueprint|\/lightloop|\/lattice/)
        for (const command of ["/plan", "/lightloop task", "/lattice goal"])
          expect(await ChannelCommand.execute(command, context, Scope.home())).toEqual({ action: "skip" })
      },
    }),
  )
})
