import z from "zod"
import { ClarusTaskBindingStore } from "@/clarus/binding"
import { ClarusRuntime } from "@/clarus/runtime"
import { parseClarusRequestFailure } from "@/clarus/agent-tunnel-port"
import { Tool } from "./tool"

const artifactPart = z.object({
  type: z.literal("text"),
  format: z.enum(["markdown", "latex", "json", "csv", "text"]),
  role: z.string().min(1),
  content_kind: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
})

const artifact = z.object({
  artifact_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  parts: z.array(artifactPart).min(1),
})

const parameters = z
  .object({
    success: z.boolean().describe("Whether the Clarus task completed successfully."),
    output: z.string().max(2000).describe("Concise result summary; put reusable body content in artifacts."),
    artifacts: z.array(artifact).max(50).optional().describe("Reusable result artifacts with non-empty text parts."),
    evidence_refs: z.array(z.string().min(1)).max(50).optional(),
    notary_refs: z.array(z.string().min(1)).max(50).optional(),
    error: z.string().max(2000).optional().describe("Required when success is false."),
  })
  .superRefine((value, ctx) => {
    if (!value.success && !value.error?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "error is required when success is false" })
    }
  })

function toolError(code: string, message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, metadata)
}

export const ClarusSubmitTaskResultTool = Tool.define(
  "clarus_submit_task_result",
  {
    description:
      "Submit the current Clarus task result over Synergy's existing Holos Agent Tunnel. The current session binding supplies all task identity; do not provide task, project, run, or agent IDs.",
    parameters,
    async execute(params, ctx) {
      const binding = await ClarusTaskBindingStore.findBySessionID(ctx.sessionID)
      if (!binding) {
        throw toolError("CLARUS_TOOL_NOT_IN_TASK_SESSION", "This session is not bound to a Clarus task")
      }
      const retryingNotDispatched = binding.resultState === "not_dispatched"
      if (
        binding.status !== "running" ||
        (binding.resultState !== "idle" && !retryingNotDispatched) ||
        (binding.resultOutboxRequestID !== undefined && !retryingNotDispatched)
      ) {
        throw toolError("CLARUS_TOOL_TASK_NOT_RUNNING", "This Clarus task is not accepting a new result")
      }

      const requestID = crypto.randomUUID()
      try {
        await ClarusRuntime.recordTaskResult({
          requestID,
          agentId: binding.agentId,
          projectId: binding.projectId,
          runID: binding.runID,
          taskID: binding.taskId,
          subtaskID: binding.subtaskID,
          success: params.success,
          output: params.output,
          artifacts: params.artifacts ?? [],
          evidenceRefs: params.evidence_refs ?? [],
          notaryRefs: params.notary_refs ?? [],
          error: params.error ?? null,
          payload: { generated_by: ctx.agent, submitted_via: "synergy_clarus_tool" },
          signal: ctx.abort,
        })
      } catch (error) {
        const failure = parseClarusRequestFailure(error)
        if (failure?.disposition === "not_dispatched") {
          throw toolError(
            failure.code,
            `${failure.code}: ${failure.message}. The result was not dispatched and may be submitted again after the local transport is ready.`,
            { disposition: failure.disposition, requestID: failure.requestID },
          )
        }
        if (failure?.disposition === "rejected") {
          const message = `${failure.code}: ${failure.message}. The Clarus server definitively rejected this result. Do not retry unless Clarus reassigns the task.`
          throw toolError(failure.code, message, {
            disposition: failure.disposition,
            requestID: failure.requestID,
          })
        }
        if (failure?.disposition === "ambiguous") {
          throw toolError(
            "CLARUS_TOOL_SUBMISSION_AMBIGUOUS",
            `${failure.message}. Clarus may or may not have recorded the result. Do not retry this assignment; wait for Clarus to reassign it or for external confirmation.`,
            { disposition: failure.disposition, requestID: failure.requestID, reason: failure.reason },
          )
        }
        if (error instanceof Error && "code" in error) throw error
        throw toolError(
          "CLARUS_TOOL_SUBMISSION_FAILED",
          error instanceof Error ? error.message : "Clarus task result submission failed",
        )
      }

      return {
        title: "Clarus task result submitted",
        output:
          "The result was sent over the active Holos tunnel and is awaiting the Clarus recorded event. Do not submit it again.",
        metadata: {
          requestID,
          runID: binding.runID,
          taskID: binding.taskId,
          subtaskID: binding.subtaskID,
          success: params.success,
        },
      }
    },
  },
  {
    exposure: {
      mode: "search",
      title: "Submit Clarus Task Result",
      keywords: ["clarus", "submit", "result", "task", "runtime"],
    },
  },
)
