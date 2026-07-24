import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import type { RuntimeTaskAssignedEvent } from "./agent-tunnel-port"

const Assignment = z.object({
  accountId: z.string(),
  projectID: z.string(),
  taskID: z.string(),
  runID: z.string(),
  subtaskID: z.string(),
  attempt: z.number().int().positive().default(1),
  sessionID: z.string(),
  title: z.string(),
  status: z.enum(["assigned", "running", "completed", "cancelled", "reconciliation_error"]),
  deadlineAt: z.string().optional(),
  assignmentMessageID: z.string().optional(),
  resultState: z.enum(["none", "pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"]),
  resultRequestID: z.string().optional(),
  extensionState: z
    .enum(["none", "pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"])
    .default("none"),
  extensionRequestID: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ClarusAssignment = z.infer<typeof Assignment>

export const AssignmentSessionMismatchError = NamedError.create(
  "ClarusAssignmentSessionMismatchError",
  z.object({
    existingSessionID: z.string(),
    requestedSessionID: z.string(),
  }),
)

function hash(...parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

export namespace ClarusAssignmentStore {
  export type Located = {
    assignment: ClarusAssignment
    accountHash: string
    assignmentHash: string
  }

  export async function find(accountHash: string, assignmentHash: string): Promise<Located | undefined> {
    const assignment = await Storage.read<unknown>(StoragePath.clarusProviderAssignment(accountHash, assignmentHash))
      .then((value) => Assignment.parse(value))
      .catch(() => undefined)
    if (!assignment) return undefined
    return { assignment, accountHash, assignmentHash }
  }

  export async function findByIdentity(input: {
    accountId: string
    projectID: string
    taskID: string
  }): Promise<Located | undefined> {
    const accountHash = hash(input.accountId)
    return find(accountHash, hash(input.accountId, input.projectID, input.taskID))
  }

  export async function findBySessionID(sessionID: string): Promise<Located | undefined> {
    const accountHashes = await Storage.scan(StoragePath.clarusProviderAccountsRoot())
    for (const accountHash of accountHashes) {
      const index = await Storage.read<{ assignmentHash: string }>(
        StoragePath.clarusProviderAssignmentSession(accountHash, sessionID),
      ).catch(() => undefined)
      if (!index) continue
      const assignment = await Storage.read<unknown>(
        StoragePath.clarusProviderAssignment(accountHash, index.assignmentHash),
      )
        .then((value) => Assignment.parse(value))
        .catch(() => undefined)
      if (assignment?.sessionID !== sessionID) continue
      return { assignment, accountHash, assignmentHash: index.assignmentHash }
    }
    return undefined
  }

  export async function cancel(sessionID: string): Promise<Located | undefined> {
    const located = await findBySessionID(sessionID)
    if (!located) return undefined
    using _ = await Lock.write(`channel:clarus:assignment:${located.accountHash}:${located.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(located.accountHash, located.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    if (assignment.status === "completed" || assignment.status === "reconciliation_error") return undefined
    if (assignment.status === "cancelled") return { ...located, assignment }
    const cancelled = Assignment.parse({ ...assignment, status: "cancelled", updatedAt: Date.now() })
    await Storage.write(key, cancelled)
    return { ...located, assignment: cancelled }
  }

  export async function beginResult(sessionID: string, requestID: string): Promise<Located> {
    const located = await findBySessionID(sessionID)
    if (!located) {
      throw Object.assign(new Error("This session is not bound to a Clarus assignment"), {
        code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
      })
    }
    using _ = await Lock.write(`channel:clarus:assignment:${located.accountHash}:${located.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(located.accountHash, located.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    if (
      assignment.status !== "running" ||
      (assignment.resultState !== "none" && assignment.resultState !== "not_dispatched")
    ) {
      throw Object.assign(new Error("This Clarus assignment is not accepting a result"), {
        code: "CLARUS_TOOL_ASSIGNMENT_NOT_RUNNING",
      })
    }
    const pending = Assignment.parse({
      ...assignment,
      resultState: "pending",
      resultRequestID: requestID,
      updatedAt: Date.now(),
    })
    await Storage.write(key, pending)
    return { ...located, assignment: pending }
  }

  export async function beginExtension(sessionID: string, requestID: string): Promise<Located> {
    const located = await findBySessionID(sessionID)
    if (!located) {
      throw Object.assign(new Error("This session is not bound to a Clarus assignment"), {
        code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
      })
    }
    using _ = await Lock.write(`channel:clarus:assignment:${located.accountHash}:${located.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(located.accountHash, located.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    if (
      assignment.status !== "running" ||
      (assignment.extensionState !== "none" &&
        assignment.extensionState !== "acknowledged" &&
        assignment.extensionState !== "not_dispatched")
    ) {
      throw Object.assign(new Error("This Clarus assignment is not accepting an extension"), {
        code: "CLARUS_TOOL_EXTENSION_NOT_ACCEPTABLE",
      })
    }
    const pending = Assignment.parse({
      ...assignment,
      extensionState: "pending",
      extensionRequestID: requestID,
      updatedAt: Date.now(),
    })
    await Storage.write(key, pending)
    return { ...located, assignment: pending }
  }

  export async function settleExtension(input: {
    accountHash: string
    assignmentHash: string
    requestID: string
    state: ClarusAssignment["extensionState"]
    deadlineAt?: string | null
  }): Promise<void> {
    using _ = await Lock.write(`channel:clarus:assignment:${input.accountHash}:${input.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(input.accountHash, input.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    if (assignment.extensionRequestID !== input.requestID) return
    await Storage.write(
      key,
      Assignment.parse({
        ...assignment,
        extensionState: input.state,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt ?? undefined }),
        updatedAt: Date.now(),
      }),
    )
  }

  export async function updateDeadline(input: {
    accountHash: string
    assignmentHash: string
    deadlineAt: string | null
  }): Promise<Located> {
    using _ = await Lock.write(`channel:clarus:assignment:${input.accountHash}:${input.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(input.accountHash, input.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    const updated = Assignment.parse({
      ...assignment,
      deadlineAt: input.deadlineAt ?? undefined,
      updatedAt: Date.now(),
    })
    await Storage.write(key, updated)
    return { assignment: updated, accountHash: input.accountHash, assignmentHash: input.assignmentHash }
  }

  export async function settleResult(input: {
    accountHash: string
    assignmentHash: string
    requestID: string
    state: ClarusAssignment["resultState"]
  }): Promise<void> {
    using _ = await Lock.write(`channel:clarus:assignment:${input.accountHash}:${input.assignmentHash}`)
    const key = StoragePath.clarusProviderAssignment(input.accountHash, input.assignmentHash)
    const assignment = Assignment.parse(await Storage.read<unknown>(key))
    if (assignment.resultRequestID !== input.requestID) return
    await Storage.write(
      key,
      Assignment.parse({
        ...assignment,
        resultState: input.state,
        status: input.state === "acknowledged" ? "completed" : assignment.status,
        updatedAt: Date.now(),
      }),
    )
  }

  export async function upsert(input: {
    accountId: string
    event: RuntimeTaskAssignedEvent
    sessionID: string
    title: string
  }): Promise<{ assignment: ClarusAssignment; created: boolean }> {
    const accountHash = hash(input.accountId)
    const assignmentHash = hash(input.accountId, input.event.projectID, input.event.taskID)
    const key = StoragePath.clarusProviderAssignment(accountHash, assignmentHash)
    using _ = await Lock.write(`channel:clarus:assignment:${accountHash}:${assignmentHash}`)

    const existing = await Storage.read<unknown>(key)
      .then((value) => Assignment.parse(value))
      .catch(() => undefined)
    if (existing && existing.sessionID !== input.sessionID) {
      await Storage.write(key, Assignment.parse({ ...existing, status: "reconciliation_error", updatedAt: Date.now() }))
      throw new AssignmentSessionMismatchError({
        existingSessionID: existing.sessionID,
        requestedSessionID: input.sessionID,
      })
    }

    const now = Date.now()
    const reassigned =
      existing !== undefined &&
      (existing.runID !== input.event.runID ||
        existing.subtaskID !== input.event.subtaskID ||
        existing.attempt !== input.event.attempt)
    const assignment = Assignment.parse({
      accountId: input.accountId,
      projectID: input.event.projectID,
      taskID: input.event.taskID,
      runID: input.event.runID,
      subtaskID: input.event.subtaskID,
      attempt: input.event.attempt,
      sessionID: input.sessionID,
      title: input.title,
      status: existing && !reassigned ? existing.status : "running",
      deadlineAt: input.event.deadlineAt ?? undefined,
      assignmentMessageID: input.event.requestID ?? existing?.assignmentMessageID,
      resultState: existing && !reassigned ? existing.resultState : "none",
      resultRequestID: existing && !reassigned ? existing.resultRequestID : undefined,
      extensionState: existing && !reassigned ? existing.extensionState : "none",
      extensionRequestID: existing && !reassigned ? existing.extensionRequestID : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await Storage.write(key, assignment)
    await Storage.write(StoragePath.clarusProviderAssignmentSession(accountHash, input.sessionID), { assignmentHash })
    return { assignment, created: existing === undefined }
  }
}
