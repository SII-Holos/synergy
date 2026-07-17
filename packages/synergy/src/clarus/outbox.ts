import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import type { ClarusOutboxAction, ClarusOutboxRecordV2, ClarusOutboxStateV2 } from "./schemas"
import { canonicalEqual } from "@/util/canonical"
import { validateSegment, validateRequestID, payloadHash } from "./keys"

const log = Log.create({ service: "clarus.outbox" })

function outboxLockKey(requestID: string): string {
  return `clarus:outbox:${encodeURIComponent(requestID)}`
}

function payloadEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  return canonicalEqual(a, b)
}

/** Terminal outbox states — once reached, the record is immutable except exact idempotent replay. */
const TERMINAL_STATES: Set<ClarusOutboxStateV2> = new Set(["acknowledged", "rejected", "ambiguous", "local_only"])

export function isTerminalOutboxState(state: ClarusOutboxStateV2): boolean {
  return TERMINAL_STATES.has(state)
}

/** Validate that an existing outbox record matches the expected identity fields. */
export function validateOutboxIdentity(
  existing: ClarusOutboxRecordV2,
  input: {
    requestID: string
    action: ClarusOutboxAction
    agentId: string
    projectId: string
    taskId?: string
    runId?: string
    subtaskId?: string
    userId?: string
    payload: Record<string, unknown>
  },
): void {
  const phash = payloadHash(input.payload)
  if (
    existing.action !== input.action ||
    existing.agentId !== input.agentId ||
    existing.projectId !== input.projectId ||
    existing.taskId !== input.taskId ||
    existing.runId !== input.runId ||
    existing.subtaskId !== input.subtaskId ||
    existing.userId !== input.userId ||
    existing.payloadHash !== phash ||
    !payloadEqual(existing.payload, input.payload)
  ) {
    throw Object.assign(
      new Error(
        `Clarus outbox collision for requestID=${input.requestID}: existing has different identity, action, or payload`,
      ),
      { code: "CLARUS_OUTBOX_COLLISION" },
    )
  }
}

export namespace ClarusOutbox {
  async function read(requestID: string): Promise<ClarusOutboxRecordV2 | undefined> {
    return Storage.read<ClarusOutboxRecordV2>(StoragePath.clarusOutboxRequestKey(requestID)).catch(() => undefined)
  }

  async function write(record: ClarusOutboxRecordV2): Promise<void> {
    await Storage.write(StoragePath.clarusOutboxRequestKey(record.requestID), record)
  }

  export async function get(requestID: string): Promise<ClarusOutboxRecordV2 | undefined> {
    return read(requestID)
  }

  export async function preallocate(input: {
    requestID: string
    action: ClarusOutboxAction
    agentId: string
    projectId: string
    taskId?: string
    runId?: string
    subtaskId?: string
    userId?: string
    payload: Record<string, unknown>
    connectionEpoch?: string
    generation?: number
  }): Promise<ClarusOutboxRecordV2> {
    validateRequestID(input.requestID)
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    if (input.taskId) validateSegment(input.taskId)

    using _ = await Lock.write(outboxLockKey(input.requestID))
    const existing = await read(input.requestID)
    if (existing) {
      if (isTerminalOutboxState(existing.state)) {
        throw Object.assign(
          new Error(
            `Clarus outbox record ${input.requestID} is terminal (${existing.state}): cannot preallocate over terminal state`,
          ),
          { code: "CLARUS_OUTBOX_TERMINAL" },
        )
      }
      const phash = payloadHash(input.payload)
      if (
        existing.action !== input.action ||
        existing.agentId !== input.agentId ||
        existing.projectId !== input.projectId ||
        existing.taskId !== input.taskId ||
        existing.runId !== input.runId ||
        existing.subtaskId !== input.subtaskId ||
        existing.userId !== input.userId ||
        existing.payloadHash !== phash ||
        !payloadEqual(existing.payload, input.payload)
      ) {
        throw Object.assign(
          new Error(
            `Clarus outbox collision for requestID=${input.requestID}: existing has different identity, action, or payload`,
          ),
          { code: "CLARUS_OUTBOX_COLLISION" },
        )
      }
      return existing
    }

    const now = Date.now()
    const phash = payloadHash(input.payload)
    const record: ClarusOutboxRecordV2 = {
      schemaVersion: 2,
      requestID: input.requestID,
      action: input.action,
      agentId: input.agentId,
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      subtaskId: input.subtaskId,
      userId: input.userId,
      payload: input.payload,
      payloadHash: phash,
      state: "prepared",
      connectionEpoch: input.connectionEpoch,
      generation: input.generation,
      preparedAt: now,
    }
    await write(record)
    log.info("outbox preallocated", { requestID: input.requestID, action: input.action })
    return record
  }

  export async function markDispatched(
    requestID: string,
    options?: { connectionEpoch?: string; generation?: number },
  ): Promise<ClarusOutboxRecordV2> {
    validateRequestID(requestID)
    using _ = await Lock.write(outboxLockKey(requestID))
    const existing = await read(requestID)
    if (!existing) throw new Error(`Clarus outbox record not found: ${requestID}`)
    if (isTerminalOutboxState(existing.state)) return existing
    if (existing.state !== "prepared") return existing
    const now = Date.now()
    const updated: ClarusOutboxRecordV2 = {
      ...existing,
      state: "dispatched",
      dispatchedAt: now,
      ...(options?.connectionEpoch !== undefined ? { connectionEpoch: options.connectionEpoch } : {}),
      ...(options?.generation !== undefined ? { generation: options.generation } : {}),
    }
    await write(updated)
    return updated
  }

  export async function markAcknowledged(
    requestID: string,
    acknowledgedPayload?: Record<string, unknown>,
  ): Promise<ClarusOutboxRecordV2> {
    validateRequestID(requestID)
    using _ = await Lock.write(outboxLockKey(requestID))
    const existing = await read(requestID)
    if (!existing) throw new Error(`Clarus outbox record not found: ${requestID}`)
    if (isTerminalOutboxState(existing.state)) {
      if (existing.state !== "acknowledged") {
        throw Object.assign(
          new Error(
            `Clarus outbox record ${requestID} is terminal (${existing.state}): cannot transition to acknowledged`,
          ),
          { code: "CLARUS_OUTBOX_TERMINAL" },
        )
      }
      return existing
    }

    const now = Date.now()
    const updated: ClarusOutboxRecordV2 = {
      ...existing,
      state: "acknowledged",
      acknowledgedAt: now,
      ...(acknowledgedPayload !== undefined ? { acknowledgedPayload } : {}),
    }
    await write(updated)
    return updated
  }

  export async function markRejected(
    requestID: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<ClarusOutboxRecordV2> {
    validateRequestID(requestID)
    using _ = await Lock.write(outboxLockKey(requestID))
    const existing = await read(requestID)
    if (!existing) throw new Error(`Clarus outbox record not found: ${requestID}`)
    if (isTerminalOutboxState(existing.state)) {
      if (existing.state === "rejected") {
        const normalizedCode = errorCode ? errorCode.slice(0, 128) : undefined
        const normalizedMessage = errorMessage ? errorMessage.replace(/[\r\n]/g, " ").slice(0, 512) : undefined
        if (existing.errorCode !== normalizedCode || existing.errorMessage !== normalizedMessage) {
          throw Object.assign(
            new Error(
              `Clarus outbox record ${requestID} is terminal (${existing.state}): cannot rewrite terminal state with different error details`,
            ),
            { code: "CLARUS_OUTBOX_TERMINAL" },
          )
        }
      } else {
        throw Object.assign(
          new Error(`Clarus outbox record ${requestID} is terminal (${existing.state}): cannot transition to rejected`),
          { code: "CLARUS_OUTBOX_TERMINAL" },
        )
      }
      return existing
    }

    const now = Date.now()
    const updated: ClarusOutboxRecordV2 = {
      ...existing,
      state: "rejected",
      rejectedAt: now,
      ...(errorCode ? { errorCode: errorCode.slice(0, 128) } : {}),
      ...(errorMessage ? { errorMessage: errorMessage.replace(/[\r\n]/g, " ").slice(0, 512) } : {}),
    }
    await write(updated)
    return updated
  }

  export async function markAmbiguous(
    requestID: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<ClarusOutboxRecordV2> {
    validateRequestID(requestID)
    using _ = await Lock.write(outboxLockKey(requestID))
    const existing = await read(requestID)
    if (!existing) throw new Error(`Clarus outbox record not found: ${requestID}`)
    if (isTerminalOutboxState(existing.state)) {
      if (existing.state === "ambiguous") {
        const normalizedCode = errorCode ? errorCode.slice(0, 128) : undefined
        const normalizedMessage = errorMessage ? errorMessage.replace(/[\r\n]/g, " ").slice(0, 512) : undefined
        if (existing.errorCode !== normalizedCode || existing.errorMessage !== normalizedMessage) {
          throw Object.assign(
            new Error(
              `Clarus outbox record ${requestID} is terminal (${existing.state}): cannot rewrite terminal state with different error details`,
            ),
            { code: "CLARUS_OUTBOX_TERMINAL" },
          )
        }
      } else {
        throw Object.assign(
          new Error(
            `Clarus outbox record ${requestID} is terminal (${existing.state}): cannot transition to ambiguous`,
          ),
          { code: "CLARUS_OUTBOX_TERMINAL" },
        )
      }
      return existing
    }

    const now = Date.now()
    const updated: ClarusOutboxRecordV2 = {
      ...existing,
      state: "ambiguous",
      ambiguousAt: now,
      ...(errorCode ? { errorCode: errorCode.slice(0, 128) } : {}),
      ...(errorMessage ? { errorMessage: errorMessage.replace(/[\r\n]/g, " ").slice(0, 512) } : {}),
    }
    await write(updated)
    return updated
  }

  /** Mark the outbox record as local-only. This is irreversible — once set,
   *  no other transition is allowed and the record is considered terminal. */
  export async function markLocalOnly(requestID: string): Promise<ClarusOutboxRecordV2> {
    validateRequestID(requestID)
    using _ = await Lock.write(outboxLockKey(requestID))
    const existing = await read(requestID)
    if (!existing) throw new Error(`Clarus outbox record not found: ${requestID}`)
    if (existing.state === "local_only") return existing
    if (isTerminalOutboxState(existing.state)) {
      throw Object.assign(
        new Error(`Clarus outbox record ${requestID} is terminal (${existing.state}): cannot transition to local_only`),
        { code: "CLARUS_OUTBOX_TERMINAL" },
      )
    }

    const now = Date.now()
    const updated: ClarusOutboxRecordV2 = {
      ...existing,
      state: "local_only",
      localOnlyAt: now,
    }
    await write(updated)
    return updated
  }
}
