import { z } from "zod"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionTransferCore as Core } from "@ericsanchezok/synergy-harness/session/transfer"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationSessionProtocol as Sessions,
} from "@ericsanchezok/synergy-organization-protocol"

type Runtime = { run<T>(body: () => Promise<T>): Promise<T> }
const names = z.enum([
  "ContextBudgetExceededError",
  "MessageAbortedError",
  "MessageAuthError",
  "MessageAPIError",
  "MessageOutputLengthError",
  "MessageEmptyResponseError",
  "SessionTerminalError",
  "RolloutRecordingError",
  "RolloutAdmissionError",
  "ProviderModelNotFoundError",
  "ProviderAuthError",
  "ProviderInitError",
  "ProviderConnectionNotFoundError",
  "UnknownError",
  "AbortError",
  "TimeoutError",
  "StorageClosedError",
])
const codes = z.enum([
  "RUNTIME_OFFLINE",
  "COMMAND_OUTCOME_UNKNOWN",
  "PERMISSION_DENIED",
  "RESOURCE_UNAVAILABLE",
  "RESOURCE_REVOKED",
  "INVALID_REQUEST",
  "PROTOCOL_MISMATCH",
  "SQLITE_FULL",
  "ENOSPC",
  "AUTHENTICATION_FAILED",
  "CONTEXT_BUDGET_EXCEEDED",
])
const failure = z.object({
  name: z.unknown(),
  data: z.object({ code: z.unknown().optional(), errorName: z.unknown().optional() }).optional(),
})
function safeName(value: unknown) {
  const parsed = names.safeParse(value)
  return parsed.success ? parsed.data : "other"
}
function safeCode(value: unknown) {
  const parsed = codes.safeParse(value)
  return parsed.success ? parsed.data : "other"
}

export async function observeTaskFailure(input: {
  runtime: Runtime
  accepted: Command.InputAccepted
  stage: "hosted-model-start" | "native-root-completion" | "native-release"
  upstreamCalls: number
  contextCalls?: number
}) {
  const abort = new AbortController()
  const expired = Promise.withResolvers<void>()
  const observed: Record<string, unknown> = {
    stage: input.stage,
    upstreamCalls: input.upstreamCalls,
    contextCalls: input.contextCalls,
    diagnostic: "pending",
    messagesRead: 0,
  }
  const timer = setTimeout(() => {
    abort.abort()
    observed.diagnostic = "deadline"
    expired.resolve()
  }, 500)
  try {
    const reading = input.runtime
      .run(async () => {
        const [index] = await Storage.readMany([
          StoragePath.sessionIndex(Identifier.asSessionID(input.accepted.permit.sessionID)),
        ])
        abort.signal.throwIfAborted()
        const { scopeID } = z.object({ scopeID: z.string().min(1) }).parse(index)
        const { info: session } = await Core.storedInfo({ scopeID, sessionID: input.accepted.permit.sessionID })
        abort.signal.throwIfAborted()
        const binding = Sessions.Binding.safeParse(session.organization)
        observed.originalBinding =
          binding.success &&
          binding.data.orgID === input.accepted.permit.orgID &&
          binding.data.driverRuntimeID === input.accepted.permit.runtimeID &&
          binding.data.bindingEpoch === input.accepted.permit.bindingEpoch
        observed.profile = session.controlProfile
        observed.paused = session.paused?.reason
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        const run = await RolloutLedger.getRun(owner, input.accepted.effect.messageID).catch((error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        })
        abort.signal.throwIfAborted()
        observed.run = run?.status ?? "missing"
        observed.recording = run?.recording
        const errors: Array<{ name: string; code?: string; errorName?: string }> = []
        observed.errors = errors
        for await (const info of MessageV2.readNewestInfos({
          scopeID: Identifier.asScopeID(session.scope.id),
          sessionID: Identifier.asSessionID(session.id),
          limit: 8,
        })) {
          abort.signal.throwIfAborted()
          observed.messagesRead = Number(observed.messagesRead) + 1
          if (info.role !== "assistant" || !info.error) continue
          const parsed = failure.safeParse(info.error)
          if (parsed.success)
            errors.push({
              name: safeName(parsed.data.name),
              ...(parsed.data.data?.code !== undefined ? { code: safeCode(parsed.data.data.code) } : {}),
              ...(parsed.data.data?.errorName !== undefined ? { errorName: safeName(parsed.data.data.errorName) } : {}),
            })
        }
        abort.signal.throwIfAborted()
        observed.diagnostic = "complete"
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          observed.diagnostic = "unavailable"
          observed.failure = safeName(error instanceof Error ? error.name : undefined)
        }
      })
    await Promise.race([reading, expired.promise])
  } catch {
    observed.diagnostic = "unavailable"
  } finally {
    clearTimeout(timer)
    abort.abort()
    console.error("NATIVE_TASK_FAILURE", JSON.stringify(observed))
  }
}
