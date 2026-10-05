import { Tool } from "../tool/tool"
import { RuntimeContext } from "../lifecycle/context"
import { ToolRegistry } from "../tool/registry"
import { TaskTool } from "./tools/task"
import { TaskListTool } from "./tools/task-list"
import { TaskOutputTool } from "./tools/task-output"
import { TaskCancelTool } from "./tools/task-cancel"

/**
 * Cortex domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function cortexTools() {
  return [TaskTool, TaskListTool, TaskOutputTool, TaskCancelTool]
}

/** Register owned history when a host supplies its own tool catalog. */
export function registerCortexToolInputHistory(): void {
  Tool.registerInputHistory("cortex", {
    task: {
      description: "taskTitle",
      prompt: "taskInstructions",
    },
    task_output: { task_id: "taskId" },
    task_cancel: { task_id: "taskId" },
  })
}

export function registerCortexTools(): void {
  registerCortexToolInputHistory()
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("cortex", cortexTools)
}
