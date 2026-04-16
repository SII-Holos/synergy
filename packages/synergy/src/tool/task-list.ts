import { Tool } from "./tool"
import z from "zod"

const parameters = z.object({})

interface TaskListMetadata {
  count: number
  taskIds: string[]
}

function formatDuration(startedAt: number, completedAt?: number) {
  const end = completedAt ?? Date.now()
  const seconds = Math.floor((end - startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export const TaskListTool = Tool.define<typeof parameters, TaskListMetadata>("task_list", {
  description: `List background tasks visible from the current session.

Use this before \`task_output\` when you need to ground yourself in which background tasks are actually available.

## Usage
\`\`\`
task_list()
\`\`\``,
  parameters,
  async execute(_params: z.infer<typeof parameters>, ctx) {
    const { Cortex } = await import("../cortex")
    const tasks = Cortex.getVisibleTasks(ctx.sessionID)
    if (tasks.length === 0) {
      return {
        title: "No visible tasks",
        metadata: { count: 0, taskIds: [] },
        output: "No visible background tasks for this session.",
      }
    }

    const lines = tasks
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((task) => {
        const duration = formatDuration(task.startedAt, task.completedAt)
        return `- \`${task.id}\` — ${task.status} — @${task.agent} — ${task.description} [${duration}]`
      })

    return {
      title: `Visible tasks (${tasks.length})`,
      metadata: { count: tasks.length, taskIds: tasks.map((task) => task.id) },
      output: ["Visible background tasks for this session:", ...lines].join("\n"),
    }
  },
})
