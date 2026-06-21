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
