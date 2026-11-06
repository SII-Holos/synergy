import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { registerWorker } from "../src/worker"
import { LightLoopTerminalStore } from "@ericsanchezok/synergy-light-loop/light-loop/terminal-hook"
import { lightLoopPluginAdapter } from "../src/adapter"

test("Plugin Light Loop keeps owner metadata and acknowledges its durable terminal delivery", async () => {
  const delivery = spyOn(Plugin, "deliverHookForPlugin").mockResolvedValue({
    status: "delivered",
    handlerCount: 1,
  })
  try {
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime()
          lightLoop().register()
          registerWorker()
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          const pluginOwner = {
            pluginId: "example",
            pluginGeneration: "one",
            scopeId: session.scope.id,
            correlationId: "request",
          }
          await lightLoopPluginAdapter.start(session.id, {
            instructions: "Complete the work",
            pluginOwner,
            deadlineAt: Date.now() + 60000,
          })
          expect(lightLoopPluginAdapter.getActive(await Session.get(session.id))).toMatchObject({
            instructions: "Complete the work",
            pluginOwner,
          })
          await lightLoopPluginAdapter.setTerminalStatus(session.id, "cancelled")
          expect((await Session.get(session.id)).workflow).toBeUndefined()
          const terminal = await lightLoopPluginAdapter.getTerminal(session)
          expect(terminal).toMatchObject({ status: "cancelled", pluginOwner })
          expect((await LightLoopTerminalStore.get(session))?.hookDeliveredAt).toBeNumber()
          expect(delivery).toHaveBeenCalledTimes(1)
          await lightLoopPluginAdapter.clear(session.id)
          expect((await Session.get(session.id)).time.archived).toBeNumber()
        },
      }),
    )
  } finally {
    delivery.mockRestore()
  }
})
