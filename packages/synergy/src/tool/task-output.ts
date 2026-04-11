import { Tool } from "./tool"
import z from "zod"

const parameters = z.object({
  task_id: z.string().optional().describe("Task ID from a visible background task"),
  block: z.boolean().optional().describe("Wait for completion if still running"),
  timeout: z.number().optional().describe("Max seconds to wait (default: 60)"),
})

interface TaskOutputMetadata {
  taskId?: string
  status?: string
  found: boolean
  description?: string
  timeout?: number
  visibleTaskIds?: string[]
}

function formatDuration(startedAt: number, completedAt?: number) {
  const end = completedAt ?? Date.now()
  const seconds = Math.floor((end - startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export const TaskOutputTool = Tool.define<typeof parameters, TaskOutputMetadata>("task_output", {
  description: `Retrieve output from a visible background task.

## Parameters
- **task_id** (optional): Task ID from a visible background task
- **block** (optional): Wait for completion if still running
- **timeout** (optional): Maximum seconds to wait (default: 60)

## Usage
List visible tasks first:
\`\`\`
task_output()
\`\`\`

Retrieve one visible task:
\`\`\`
task_output(task_id: "ctx_abc123")
\`\`\`

Wait for completion:
\`\`\`
task_output(task_id: "ctx_abc123", block: true, timeout: 120)
\`\`\``,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const { Cortex } = await import("../cortex")
    const visibleTasks = Cortex.getVisibleTasks(ctx.sessionID).sort((a, b) => b.startedAt - a.startedAt)

    if (!params.task_id) {
      if (visibleTasks.length === 0) {
        return {
          title: "No visible tasks",
          metadata: { found: false, visibleTaskIds: [] },
          output: "No visible background tasks for this session.",
        }
      }

      const lines = visibleTasks.map((task) => {
        const duration = formatDuration(task.startedAt, task.completedAt)
        return `- \`${task.id}\` — ${task.status} — @${task.agent} — ${task.description} [${duration}]`
      })

      return {
        title: `Visible tasks (${visibleTasks.length})`,
        metadata: {
          found: false,
          visibleTaskIds: visibleTasks.map((task) => task.id),
        },
        output: [
          "Visible background tasks for this session:",
          ...lines,
          "",
          'Use `task_output(task_id="...")` for one of the visible task IDs listed above.',
        ].join("\n"),
      }
    }

    const task = Cortex.getVisibleTask(ctx.sessionID, params.task_id)
    if (!task) {
      return {
        title: "Task unavailable",
        metadata: { taskId: params.task_id, found: false, visibleTaskIds: visibleTasks.map((item) => item.id) },
        output: `Task ${params.task_id} is not available from this session. Use \`task_list()\` or \`task_output()\` to inspect visible tasks first.`,
      }
    }

    ctx.metadata({
      title: task.description ?? `Task ${params.task_id}`,
      metadata: {
        taskId: params.task_id,
        status: task.status,
        found: true,
        description: task.description,
        timeout: params.timeout,
        visibleTaskIds: visibleTasks.map((item) => item.id),
      },
    })

    if ((task.status === "running" || task.status === "queued") && params.block) {
      await Cortex.waitFor(params.task_id, params.timeout ?? 60)
    }

    const current = Cortex.getVisibleTask(ctx.sessionID, params.task_id) ?? task
    const output = await Cortex.output(params.task_id)

    return {
      title: `Task ${params.task_id}`,
      metadata: {
        taskId: params.task_id,
        status: current.status,
        found: true,
        description: current.description,
        timeout: params.timeout,
        visibleTaskIds: visibleTasks.map((item) => item.id),
      },
      output,
    }
  },
})
