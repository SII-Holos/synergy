import { expect, test } from "bun:test"
import type { PluginWorkbenchService } from "@ericsanchezok/synergy-plugin"
import { bindPluginWorkbench } from "../../src/plugin/surface-workbench"
import { createPluginSurfaceAccess } from "../../src/plugin/surface-access"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("workbench guards are released with their surface and revoked handles cannot act", async () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  let guards = 0
  let closed = 0
  const source = {
    beforeClose() {
      guards++
      return () => {
        guards--
      }
    },
    async close() {
      closed++
      return true
    },
  } as unknown as PluginWorkbenchService
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["workbench.write"],
    current: () => true,
  })
  const service = bindPluginWorkbench(source, access, lifetime.context)
  service.beforeClose("resource", () => false)
  expect(guards).toBe(1)
  lifetime.dispose()
  expect(guards).toBe(0)
  expect(service.close("resource")).rejects.toThrow()
  expect(closed).toBe(0)
})

test("shell presentation alone grants no workbench mutation or reads", () => {
  const lifetime = createPluginSurfaceLifetime(() => {})
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: ["ui.shell"],
    current: () => true,
  })
  const service = bindPluginWorkbench({} as PluginWorkbenchService, access, lifetime.context)
  expect(() => service.tabs("side")).toThrow("workbench.read")
  expect(() => service.update("resource", { dirty: true })).toThrow("workbench.write")
  lifetime.dispose()
})
