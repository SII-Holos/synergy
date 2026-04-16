import { Tool } from "./tool"
import z from "zod"

const parameters = z.object({
  task_id: z.string().optional().describe("Specific task ID to cancel"),
  all: z.boolean().optional().describe("Cancel all running tasks for this session"),
})

interface TaskCancelMetadata {
  taskId?: string
  cancelledCount?: number
  description?: string
}

export const TaskCancelTool = Tool.define<typeof parameters, TaskCancelMetadata>("task_cancel", {
  description: `Cancel visible background tasks.

## Parameters
- **task_id** (optional): Specific task ID visible from this session
- **all** (optional): Cancel all running tasks launched from this session and descendant subagents

## Usage
Cancel a specific visible task:
\`\`\`
task_cancel(task_id: "ctx_abc123")
\`\`\`

Cancel all running descendant tasks:
\`\`\`
task_cancel(all: true)
\`\`\``,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const { Cortex } = await import("../cortex")
    if (params.all) {
      const cancelled = await Cortex.cancelAll(ctx.sessionID)
      return {
        title: `Cancelled ${cancelled} tasks`,
        metadata: { cancelledCount: cancelled },
        output: `Cancelled ${cancelled} background task${cancelled !== 1 ? "s" : ""}.`,
      }
    }

    if (!params.task_id) {
      return {
        title: "No task specified",
        metadata: {},
        output: "Provide either task_id or all=true",
      }
    }

    const task = Cortex.getVisibleTask(ctx.sessionID, params.task_id)
    if (!task) {
      return {
        title: "Task unavailable",
        metadata: { taskId: params.task_id },
        output: `Task ${params.task_id} is not available from this session. Use \`task_list()\` to inspect visible tasks first.`,
      }
    }

    await Cortex.cancel(params.task_id)
    return {
      title: `Cancelled ${params.task_id}`,
      metadata: { taskId: params.task_id, description: task.description },
      output: `Task ${params.task_id} cancelled.`,
    }
  },
})
