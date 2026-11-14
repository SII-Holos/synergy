import { z } from "zod"
import { EnvironmentSchema } from "./schema"
import { EnvironmentOriginSchema } from "./origin-schema"
import { ExecutionProtocol } from "./executor"
import { WorkspaceProtocol } from "../workspace/protocol"
import { WorkspaceEvidence } from "../workspace/evidence"
import { JsonValue } from "../util/json-value"

export namespace EnvironmentExecutionSchema {
  export const Source = z.strictObject({
    version: z.literal(1),
    provider: z.string().min(1),
    target: EnvironmentSchema.Target,
    binding: JsonValue,
  })
  export type Source = z.infer<typeof Source>
  const Fields = z.object({
    id: ExecutionProtocol.ID,
    scopeID: z.string(),
    target: EnvironmentSchema.Target,
    workspaces: z.array(WorkspaceProtocol.Reference.extend({ readOnly: z.boolean().optional() })).optional(),
    evidence: z.array(z.object({ workspaceID: z.string(), reference: WorkspaceEvidence.Reference })).optional(),
    digest: z.string(),
    intentDigest: z.string().length(64).optional(),
    state: z.enum(["submitted", "running", "cancel_requested", "unknown", "exited", "unsaved", "saved", "completed"]),
    status: ExecutionProtocol.Status.optional(),
    saved: z.record(z.string(), JsonValue).optional(),
    checkpointFailures: z.array(WorkspaceProtocol.CheckpointFailure).optional(),
    outputCursor: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export const LegacyInfo = Fields
  const LegacyRecord = Fields.passthrough().extend({
    origin: z.never().optional(),
    schemaVersion: z.never().optional(),
  })
  const NativeInfo = Fields.extend({ origin: EnvironmentOriginSchema.Info })
  export const Info = NativeInfo.extend({
    source: Source.optional(),
    sourceObservation: JsonValue.optional(),
  }).meta({ ref: "EnvironmentExecutionInfo" })
  export type Info = z.infer<typeof Info>
  export const PersistedInfo = Info.passthrough()
  const NativeRecord = z.strictObject({
    schemaVersion: z.literal(2),
    execution: PersistedInfo.refine(
      (info) => info.source === undefined && info.sourceObservation === undefined,
      "Native receipts cannot carry retained remote dispatch selection",
    ),
  })
  const RemoteRecord = z
    .strictObject({
      schemaVersion: z.literal(3),
      execution: PersistedInfo.extend({ source: Source }),
    })
    .superRefine(({ execution }, context) => {
      if (!EnvironmentSchema.sameTarget(execution.target, execution.source.target))
        context.addIssue({
          code: "custom",
          path: ["execution", "source"],
          message: "Execution source has another actual target",
        })
      if (execution.sourceObservation !== undefined) {
        const result = NativeInfo.safeParse(execution.sourceObservation)
        if (
          !result.success ||
          !EnvironmentSchema.sameTarget(result.data.target, execution.target) ||
          result.data.digest !== execution.digest
        )
          context.addIssue({
            code: "custom",
            path: ["execution", "sourceObservation"],
            message: "Execution source observation has another command or allocation",
          })
        else if (
          execution.state === "completed" &&
          (result.data.state !== "completed" ||
            !result.data.status ||
            !ExecutionProtocol.terminal(result.data.status) ||
            result.data.outputCursor !== result.data.status.cursor)
        )
          context.addIssue({
            code: "custom",
            path: ["execution", "sourceObservation"],
            message: "Completed execution requires its complete original source receipt",
          })
      } else if (execution.state === "completed")
        context.addIssue({
          code: "custom",
          path: ["execution", "sourceObservation"],
          message: "Completed execution requires its original source receipt",
        })
    })
  export const Record = z.discriminatedUnion("schemaVersion", [NativeRecord, RemoteRecord])
  export type Record = z.infer<typeof Record>

  export function upgrade(value: unknown): Record {
    if (value && typeof value === "object" && "schemaVersion" in value) return Record.parse(value)
    const legacy = LegacyRecord.parse(value)
    return Record.parse({ schemaVersion: 2, execution: { ...legacy, origin: { kind: "legacy-unknown" } } })
  }
}
