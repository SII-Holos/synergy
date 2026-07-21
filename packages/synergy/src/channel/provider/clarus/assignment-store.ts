import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Scope } from "@/scope"
import { Session } from "@/session"
import { SessionInbox } from "@/session/inbox"
import { SessionInteraction } from "@/session/interaction"
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
  sessionID: z.string(),
  title: z.string(),
  status: z.enum(["assigned", "running", "completed", "reconciliation_error"]),
  deadlineAt: z.string().optional(),
  assignmentMessageID: z.string().optional(),
  resultState: z.enum(["none", "pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"]),
  resultRequestID: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ClarusAssignment = z.infer<typeof Assignment>

export const AssignmentScopeMismatchError = NamedError.create(
  "ClarusAssignmentScopeMismatchError",
  z.object({
    sessionID: z.string(),
    existingScopeID: z.string(),
    requestedScopeID: z.string(),
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

function titleFor(event: RuntimeTaskAssignedEvent): string {
  const value = event.goal?.trim() || event.instructions?.trim() || event.taskID
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function assignmentText(event: RuntimeTaskAssignedEvent): string {
  return [
    "## Clarus assignment",
    "",
    `Phase: ${event.phase}`,
    `Attempt: ${event.attempt}`,
    `Deadline: ${event.deadlineAt ?? "none"}`,
    "",
    event.goal?.trim(),
    event.instructions?.trim(),
  ]
    .filter((line): line is string => line !== undefined && line !== "")
    .join("\n")
}

export namespace ClarusAssignmentStore {
  export type Located = {
    assignment: ClarusAssignment
    accountHash: string
    assignmentHash: string
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

  export async function ensure(input: {
    accountId: string
    scope: Scope.Project
    event: RuntimeTaskAssignedEvent
    agentOverride?: string
  }): Promise<{ assignment: ClarusAssignment; created: boolean }> {
    const accountHash = hash(input.accountId)
    const assignmentHash = hash(input.accountId, input.event.projectID, input.event.taskID)
    const key = StoragePath.clarusProviderAssignment(accountHash, assignmentHash)
    using _ = await Lock.write(`channel:clarus:assignment:${accountHash}:${assignmentHash}`)

    let assignment = await Storage.read<unknown>(key)
      .then((value) => Assignment.parse(value))
      .catch(() => undefined)
    let session = assignment ? await Session.get(assignment.sessionID).catch(() => undefined) : undefined

    if (session && session.scope.id !== input.scope.id) {
      const failed = { ...assignment!, status: "reconciliation_error" as const, updatedAt: Date.now() }
      await Storage.write(key, failed)
      throw new AssignmentScopeMismatchError({
        sessionID: session.id,
        existingScopeID: session.scope.id,
        requestedScopeID: input.scope.id,
      })
    }

    const now = Date.now()
    const title = titleFor(input.event)
    if (!session) {
      session = await Session.create({
        scope: input.scope,
        title,
        agentOverride: input.agentOverride,
        controlProfile: "autonomous",
        interaction: SessionInteraction.unattended("channel:clarus"),
      })
      assignment = {
        accountId: input.accountId,
        projectID: input.event.projectID,
        taskID: input.event.taskID,
        runID: input.event.runID,
        subtaskID: input.event.subtaskID,
        sessionID: session.id,
        title,
        status: "assigned",
        ...(input.event.deadlineAt ? { deadlineAt: input.event.deadlineAt } : {}),
        assignmentMessageID: input.event.requestID ?? undefined,
        resultState: "none",
        createdAt: now,
        updatedAt: now,
      }
      await Storage.write(key, assignment)
      await Storage.write(StoragePath.clarusProviderAssignmentSession(accountHash, session.id), { assignmentHash })
    }
    if (!assignment) throw new Error("Clarus assignment record was not created")

    const delivery = await SessionInbox.deliverUnique({
      sessionID: session.id,
      deliveryKey: `clarus-assignment:${hash(input.accountId, input.event.projectID, input.event.taskID, input.event.runID)}`,
      mode: "task",
      message: {
        role: "user",
        parts: [{ type: "text", text: assignmentText(input.event) }],
        agent: input.agentOverride,
        origin: { type: "channel", detail: "clarus-assignment" },
      },
    })

    const reassigned = assignment.runID !== input.event.runID
    const updated = Assignment.parse({
      ...assignment,
      title,
      runID: input.event.runID,
      subtaskID: input.event.subtaskID,
      status: "running",
      ...(input.event.deadlineAt ? { deadlineAt: input.event.deadlineAt } : {}),
      assignmentMessageID: input.event.requestID ?? assignment.assignmentMessageID,
      resultState: reassigned ? "none" : assignment.resultState,
      resultRequestID: reassigned ? undefined : assignment.resultRequestID,
      updatedAt: now,
    })
    await Storage.write(key, updated)
    return { assignment: updated, created: delivery.created }
  }
}
