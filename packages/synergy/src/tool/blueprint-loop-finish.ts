import z from "zod"
import { Tool } from "./tool"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { Instance } from "../scope/instance"
import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import DESCRIPTION from "./blueprint-loop-finish.txt"

const parameters = z.object({
  loopID: z.string().describe("The BlueprintLoop ID to finish."),
  status: z
    .enum(["auditing", "failed", "completed"])
    .describe("The new status — 'auditing' (execution agent only), 'failed', or 'completed' (supervisor only)."),
  summary: z.string().optional().describe("Optional summary of the finish reason or audit result."),
})

const EXECUTION_AGENTS = new Set([
  "synergy",
  "synergy-max",
  "developer",
  "implementation-engineer",
  "explore",
  "scout",
  "advisor",
  "inspector",
  "scribe",
  "scholar",
  "intent-analyst",
  "requirements-engineer",
  "code-cartographer",
  "solution-architect",
  "test-strategist",
  "research-scout",
  "docs-researcher",
  "literature-searcher",
  "literature-analyst",
  "research-methodologist",
  "quality-gatekeeper",
  "memory-curator",
  "note-librarian",
  "session-historian",
])

function isSupervisor(agent: string): boolean {
  return agent === "supervisor"
}

function isExecutionAgent(agent: string): boolean {
  return EXECUTION_AGENTS.has(agent)
}

export const BlueprintLoopFinishTool = Tool.define("blueprint_loop_finish", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const scopeID = Instance.scope.id

    try {
      await BlueprintLoopStore.get(scopeID, params.loopID)
    } catch {
      throw new LoopError.NotFound({ id: params.loopID })
    }

    const agentName = ctx.agent

    if (isSupervisor(agentName)) {
      if (params.status === "auditing") {
        throw new Error(
          `Supervisor cannot set loop status to "auditing". Supervisors can only set "completed" or "failed".`,
        )
      }
    } else if (isExecutionAgent(agentName)) {
      if (params.status === "completed") {
        throw new Error(
          `Execution agent "${agentName}" cannot set loop status to "completed". Only the supervisor can complete a loop. Use "auditing" or "failed" instead.`,
        )
      }
    } else {
      if (params.status === "completed") {
        throw new Error(
          `Agent "${agentName}" does not have permission to set loop status to "completed". Only the supervisor can complete a loop.`,
        )
      }
    }
    let supervisorSessionID: string | undefined

    if (params.status === "auditing") {
      const loop = await BlueprintLoopStore.get(scopeID, params.loopID)
      const auditPrompt = `Audit BlueprintLoop ${params.loopID} (Note ${loop.noteID}) in session ${loop.sessionID}.
Read the Blueprint Note via blueprint_read, examine the implementation evidence (session trajectory, git diff, test results), and determine if the Blueprint is fully implemented.
If NOT fully implemented, call blueprint_loop_restart with detailed reason.
If fully implemented, call blueprint_loop_finish(status="completed").`
      const { Cortex } = await import("../cortex")
      const task = await Cortex.launch({
        description: `[Supervisor] Audit BlueprintLoop ${params.loopID}`,
        prompt: auditPrompt,
        agent: "supervisor",
        executionRole: "delegated_subagent",
        category: "general",
        parentSessionID: loop.sessionID,
        parentMessageID: ctx.messageID,
      })
      supervisorSessionID = task.sessionID
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, {
        status: "auditing",
        supervisorSessionID,
      })
      await Bus.publish(LoopEvent.Auditing, { loopID: params.loopID })
    } else if (params.status === "failed") {
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, { status: "failed" })
      await Bus.publish(LoopEvent.Failed, { loopID: params.loopID, error: params.summary ?? "Loop execution failed" })
    } else if (params.status === "completed") {
      await BlueprintLoopStore.updateStatus(scopeID, params.loopID, { status: "completed" })
      await Bus.publish(LoopEvent.Completed, { loopID: params.loopID })
    }

    const statusLabel: Record<string, string> = {
      auditing: "auditing",
      failed: "failed",
      completed: "completed",
    }

    return {
      title: `Loop ${params.loopID} → ${params.status}`,
      output: [
        `BlueprintLoop ${params.loopID} is now ${statusLabel[params.status]}.`,
        supervisorSessionID ? `Supervisor session: ${supervisorSessionID}` : "",
        params.summary ? `Summary: ${params.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        loopID: params.loopID,
        status: params.status,
        supervisorSessionID,
      } as Record<string, any>,
    }
  },
})
