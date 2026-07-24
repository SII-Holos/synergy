import z from "zod"
import { Channel } from "@/channel"
import { ClarusProvider } from "@/channel/provider/clarus"
import { parseClarusRequestFailure } from "@/channel/provider/clarus/agent-tunnel-port"
import { ClarusAssignmentStore } from "@/channel/provider/clarus/assignment-store"
import { Tool } from "./tool"

const ArtifactPart = z.object({
  type: z.literal("text"),
  format: z.enum(["markdown", "latex", "json", "csv", "text"]),
  role: z.string().min(1),
  content_kind: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
})

const Artifact = z.object({
  artifact_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  parts: z.array(ArtifactPart).min(1),
})

const Parameters = z
  .object({
    success: z.boolean().describe("Whether the Clarus assignment completed successfully."),
    output: z.string().max(2000).describe("Concise result summary; put reusable content in artifacts."),
    artifacts: z.array(Artifact).max(50).optional(),
    evidence_refs: z.array(z.string().min(1)).max(50).optional(),
    notary_refs: z.array(z.string().min(1)).max(50).optional(),
    error: z.string().max(2000).optional().describe("Required when success is false."),
  })
  .superRefine((value, ctx) => {
    if (value.success || value.error?.trim()) return
    ctx.addIssue({ code: "custom", path: ["error"], message: "error is required when success is false" })
  })

function toolError(code: string, message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, metadata)
}

export const ClarusSubmitTaskResultTool = Tool.define(
  "clarus_submit_task_result",
  {
    description:
      "Submit the current Clarus assignment result. The current session supplies assignment identity; never provide project, task, run, subtask, or account IDs.",
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
        const result = await provider.submitTaskResult({
          sessionID: ctx.sessionID,
          signal: ctx.abort,
          payload: {
            success: params.success,
            output: params.output,
            artifacts: (params.artifacts ?? []).map((artifact) => ({
              artifactID: artifact.artifact_id,
              name: artifact.name,
              ...(artifact.description === undefined ? {} : { description: artifact.description }),
              parts: artifact.parts.map((part) => ({
                type: part.type,
                format: part.format,
                role: part.role,
                contentKind: part.content_kind,
                name: part.name,
                content: part.content,
              })),
            })),
            evidenceRefs: params.evidence_refs ?? [],
            notaryRefs: params.notary_refs ?? [],
            error: params.error ?? null,
            submittedBy: ctx.agent,
          },
        })
        return {
          title: "Clarus assignment result submitted",
          output: "The result was acknowledged by Clarus. Do not submit it again.",
          metadata: { requestID: result.requestID, success: params.success },
        }
      } catch (error) {
        const failure = parseClarusRequestFailure(error)
        if (failure?.disposition === "not_dispatched") {
          throw toolError(
            failure.code,
            "The result was not dispatched and may be submitted again after the Clarus connection recovers.",
            { disposition: failure.disposition, requestID: failure.requestID },
          )
        }
        if (failure?.disposition === "rejected") {
          throw toolError(failure.code, "Clarus rejected the result. Do not retry unless the assignment is renewed.", {
            disposition: failure.disposition,
            requestID: failure.requestID,
          })
        }
        if (failure?.disposition === "ambiguous") {
          throw toolError(
            "CLARUS_SUBMISSION_AMBIGUOUS",
            "Clarus may have recorded the result. Do not retry unless the assignment is renewed or externally reconciled.",
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
      title: "Submit Clarus Assignment Result",
      keywords: ["clarus", "submit", "assignment", "result"],
    },
  },
)
