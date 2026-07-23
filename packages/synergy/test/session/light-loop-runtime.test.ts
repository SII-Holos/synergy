import { afterEach, describe, expect, mock, test } from "bun:test"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LightLoopRuntime } from "../../src/session/light-loop-runtime"
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
        expect(delivery).not.toHaveBeenCalled()
      },
    })
  })

  test("acknowledges one successful matching delivery and does not redeliver", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        const calls: unknown[][] = []
        ;(Plugin as any).deliverHookForPlugin = mock(async (...args: unknown[]) => {
          calls.push(args)
          return { status: "delivered", handlerCount: 1 }
        })

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const delivered = await Session.get(session.id)
        expect(delivered.workflow?.kind).toBe("lightloop")
        if (delivered.workflow?.kind !== "lightloop") return
        expect(delivered.workflow.terminalHookDeliveredAt).toBeNumber()
        expect(delivered.workflow.terminalHookError).toBeUndefined()
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

  test("does not acknowledge when the target plugin has no handler", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        ;(Plugin as any).deliverHookForPlugin = mock(async () => ({
          status: "no_handler",
          handlerCount: 0,
          error: "Plugin test-plugin has no handler for lightloop.after",
        }))

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const updated = await Session.get(session.id)
        expect(updated.workflow?.kind).toBe("lightloop")
        if (updated.workflow?.kind !== "lightloop") return
        expect(updated.workflow.terminalHookDeliveredAt).toBeUndefined()
        expect(updated.workflow.terminalHookError).toBe("Plugin test-plugin has no handler for lightloop.after")
      },
    })
  })

  test("does not acknowledge a plugin generation mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop()
        ;(Plugin as any).deliverHookForPlugin = mock(async () => ({
          status: "plugin_mismatch",
          handlerCount: 0,
          error: "Plugin test-plugin generation generation-one is not active",
        }))

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const updated = await Session.get(session.id)
        expect(updated.workflow?.kind).toBe("lightloop")
        if (updated.workflow?.kind !== "lightloop") return
        expect(updated.workflow.terminalHookDeliveredAt).toBeUndefined()
        expect(updated.workflow.terminalHookError).toBe("Plugin test-plugin generation generation-one is not active")
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
              status: "failed",
              handlerCount: 1,
              error: "Hook lightloop.after handler on-finish failed: plugin state write failed",
            }
          }
          return { status: "delivered", handlerCount: 1 }
        })

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const failed = await Session.get(session.id)
        expect(failed.workflow?.kind).toBe("lightloop")
        if (failed.workflow?.kind !== "lightloop") return
        expect(failed.workflow.terminalHookDeliveredAt).toBeUndefined()
        expect(failed.workflow.terminalHookError).toContain("plugin state write failed")

        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        const retried = await Session.get(session.id)
        expect(retried.workflow?.kind).toBe("lightloop")
        if (retried.workflow?.kind !== "lightloop") return
        expect(retried.workflow.terminalHookDeliveredAt).toBeNumber()
        expect(retried.workflow.terminalHookError).toBeUndefined()
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
          return { status: "delivered", handlerCount: 1 }
        })
        ;(Plugin as any).deliverHookForPlugin = delivery

        await Promise.all([
          LightLoopRuntime.setTerminalStatus(session.id, "completed"),
          LightLoopRuntime.setTerminalStatus(session.id, "completed"),
        ])

        expect(delivery).toHaveBeenCalledTimes(1)
        const updated = await Session.get(session.id)
        expect(updated.workflow?.kind).toBe("lightloop")
        if (updated.workflow?.kind !== "lightloop") return
        expect(updated.workflow.terminalHookDeliveredAt).toBeNumber()
      },
    })
  })

  test("terminal reconciliation retries an unacknowledged plugin hook", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createPluginLightLoop({ status: "completed" })
        const delivery = mock(async () => ({ status: "delivered", handlerCount: 1 }))
        ;(Plugin as any).deliverHookForPlugin = delivery

        await LightLoopRuntime.reattachPluginTimers()

        expect(delivery).toHaveBeenCalledTimes(1)
        const updated = await Session.get(session.id)
        expect(updated.workflow?.kind).toBe("lightloop")
        if (updated.workflow?.kind !== "lightloop") return
        expect(updated.workflow.terminalHookDeliveredAt).toBeNumber()
      },
    })
  })
})
