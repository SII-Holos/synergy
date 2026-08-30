import { ToolRegistry } from "../tool/registry"
import { TaskTool } from "./tools/task"
import { TaskListTool } from "./tools/task-list"
import { TaskOutputTool } from "./tools/task-output"
import { TaskCancelTool } from "./tools/task-cancel"

/**
 * Cortex domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerCortexTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("cortex", () => [TaskTool, TaskListTool, TaskOutputTool, TaskCancelTool])
}
