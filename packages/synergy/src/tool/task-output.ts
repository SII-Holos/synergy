import { Tool } from "./tool"
import z from "zod"
import { ToolTimeout } from "./timeout"
import { CortexTypes } from "../cortex/types"

const DEFAULT_WAIT_S = ToolTimeout.DEFAULTS.taskOutputWaitMs / 1_000

const parameters = z.object({
  task_id: z.string().optional().describe("Task ID from a visible background task"),
  mode: z
    .enum(["summary", "progress", "tail", "full"])
    .optional()
    .describe(
      "Output mode: progress for live status, tail for recent session activity, full for final output. Default: full",
    ),
  block: z.boolean().optional().describe("Wait for completion if still running"),
  timeout: z.number().optional().describe(`Max seconds to wait (default: ${DEFAULT_WAIT_S})`),
})

interface TaskOutputMetadata {
  taskId?: string
  status?: CortexTypes.TaskStatus
  found: boolean
  description?: string
  timeout?: number
  mode?: string
  visibleTaskIds?: string[]
  output?: CortexTypes.TaskOutput
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
- **mode** (optional): Output mode:
  - \`progress\` — live status (health, tool calls, duration)
  - \`tail\` — recent session activity from the subagent
  - \`full\` — final result with progress summary, including structured output as rendered JSON (default)
  - \`summary\` — compact one-liner (status, health, elapsed)
- **block** (optional): Wait for completion if still running
- **timeout** (optional): Maximum seconds to wait (default: 300)

Subagents commonly run 5–30 minutes. Still running is not a problem — check mode="progress" to see what it's doing, or just wait for the automatic completion notification.

## Usage
List visible tasks first:
\`\`\`
task_output()
\`\`\`

Check live progress without waiting:
\`\`\`
task_output(task_id: "ctx_abc123", mode: "progress")
\`\`\`

Inspect recent activity:
\`\`\`
task_output(task_id: "ctx_abc123", mode: "tail")
\`\`\`

Compact status check:
\`\`\`
task_output(task_id: "ctx_abc123", mode: "summary")
\`\`\`

Wait for completion (up to 300s):
\`\`\`
task_output(task_id: "ctx_abc123", block: true)
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
        const info = Cortex.describe(task)
        const last = info.lastTool
          ? ` — last: ${info.lastTool}${info.lastToolStatus ? ` ${info.lastToolStatus}` : ""}`
          : ""
        return `- \`${task.id}\` — ${task.status} — @${task.agent} — ${task.description} [${duration}, ${info.health}]${last}`
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
          'Use `task_output(task_id="...", mode="progress")` for live status.',
          'Use `task_output(task_id="...", mode="tail")` for recent activity.',
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
        mode: params.mode ?? "full",
        visibleTaskIds: visibleTasks.map((item) => item.id),
      },
    })

    if ((task.status === "running" || task.status === "queued") && params.block) {
      await Cortex.waitFor(params.task_id, params.timeout ?? DEFAULT_WAIT_S)
    }

    const current = Cortex.getVisibleTask(ctx.sessionID, params.task_id) ?? task
    const output = await Cortex.output(params.task_id, params.mode ?? "full")

    return {
      title: `Task ${params.task_id}`,
      metadata: {
        taskId: params.task_id,
        status: current.status,
        found: true,
        description: current.description,
        timeout: params.timeout,
        mode: params.mode ?? "full",
        visibleTaskIds: visibleTasks.map((item) => item.id),
        output: current.output,
      },
      output,
    }
  },
  async afterPersist(params, ctx, result) {
    if (!params.task_id || !result.metadata.found) return
    const status = result.metadata.status
    if (status !== "completed" && status !== "error" && status !== "cancelled" && status !== "interrupted") return
    const { Cortex } = await import("../cortex")
    Cortex.acknowledgeParentCompletion({ taskID: params.task_id, parentSessionID: ctx.sessionID })
  },
})
