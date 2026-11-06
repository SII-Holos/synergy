import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { WorkbenchViewTool } from "./tools/workbench-view"

const registered = RuntimeContext.state(() => ({ value: false }))

export function registerPresentationTools() {
  if (registered().value) return
  ToolRegistry.registerToolProvider("workbench-presentation", () => [WorkbenchViewTool])
  registered().value = true
}
