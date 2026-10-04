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

export function registerCortexTools(): void {
  Tool.registerInputHistory("cortex", {
    task: {
      description: "taskTitle",
      prompt: "taskInstructions",
    },
    task_output: { task_id: "taskId" },
    task_cancel: { task_id: "taskId" },
  })

  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("cortex", () => [TaskTool, TaskListTool, TaskOutputTool, TaskCancelTool])
}
