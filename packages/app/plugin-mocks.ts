import { mock } from "bun:test"

// ── Mock @ericsanchezok/synergy-ui/message-part ───────────────────
// tool-registry.ts and part-registry.ts import from this module.
// Without this mock, the import chain pulls in lucide-solid → solid-js/web,
// which crashes bun:test with "Client-only API called on the server side".
const partMapping: Record<string, any> = {}
mock.module("@ericsanchezok/synergy-ui/message-part", () => ({
  ToolRegistry: {
    register: () => {},
    render: () => undefined,
  },
  registerPartComponent: (type: string, component: any) => {
    partMapping[type] = component
  },
  PART_MAPPING: partMapping,
}))
// ── Mock @ericsanchezok/synergy-ui/icon ───────────────────────────
// AppPanel → @ericsanchezok/synergy-ui/icon → lucide-solid →
// solid-js/web, which crashes bun:test's SSR environment with
// "Client-only API called on the server side".
const IconStub = () => null
mock.module("@ericsanchezok/synergy-ui/icon", () => ({
  Icon: IconStub,
}))
// ── Mock @/context/global-sync ────────────────────────────────────
// clarus.tsx imports useGlobalSync from @/context/global-sync for
// reconnectVersion wiring. global-sync pulls in showToast → toast →
// @kobalte/core/toast → solid-js/web, which crashes bun:test's SSR
// environment with "Client-only API called on the server side".
// Mocking the context avoids the whole import chain.
const globalSyncModulePath = import.meta.resolveSync("@/context/global-sync")
mock.module(globalSyncModulePath, () => {
  let _v = 0
  return {
    GlobalSyncProvider: (p: any) => p.children ?? null,
    useGlobalSync: () => ({
      get reconnectVersion() {
        return _v
      },
    }),
  }
})
