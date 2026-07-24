import { Channel } from "@/channel"
import { ClarusProvider } from "@/channel/provider/clarus"
import { parseClarusRequestFailure } from "@/channel/provider/clarus/agent-tunnel-port"
import { ClarusAssignmentStore } from "@/channel/provider/clarus/assignment-store"
import { ClarusExtendPayload } from "@/channel/provider/clarus/extension-outbox"
import { Tool } from "./tool"

function toolError(code: string, message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, metadata)
}

const MAX_REJECTION_CODE_LENGTH = 128
const MAX_REJECTION_MESSAGE_LENGTH = 500

function safeRejectionCode(code: string): string {
  const normalized = code.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_REJECTION_CODE_LENGTH)
  return normalized || "CLARUS_EXTENSION_REJECTED"
}

function safeRejectionMessage(message: string): string {
  const redacted = message
    .replaceAll(
      /[\u0000-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g,
      " ",
    )
    .replaceAll(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/gi, "Bearer [redacted]")
    .replaceAll(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|credential|secret|token|password)\s*[=:]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replaceAll(/\s+/g, " ")
    .trim()
  if (!redacted) return "The upstream service did not provide a rejection message."
  return redacted.length <= MAX_REJECTION_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_REJECTION_MESSAGE_LENGTH - 1)}…`
}

const Parameters = ClarusExtendPayload.extend({
  extend_seconds: ClarusExtendPayload.shape.extend_seconds.describe(
    "How many seconds to add to the current Clarus assignment deadline, from 60 through 3600.",
  ),
  progress: ClarusExtendPayload.shape.progress.describe("Optional concise progress update for Clarus."),
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
          const code = safeRejectionCode(failure.code)
          const message = safeRejectionMessage(failure.message)
          throw toolError(
            code,
            `Clarus rejected the extension (${code}): ${message} Do not retry unless the assignment is renewed.`,
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
