import { afterEach, describe, expect, mock, test } from "bun:test"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LightLoopRuntime } from "../../src/session/light-loop-runtime"
import { LightLoopTerminalStore } from "../../src/session/light-loop-terminal-hook"
import { tmpdir } from "../fixture/fixture"

const originalDeliverHookForPlugin = (Plugin as any).deliverHookForPlugin

afterEach(() => {
  ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
})

async function createPluginLightLoop(input?: { status?: "completed"; deliveredAt?: number }) {
  const session = await Session.create({})
  await Session.update(session.id, (draft) => {
    draft.workflow = {
      kind: "lightloop",
      instructions: "Finish the plugin-owned task",
      status: input?.status ?? "running",
      executionAgent: "plugin.executor",
      reviewAgent: "plugin.reviewer",
      pluginOwner: {
        pluginId: "test-plugin",
        pluginGeneration: "generation-one",
        scopeId: session.scope.id,
        correlationId: "correlation-one",
      },
      ...(input?.deliveredAt ? { terminalHookDeliveredAt: input.deliveredAt } : {}),
    }
  })
  return session
}

describe("LightLoop terminal hook delivery", () => {
  test("clears ordinary LightLoop state instead of persisting a terminal workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Finish the ordinary task",
            status: "running",
          }
        })
        const delivery = mock(async () => ({ status: "delivered", handlerCount: 1 }))
        ;(Plugin as any).deliverHookForPlugin = delivery

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")

        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
        expect(delivery).not.toHaveBeenCalled()
      },
    })
  })

  test("unequips before acknowledging one successful matching delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        const calls: unknown[][] = []
        ;(Plugin as any).deliverHookForPlugin = mock(async (...args: unknown[]) => {
          calls.push(args)
          expect((await Session.get(session.id)).workflow).toBeUndefined()
          return { status: "delivered", handlerCount: 1 }
        })

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")

        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect(await LightLoopTerminalStore.get(session)).toMatchObject({
          status: "completed",
          instructions: "Finish the plugin-owned task",
          hookDeliveredAt: expect.any(Number),
        })
        expect(calls).toEqual([
          [
            "test-plugin",
            "generation-one",
            "lightloop.after",
            {
              loop: {
                sessionID: session.id,
                status: "completed",
                instructions: "Finish the plugin-owned task",
              },
            },
          ],
        ])

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        expect(calls).toHaveLength(1)
      },
    })
  })

  test.each([
    {
      name: "no handler",
      delivery: {
        status: "no_handler" as const,
        handlerCount: 0,
        error: "Plugin test-plugin has no handler for lightloop.after",
      },
    },
    {
      name: "plugin generation mismatch",
      delivery: {
        status: "plugin_mismatch" as const,
        handlerCount: 0,
        error: "Plugin test-plugin generation generation-one is not active",
      },
    },
  ])("unequips and preserves an unacknowledged result for $name", async ({ delivery }) => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        ;(Plugin as any).deliverHookForPlugin = mock(async () => delivery)

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")

        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect(await LightLoopTerminalStore.get(session)).toMatchObject({
          status: "completed",
          hookError: delivery.error,
        })
        expect((await LightLoopTerminalStore.get(session))?.hookDeliveredAt).toBeUndefined()
      },
    })
  })

  test("records handler failure and retries until delivery succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        let attempt = 0
        ;(Plugin as any).deliverHookForPlugin = mock(async () => {
          attempt++
          if (attempt === 1) {
            return {
              status: "failed" as const,
              handlerCount: 1,
              error: "Hook lightloop.after handler on-finish failed: plugin state write failed",
            }
          }
          return { status: "delivered" as const, handlerCount: 1 }
        })

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect((await LightLoopTerminalStore.get(session))?.hookError).toContain("plugin state write failed")

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const terminal = await LightLoopTerminalStore.get(session)
        expect(terminal?.hookDeliveredAt).toBeNumber()
        expect(terminal?.hookError).toBeUndefined()
        expect(attempt).toBe(2)
      },
    })
  })

  test("serializes concurrent terminal calls into one acknowledged delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        const delivery = mock(async () => {
          await Bun.sleep(10)
          return { status: "delivered" as const, handlerCount: 1 }
        })
        ;(Plugin as any).deliverHookForPlugin = delivery

        await Promise.all([
          LightLoopRuntime.setTerminalStatus(session.id, "completed"),
          LightLoopRuntime.setTerminalStatus(session.id, "completed"),
        ])

        expect(delivery).toHaveBeenCalledTimes(1)
        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect((await LightLoopTerminalStore.get(session))?.hookDeliveredAt).toBeNumber()
      },
    })
  })

  test("terminal reconciliation migrates a retained plugin workflow and retries its hook", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop({ status: "completed" })
        const delivery = mock(async () => ({ status: "delivered" as const, handlerCount: 1 }))
        ;(Plugin as any).deliverHookForPlugin = delivery

        await LightLoopRuntime.reattachPluginTimers()

        expect(delivery).toHaveBeenCalledTimes(1)
        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect((await LightLoopTerminalStore.get(session))?.hookDeliveredAt).toBeNumber()
      },
    })
  })

  test("terminal retry does not clear a later ordinary workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        await LightLoopTerminalStore.put(session, {
          sessionID: session.id,
          status: "completed",
          instructions: "Finish the plugin-owned task",
          pluginOwner: {
            pluginId: "test-plugin",
            pluginGeneration: "generation-one",
            scopeId: session.scope.id,
            correlationId: "correlation-one",
          },
          createdAt: Date.now(),
        })
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lightloop", instructions: "Start a later ordinary task", status: "running" }
        })
        const delivery = mock(async () => ({ status: "delivered" as const, handlerCount: 1 }))
        ;(Plugin as any).deliverHookForPlugin = delivery

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")

        expect(delivery).toHaveBeenCalledTimes(1)
        expect((await Session.get(session.id)).workflow).toEqual({
          kind: "lightloop",
          instructions: "Start a later ordinary task",
          status: "running",
        })
      },
    })
  })
})
