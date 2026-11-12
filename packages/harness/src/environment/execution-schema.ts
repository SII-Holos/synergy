import { z } from "zod"
import { EnvironmentSchema } from "./schema"
import { EnvironmentOriginSchema } from "./origin-schema"
import { ExecutionProtocol } from "./executor"
import { WorkspaceProtocol } from "../workspace/protocol"
import { WorkspaceEvidence } from "../workspace/evidence"
import { JsonValue } from "../util/json-value"

export namespace EnvironmentExecutionSchema {
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
  export const Info = Fields.extend({ origin: EnvironmentOriginSchema.Info }).meta({ ref: "EnvironmentExecutionInfo" })
  export type Info = z.infer<typeof Info>
  export const PersistedInfo = Info.passthrough()
  export const Record = z.strictObject({ schemaVersion: z.literal(2), execution: PersistedInfo })
  export type Record = z.infer<typeof Record>

  export function upgrade(value: unknown): Record {
    if (value && typeof value === "object" && "schemaVersion" in value) return Record.parse(value)
    const legacy = LegacyRecord.parse(value)
    return Record.parse({ schemaVersion: 2, execution: { ...legacy, origin: { kind: "legacy-unknown" } } })
  }
}
