import { afterAll, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
describe("Blueprint plugin terminal delivery", () => {
  test("delivers blueprint.after only once for terminal plugin-owned loops", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin
      const calls: unknown[][] = []
      ;(Plugin as any).deliverHookForPlugin = mock(async (...args: unknown[]) => {
        calls.push(args)
        return { status: "delivered", handlerCount: 1 }
      })

      try {
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const pluginLoop = await BlueprintLoopStore.create({
              noteID: "note_plugin_hook",
              title: "Plugin loop",
              sessionID: "ses_plugin_hook",
              source: "plugin",
              pluginOwner: {
                pluginId: "research-plugin",
                pluginGeneration: "generation-one",
                scopeId: scope.id,
              },
            })
            await BlueprintLoopStore.updateStatus(scope.id, pluginLoop.id, { status: "cancelled" })

            const userLoop = await BlueprintLoopStore.create({
              noteID: "note_user_hook",
              title: "User loop",
              sessionID: "ses_user_hook",
            })
            await BlueprintLoopStore.updateStatus(scope.id, userLoop.id, { status: "cancelled" })

            expect(calls).toHaveLength(1)
            expect(calls[0]).toEqual([
              "research-plugin",
              "generation-one",
              "blueprint.after",
              { loop: expect.objectContaining({ id: pluginLoop.id, status: "cancelled", source: "plugin" }) },
            ])
            const delivered = await BlueprintLoopStore.get(scope.id, pluginLoop.id)
            expect(delivered.terminalHookDeliveredAt).toBeNumber()
            expect(delivered.terminalHookError).toBeUndefined()
          },
        })
      } finally {
        ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
      }
    }))

  test("records blueprint.after failures and retries until delivery succeeds", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin
      let attempt = 0
      ;(Plugin as any).deliverHookForPlugin = mock(async () => {
        attempt++
        if (attempt === 1) {
          return {
            status: "failed",
            handlerCount: 1,
            error: "Hook blueprint.after handler failed: state write failed",
          }
        }
        return { status: "delivered", handlerCount: 1 }
      })

      try {
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const loop = await BlueprintLoopStore.create({
              noteID: "note_plugin_retry",
              title: "Plugin retry",
              sessionID: "ses_plugin_retry",
              source: "plugin",
              pluginOwner: {
                pluginId: "research-plugin",
                pluginGeneration: "generation-one",
                scopeId: scope.id,
              },
            })
            await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" })
            const failed = await BlueprintLoopStore.get(scope.id, loop.id)
            expect(failed.terminalHookDeliveredAt).toBeUndefined()
            expect(failed.terminalHookError).toContain("state write failed")

            await BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id)
            const retried = await BlueprintLoopStore.get(scope.id, loop.id)
            expect(retried.terminalHookDeliveredAt).toBeNumber()
            expect(retried.terminalHookError).toBeUndefined()
            expect(attempt).toBe(2)
          },
        })
      } finally {
        ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
      }
    }))

  test("serializes concurrent blueprint.after retries into one delivery", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope
      const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin

      try {
        await ScopeContext.provide({
          scope,
          fn: async () => {
            ;(Plugin as any).deliverHookForPlugin = mock(async () => ({
              status: "failed",
              handlerCount: 1,
              error: "temporary failure",
            }))
            const loop = await BlueprintLoopStore.create({
              noteID: "note_plugin_concurrent",
              title: "Plugin concurrent delivery",
              sessionID: "ses_plugin_concurrent",
              source: "plugin",
              pluginOwner: {
                pluginId: "research-plugin",
                pluginGeneration: "generation-one",
                scopeId: scope.id,
              },
            })
            await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" })

            const delivery = mock(async () => {
              await Bun.sleep(10)
              return { status: "delivered", handlerCount: 1 }
            })
            ;(Plugin as any).deliverHookForPlugin = delivery
            await Promise.all([
              BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id),
              BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id),
            ])

            expect(delivery).toHaveBeenCalledTimes(1)
            const updated = await BlueprintLoopStore.get(scope.id, loop.id)
            expect(updated.terminalHookDeliveredAt).toBeNumber()
          },
        })
      } finally {
        ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
      }
    }))
})
