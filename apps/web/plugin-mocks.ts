import path from "node:path"
import { organizationSourceDOMFiles } from "./script/test-options"
import { mock } from "bun:test"

// ── Mock @ericsanchezok/synergy-ui/message-part ───────────────────
// tool-registry.ts and part-registry.ts import from this module.
// Without this mock, the import chain pulls in lucide-solid → solid-js/web,
// which crashes bun:test with "Client-only API called on the server side".
const sourceDOM = process.argv.some((argument) =>
  organizationSourceDOMFiles.some((file) => path.resolve(argument) === path.resolve(import.meta.dir, file)),
)
if (!sourceDOM) {
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
}
