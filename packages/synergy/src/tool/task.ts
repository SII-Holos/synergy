import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { defer } from "@/util/defer"
import { PermissionNext } from "@/permission/next"
import { Category } from "../cortex/category"
import { Provider } from "../provider/provider"
import { Instance } from "../scope/instance"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z
    .string()
    .describe(
      "The task for the agent to perform. Include: what to do, expected outcome, context. " +
        "Recommend also specifying what NOT to do (scope boundaries, forbidden actions) to prevent scope creep.",
    ),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  dag_node_id: z.string().optional().describe("DAG node ID to auto-update when this task completes"),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run task in background (async). Returns immediately with task_id. " +
        "Use for parallel exploration or long-running tasks. Default: false (sync)",
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Category preset to override model and inject context:\n" +
        Category.descriptions() +
        "\nDefault: none (uses subagent's original model and prompt)",
    ),
})

interface TaskMetadata {
  summary: { id: string; tool: string; state: { status: string; title?: string } }[]
  sessionId: string
  taskId?: string
  background?: boolean
}

const SYNC_TIMEOUT_S = 300

export const TaskTool = Tool.define<typeof parameters, TaskMetadata>("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary" && !a.hidden))

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      await ctx.ask({
        permission: "task",
        patterns: [params.subagent_type],
        metadata: {
          description: params.description,
          subagent_type: params.subagent_type,
        },
      })

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const msg = await MessageV2.get({
        scopeID: Instance.scope.id,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
      })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const parentModel = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      let model = ctx.extra?.subtaskModel ?? (await Agent.getAvailableModel(agent)) ?? parentModel
      let promptAppend = ""

      const categoryConfig = await Category.resolve(params.category)
      if (categoryConfig) {
        if (categoryConfig.model) {
          const parsed = Provider.parseModel(categoryConfig.model)
          model = { providerID: parsed.providerID, modelID: parsed.modelID }
        }
        promptAppend = categoryConfig.promptAppend ?? ""
      }

      const fullPrompt = promptAppend ? `${params.prompt}\n\n${promptAppend}` : params.prompt

      let sessionID: string | undefined
      if (params.session_id) {
        const found = await Session.get(params.session_id).catch(() => undefined)
        if (found) sessionID = found.id
      }

      const { Cortex } = await import("../cortex")
      const task = await Cortex.launch({
        description: params.description,
        prompt: fullPrompt,
        agent: params.subagent_type,
        executionRole: "delegated_subagent",
        category: params.category,
        dagNodeId: params.dag_node_id,
        parentSessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        sessionID,
        model,
      })

      if (params.background) {
        ctx.metadata({
          title: `[Background] ${params.description}`,
          metadata: {
            taskId: task.id,
            sessionId: task.sessionID,
            background: true,
            summary: [],
          },
        })

        return {
          title: `[Background] ${params.description}`,
          metadata: {
            taskId: task.id,
            sessionId: task.sessionID,
            background: true,
            summary: [],
          },
          output: `Background task launched.

Task ID: ${task.id}
Session ID: ${task.sessionID}
Description: ${task.description}
Agent: ${task.agent}${params.category ? ` (category: ${params.category})` : ""}
Status: running

You will be notified when the task completes.
Use \`task_list()\` to inspect visible background tasks.
Use \`task_output(task_id="${task.id}")\` only for a task visible from this session.`,
        }
      }

      ctx.metadata({
        title: params.description,
        metadata: { sessionId: task.sessionID },
      })

      function cancel() {
        void Cortex.cancel(task.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== task.sessionID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: task.sessionID,
          },
        })
      })

      const completed = await Cortex.waitFor(task.id, SYNC_TIMEOUT_S)
      unsub()

      if (!completed || completed.status === "running") {
        const summary = Object.values(parts).sort((a, b) => a.id.localeCompare(b.id))
        ctx.metadata({
          title: `[Auto-backgrounded] ${params.description}`,
          metadata: { taskId: task.id, sessionId: task.sessionID, background: true, summary },
        })
        return {
          title: `[Auto-backgrounded] ${params.description}`,
          metadata: { taskId: task.id, sessionId: task.sessionID, background: true, summary },
          output: `Task auto-backgrounded after ${SYNC_TIMEOUT_S}s timeout.

Task ID: ${task.id}
Session ID: ${task.sessionID}
Description: ${task.description}
Agent: ${task.agent}
Status: still running

You will be notified when the task completes.
Use \`task_list()\` to inspect visible background tasks.
Use \`task_output(task_id="${task.id}")\` only for a task visible from this session.`,
        }
      }

      const messages = await Session.messages({ sessionID: task.sessionID })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = completed.result ?? ""
      const output = text + "\n\n" + ["<task_metadata>", `session_id: ${task.sessionID}`, "</task_metadata>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: task.sessionID,
          taskId: undefined,
          background: false,
        },
        output,
      }
    },
  }
})
