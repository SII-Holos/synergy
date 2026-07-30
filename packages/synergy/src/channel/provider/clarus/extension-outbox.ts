import z from "zod"
import { StoragePath } from "@/storage/path"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { parseClarusRequestFailure } from "./agent-tunnel-port"
import { ClarusAssignmentStore, type ClarusAssignment } from "./assignment-store"

const MAX_REJECTION_CODE_LENGTH = 128
const MAX_REJECTION_MESSAGE_LENGTH = 500
const MAX_PAYLOAD_KEYS = 50
const MAX_PAYLOAD_STRING_LENGTH = 2_000
const MAX_PAYLOAD_BYTES = 64 * 1024

const ExtensionPayload = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const entries = Object.entries(value)
  if (entries.length > MAX_PAYLOAD_KEYS) {
    ctx.addIssue({
      code: "custom",
      message: `payload must contain at most ${MAX_PAYLOAD_KEYS} keys`,
    })
  }
  for (const [key, item] of entries) {
    if (typeof item === "string" && item.length > MAX_PAYLOAD_STRING_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `payload string values must contain at most ${MAX_PAYLOAD_STRING_LENGTH} characters`,
      })
    }
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`,
      })
    }
  } catch {
    ctx.addIssue({ code: "custom", message: "payload must be JSON serializable" })
  }
})

export const ClarusExtendPayload = z.object({
  extend_seconds: z.number().int().min(60).max(3_600),
  progress: z.string().max(500).optional(),
  payload: ExtensionPayload.optional(),
})
export type ClarusExtendPayload = z.infer<typeof ClarusExtendPayload>

const ExtensionState = z.enum(["pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"])

const ExtensionRecord = z.object({
  requestID: z.string(),
  previousRequestID: z.string().optional(),
  assignmentHash: z.string(),
  sessionID: z.string(),
  payload: ClarusExtendPayload,
  state: ExtensionState,
  deadlineAt: z.string().nullable().optional(),
  error: z
    .object({
      code: z.string().max(MAX_REJECTION_CODE_LENGTH).optional(),
      message: z.string().max(MAX_REJECTION_MESSAGE_LENGTH),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
type ExtensionRecord = z.infer<typeof ExtensionRecord>

export type ClarusExtensionSend = (input: {
  requestID: string
  previousRequestID?: string
  assignment: ClarusAssignment
  payload: ClarusExtendPayload
}) => Promise<{ deadlineAt?: string | null } | void>

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function lockKey(accountHash: string): string {
  return `channel:clarus:extension-outbox:${accountHash}`
}

export function safeRejectionCode(code: string): string {
  const normalized = code.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_REJECTION_CODE_LENGTH)
  return normalized || "CLARUS_EXTENSION_REJECTED"
}

export function safeRejectionMessage(message: string): string {
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

function errorInfo(error: unknown): ExtensionRecord["error"] {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown }
    const rawCode = typeof value.code === "string" ? value.code : undefined
    const rawMessage = typeof value.message === "string" ? value.message : String(error)
    return {
      ...(rawCode === undefined ? {} : { code: safeRejectionCode(rawCode) }),
      message: safeRejectionMessage(rawMessage),
    }
  }
  return { message: safeRejectionMessage(String(error)) }
}

async function writeRecord(accountHash: string, record: ExtensionRecord): Promise<void> {
  await Storage.write(StoragePath.clarusProviderExtensionOutbox(accountHash, hash(record.requestID)), record)
}

async function settleAcknowledged(input: {
  accountHash: string
  assignmentHash: string
  record: ExtensionRecord
  deadlineAt?: string | null
}): Promise<void> {
  const record = ExtensionRecord.parse({
    ...input.record,
    state: "acknowledged",
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    updatedAt: Date.now(),
  })
  await writeRecord(input.accountHash, record)
  await ClarusAssignmentStore.settleExtension({
    accountHash: input.accountHash,
    assignmentHash: input.assignmentHash,
    requestID: record.requestID,
    state: "acknowledged",
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  })
}

async function settleFailure(input: {
  accountHash: string
  assignmentHash: string
  record: ExtensionRecord
  error: unknown
}): Promise<void> {
  const state = parseClarusRequestFailure(input.error)?.disposition ?? "ambiguous"
  await writeRecord(
    input.accountHash,
    ExtensionRecord.parse({
      ...input.record,
      state,
      error: errorInfo(input.error),
      updatedAt: Date.now(),
    }),
  )
  await ClarusAssignmentStore.settleExtension({
    accountHash: input.accountHash,
    assignmentHash: input.assignmentHash,
    requestID: input.record.requestID,
    state,
  })
}

const activeSessions = new Set<string>()

export namespace ClarusExtensionOutbox {
  export async function submit(input: {
    sessionID: string
    payload: ClarusExtendPayload
    send: ClarusExtensionSend
  }): Promise<{ requestID: string }> {
    if (activeSessions.has(input.sessionID)) {
      throw Object.assign(new Error("A Clarus extension request is already in progress for this assignment"), {
        code: "CLARUS_TOOL_EXTENSION_IN_PROGRESS",
      })
    }
    activeSessions.add(input.sessionID)
    try {
      const located = await ClarusAssignmentStore.findBySessionID(input.sessionID)
      if (!located) {
        throw Object.assign(new Error("This session is not bound to a Clarus assignment"), {
          code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
        })
      }
      using _ = await Lock.write(lockKey(located.accountHash))
      const payload = ClarusExtendPayload.parse(input.payload)
      const requestID = crypto.randomUUID()
      const now = Date.now()
      const record = ExtensionRecord.parse({
        requestID,
        assignmentHash: located.assignmentHash,
        sessionID: input.sessionID,
        payload,
        state: "pending",
        createdAt: now,
        updatedAt: now,
      })
      await writeRecord(located.accountHash, record)
      const pending = await ClarusAssignmentStore.beginExtension(input.sessionID, requestID)

      try {
        const response = await input.send({ requestID, assignment: pending.assignment, payload })
        const deadlineAt = response?.deadlineAt
        await settleAcknowledged({
          accountHash: pending.accountHash,
          assignmentHash: pending.assignmentHash,
          record,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
        })
        return { requestID }
      } catch (error) {
        await settleFailure({
          accountHash: pending.accountHash,
          assignmentHash: pending.assignmentHash,
          record,
          error,
        })
        throw error
      }
    } finally {
      activeSessions.delete(input.sessionID)
    }
  }

  export async function acknowledge(input: {
    accountHash: string
    assignmentHash: string
    requestID: string
    deadlineAt?: string | null
  }): Promise<boolean> {
    using _ = await Lock.write(lockKey(input.accountHash))
    const key = StoragePath.clarusProviderExtensionOutbox(input.accountHash, hash(input.requestID))
    const stored = await Storage.read<unknown>(key)
      .then((value) => ExtensionRecord.parse(value))
      .catch(() => undefined)
    if (stored && stored.assignmentHash !== input.assignmentHash) return false
    if (stored) {
      await settleAcknowledged({
        accountHash: input.accountHash,
        assignmentHash: input.assignmentHash,
        record: stored,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      })
    } else {
      await ClarusAssignmentStore.settleExtension({
        accountHash: input.accountHash,
        assignmentHash: input.assignmentHash,
        requestID: input.requestID,
        state: "acknowledged",
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      })
    }
    return true
  }

  export async function recover(accountHash: string, send?: ClarusExtensionSend): Promise<string[]>
  export async function recover(input: { accountHash: string; send?: ClarusExtensionSend }): Promise<string[]>
  export async function recover(
    input: string | { accountHash: string; send?: ClarusExtensionSend },
    legacySend?: ClarusExtensionSend,
  ): Promise<string[]> {
    const accountHash = typeof input === "string" ? input : input.accountHash
    const send = typeof input === "string" ? legacySend : input.send
    using _ = await Lock.write(lockKey(accountHash))
    const recoveredSessions: string[] = []
    const recordHashes = await Storage.scan(StoragePath.clarusProviderExtensionOutboxRoot(accountHash))
    for (const recordHash of recordHashes) {
      const record = await Storage.read<unknown>(StoragePath.clarusProviderExtensionOutbox(accountHash, recordHash))
        .then((value) => ExtensionRecord.parse(value))
        .catch(() => undefined)
      if (!record) continue
      const located = await ClarusAssignmentStore.find(accountHash, record.assignmentHash)
      if (!located) continue

      if (
        record.state === "pending" ||
        (record.state === "ambiguous" && located.assignment.extensionState === "pending")
      ) {
        if (record.state === "pending") {
          const ambiguous = ExtensionRecord.parse({ ...record, state: "ambiguous", updatedAt: Date.now() })
          await writeRecord(accountHash, ambiguous)
        }
        if (
          located.assignment.extensionRequestID === record.requestID &&
          located.assignment.extensionState === "pending"
        ) {
          await ClarusAssignmentStore.settleExtension({
            accountHash,
            assignmentHash: record.assignmentHash,
            requestID: record.requestID,
            state: "ambiguous",
          })
        }
        continue
      }

      if (located.assignment.extensionRequestID !== record.requestID) continue

      if (record.state !== "not_dispatched" || located.assignment.extensionState !== "not_dispatched" || !send) {
        continue
      }
      if (activeSessions.has(record.sessionID)) continue
      activeSessions.add(record.sessionID)
      try {
        const requestID = crypto.randomUUID()
        const retried = ExtensionRecord.parse({
          ...record,
          requestID,
          previousRequestID: record.requestID,
          state: "pending",
          error: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await writeRecord(accountHash, retried)
        const pending = await ClarusAssignmentStore.beginExtension(record.sessionID, requestID)
        try {
          const response = await send({
            requestID,
            previousRequestID: record.requestID,
            assignment: pending.assignment,
            payload: record.payload,
          })
          const deadlineAt = response?.deadlineAt
          await settleAcknowledged({
            accountHash,
            assignmentHash: record.assignmentHash,
            record: retried,
            ...(deadlineAt === undefined ? {} : { deadlineAt }),
          })
          recoveredSessions.push(record.sessionID)
        } catch (error) {
          await settleFailure({
            accountHash,
            assignmentHash: record.assignmentHash,
            record: retried,
            error,
          })
        }
      } finally {
        activeSessions.delete(record.sessionID)
      }
    }
    return recoveredSessions
  }
}
