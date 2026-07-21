import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { parseClarusRequestFailure } from "./agent-tunnel-port"
import { ClarusAssignmentStore, type ClarusAssignment } from "./assignment-store"

const ArtifactPart = z.object({
  type: z.literal("text"),
  format: z.enum(["markdown", "latex", "json", "csv", "text"]),
  role: z.string().min(1),
  contentKind: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
})

const Artifact = z.object({
  artifactID: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  parts: z.array(ArtifactPart).min(1),
})

export const ClarusResultPayload = z.object({
  success: z.boolean(),
  output: z.string().max(2000),
  artifacts: z.array(Artifact).max(50),
  evidenceRefs: z.array(z.string().min(1)).max(50),
  notaryRefs: z.array(z.string().min(1)).max(50),
  error: z.string().max(2000).nullable(),
  submittedBy: z.string(),
})
export type ClarusResultPayload = z.infer<typeof ClarusResultPayload>

const ResultRecord = z.object({
  requestID: z.string(),
  assignmentHash: z.string(),
  sessionID: z.string(),
  payload: ClarusResultPayload,
  state: z.enum(["pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"]),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ClarusResultRecord = z.infer<typeof ResultRecord>

type Send = (input: { requestID: string; assignment: ClarusAssignment; payload: ClarusResultPayload }) => Promise<void>

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export namespace ClarusResultOutbox {
  export async function submit(input: {
    sessionID: string
    payload: ClarusResultPayload
    send: Send
  }): Promise<{ requestID: string }> {
    const located = await ClarusAssignmentStore.findBySessionID(input.sessionID)
    if (!located) {
      throw Object.assign(new Error("This session is not bound to a Clarus assignment"), {
        code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
      })
    }

    const requestID = crypto.randomUUID()
    const now = Date.now()
    const key = StoragePath.clarusProviderResultOutbox(located.accountHash, hash(requestID))
    const record: ClarusResultRecord = {
      requestID,
      assignmentHash: located.assignmentHash,
      sessionID: input.sessionID,
      payload: ClarusResultPayload.parse(input.payload),
      state: "pending",
      createdAt: now,
      updatedAt: now,
    }
    await Storage.write(key, record)
    const pending = await ClarusAssignmentStore.beginResult(input.sessionID, requestID)

    try {
      await input.send({ requestID, assignment: pending.assignment, payload: record.payload })
      await Storage.write(key, { ...record, state: "acknowledged", updatedAt: Date.now() })
      await ClarusAssignmentStore.settleResult({
        accountHash: pending.accountHash,
        assignmentHash: pending.assignmentHash,
        requestID,
        state: "acknowledged",
      })
      return { requestID }
    } catch (error) {
      const failure = parseClarusRequestFailure(error)
      const state = failure?.disposition ?? "ambiguous"
      await Storage.write(key, { ...record, state, updatedAt: Date.now() })
      await ClarusAssignmentStore.settleResult({
        accountHash: pending.accountHash,
        assignmentHash: pending.assignmentHash,
        requestID,
        state,
      })
      throw error
    }
  }

  export async function recover(accountHash: string): Promise<void> {
    const recordHashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(accountHash))
    for (const recordHash of recordHashes) {
      const key = StoragePath.clarusProviderResultOutbox(accountHash, recordHash)
      const record = await Storage.read<unknown>(key)
        .then((value) => ResultRecord.parse(value))
        .catch(() => undefined)
      if (!record) continue
      const state = record.state === "pending" ? "ambiguous" : record.state
      if (state !== record.state) {
        await Storage.write(key, { ...record, state, updatedAt: Date.now() })
      }
      await ClarusAssignmentStore.settleResult({
        accountHash,
        assignmentHash: record.assignmentHash,
        requestID: record.requestID,
        state,
      })
    }
  }
}
