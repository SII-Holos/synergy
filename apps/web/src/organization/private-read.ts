import {
  OrganizationReadProtocol as Read,
  OrganizationDesktop as Desktop,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

export class OrganizationSessionReadError extends Error {
  constructor(readonly code: string) {
    super("Conversation content is unavailable")
    this.name = "OrganizationSessionReadError"
  }
}

export function createOrganizationSessionReader(options: {
  api: OrganizationClient
  bridge?: Pick<Desktop.Bridge, "memberStatus" | "memberRequest" | "cancel">
  connectionID?: string
  binding: Protocol.SessionBinding
  signal: AbortSignal
  authorizationRequired?: () => void
}) {
  let selected: Promise<boolean> | undefined
  let active = 0
  const waiting: { grant: () => void; signal: AbortSignal; abort: () => void }[] = []
  function enter(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const ticket = {
        signal,
        grant: () => {
          signal.removeEventListener("abort", ticket.abort)
          active++
          resolve()
        },
        abort: () => {
          signal.removeEventListener("abort", ticket.abort)
          const index = waiting.indexOf(ticket)
          if (index !== -1) waiting.splice(index, 1)
          reject(signal.reason)
        },
      }
      signal.addEventListener("abort", ticket.abort, { once: true })
      if (signal.aborted) {
        ticket.abort()
        return
      }
      if (active < 8) ticket.grant()
      else waiting.push(ticket)
    })
  }
  function leave() {
    active--
    while (waiting.length) {
      const next = waiting.shift()!
      if (next.signal.aborted) {
        next.abort()
        continue
      }
      next.grant()
      break
    }
  }
  function failed(code: Desktop.ErrorCode): never {
    if (!options.signal.aborted && (code === "reauthorization_required" || code === "signed_out"))
      options.authorizationRequired?.()
    throw new OrganizationSessionReadError(code)
  }
  async function native() {
    if (!options.bridge || !options.connectionID) return false
    options.signal.throwIfAborted()
    const result = await options.bridge.memberStatus({ connectionID: options.connectionID })
    options.signal.throwIfAborted()
    if (!result.ok) failed(result.error.code)
    const state = Desktop.MemberRuntime.safeParse(result.value)
    if (!state.success || state.data.connectionID !== options.connectionID)
      throw new OrganizationSessionReadError("invalid_response")
    return state.data.state === "running" && state.data.runtimeID === options.binding.driverRuntimeID
  }
  return async (input: Read.Input, signal = options.signal): Promise<Read.Result> => {
    const query = Read.Query.parse(input)
    const current = AbortSignal.any([options.signal, signal])
    current.throwIfAborted()
    await enter(current)
    try {
      current.throwIfAborted()
      selected ??= native()
      const local = await selected
      current.throwIfAborted()
      let value: unknown
      if (local) {
        const request = Desktop.MemberRequest.parse({
          requestID: generateUUID(),
          connectionID: options.connectionID,
          query,
        })
        const cancel = () => {
          void options.bridge!.cancel({ requestID: request.requestID }).catch(() => {})
        }
        current.addEventListener("abort", cancel, { once: true })
        try {
          current.throwIfAborted()
          const result = await options.bridge!.memberRequest(request)
          current.throwIfAborted()
          if (!result.ok) failed(result.error.code)
          const outcome = Desktop.MemberReadOutcome.safeParse(result.value)
          if (!outcome.success) throw new OrganizationSessionReadError("invalid_response")
          if (outcome.data.kind !== "result")
            throw new OrganizationSessionReadError(
              {
                revision_conflict: "REVISION_CONFLICT",
                not_found: "NOT_FOUND",
                binding_changed: "STALE_BINDING",
              }[outcome.data.kind],
            )
          value = outcome.data.result
        } finally {
          current.removeEventListener("abort", cancel)
        }
      } else {
        value = (
          await options.api.orgSessionRead.read(
            {
              sessionID: query.rootSessionID,
              orgPrivateReadQuery: query,
            },
            { throwOnError: true, signal: current },
          )
        ).data
        current.throwIfAborted()
      }
      const result = Read.Result.safeParse(value)
      if (!result.success) throw new OrganizationSessionReadError("invalid_response")
      if (!Read.matches(query, result.data, options.binding)) throw new OrganizationSessionReadError("STALE_BINDING")
      return result.data
    } finally {
      leave()
    }
  }
}
