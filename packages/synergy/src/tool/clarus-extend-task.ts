import z from "zod"
import { Channel } from "@/channel"
import { ClarusProvider } from "@/channel/provider/clarus"
import { parseClarusRequestFailure } from "@/channel/provider/clarus/agent-tunnel-port"
import { ClarusAssignmentStore } from "@/channel/provider/clarus/assignment-store"
import { ClarusExtendPayload } from "@/channel/provider/clarus/extension-outbox"
import { Tool } from "./tool"

function toolError(code: string, message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, metadata)
}

const Parameters = ClarusExtendPayload.extend({
  extend_seconds: z
    .number()
    .int()
    .min(60)
    .max(86_400)
    .describe("How many seconds to add to the current Clarus assignment deadline."),
  progress: z.string().max(500).optional().describe("Optional concise progress update for Clarus."),
  payload: ClarusExtendPayload.shape.payload.describe("Optional bounded structured extension metadata."),
})

export const ClarusExtendTaskTool = Tool.define(
  "clarus_extend_task",
  {
    description:
      "Extend the current Clarus assignment deadline. The current session supplies assignment identity; never provide project, task, run, subtask, or account IDs.",
    parameters: Parameters,
    async execute(params, ctx) {
      if (!(await ClarusAssignmentStore.findBySessionID(ctx.sessionID))) {
        throw toolError("CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION", "This session is not bound to a Clarus assignment")
      }
      const provider = Channel.getProvider("clarus")
      if (!(provider instanceof ClarusProvider)) {
        throw toolError("CLARUS_PROVIDER_UNAVAILABLE", "The Clarus Channel provider is unavailable")
      }

      try {
        const result = await provider.extendTask({
          sessionID: ctx.sessionID,
          payload: params,
          signal: ctx.abort,
        })
        return {
          title: "Clarus assignment deadline extended",
          output: "Clarus acknowledged the deadline extension.",
          metadata: { requestID: result.requestID, extendSeconds: params.extend_seconds },
        }
      } catch (error) {
        const failure = parseClarusRequestFailure(error)
        if (failure?.disposition === "not_dispatched") {
          throw toolError(
            failure.code,
            "The extension was not dispatched. The Clarus Channel will retry it after the connection recovers.",
            { disposition: failure.disposition, requestID: failure.requestID },
          )
        }
        if (failure?.disposition === "rejected") {
          throw toolError(
            failure.code,
            "Clarus rejected the extension. Do not retry unless the assignment is renewed.",
            {
              disposition: failure.disposition,
              requestID: failure.requestID,
            },
          )
        }
        if (failure?.disposition === "ambiguous") {
          throw toolError(
            "CLARUS_EXTENSION_AMBIGUOUS",
            "Clarus may have extended the deadline. Do not retry unless the assignment is renewed or externally reconciled.",
            { disposition: failure.disposition, requestID: failure.requestID, reason: failure.reason },
          )
        }
        throw error
      }
    },
  },
  {
    exposure: {
      mode: "search",
      title: "Extend Clarus Assignment Deadline",
      keywords: ["clarus", "extend", "assignment", "deadline", "progress"],
    },
  },
)
