import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./financial-search.txt"
import { Agent } from "../agent/agent"
import { defer } from "@/util/defer"

const SYNC_TIMEOUT_S = 600

export const FinancialSearchTool = Tool.define("financial_search", {
  description: DESCRIPTION,
  parameters: z.object({
    question: z.string().describe("The financial question or information need to research"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "financial_search",
      patterns: [params.question],
      metadata: {
        question: params.question,
      },
    })

    const agent = await Agent.get("financial")
    if (!agent) throw new Error("Financial agent not configured")

    const { Cortex } = await import("../cortex")
    const task = await Cortex.launch({
      description: `Financial research: ${params.question.slice(0, 50)}`,
      prompt: params.question,
      agent: "financial",
      executionRole: "primary",
      parentSessionID: ctx.sessionID,
      parentMessageID: ctx.messageID,
    })

    ctx.metadata({
      title: `Financial research: ${params.question.slice(0, 50)}`,
      metadata: { sessionId: task.sessionID, taskId: task.id },
    })

    function cancel() {
      void Cortex.cancel(task.id)
    }
    ctx.abort.addEventListener("abort", cancel)
    using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

    const completed = await Cortex.waitFor(task.id, SYNC_TIMEOUT_S)

    if (!completed || completed.status === "running") {
      return {
        title: `Financial research (timeout): ${params.question.slice(0, 40)}`,
        output: `Financial research task timed out after ${SYNC_TIMEOUT_S}s. The search is still running in the background.\n\nTask ID: ${task.id}\nSession ID: ${task.sessionID}`,
        metadata: { sessionId: task.sessionID, taskId: task.id },
      }
    }

    const result = completed.result ?? "No results found."

    return {
      title: `Financial research: ${params.question.slice(0, 40)}`,
      output: result,
      metadata: { sessionId: task.sessionID, taskId: task.id },
    }
  },
})
