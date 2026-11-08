import { z } from "zod"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import type { Credentials } from "./auth/session"
import type { CommandAdmissions } from "./command-admission"
import type { RuntimeConnections } from "./runtime-connection"
import { OrganizationError, fail } from "./error"

export function createCommandForwarder(options: {
  admissions: CommandAdmissions
  connections: RuntimeConnections
  timeoutMs?: number
}) {
  const { admissions, connections } = options
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(30_000)
    .parse(options.timeoutMs ?? 10_000)
  let active = 0
  function unknown(requestID: string): never {
    throw new OrganizationError({
      code: "COMMAND_OUTCOME_UNKNOWN",
      requestID,
      outcome: "unknown",
      retryable: false,
      message: "Runtime reception is unknown; query or explicitly retry this request ID",
    })
  }
  async function serial<T>(
    sessionID: string,
    caller: AbortSignal | undefined,
    body: (work: { signal: AbortSignal; deadline: number }) => Promise<T>,
  ) {
    if (active >= 64) fail("SERVICE_UNAVAILABLE", "Command transport is busy; retry the active request")
    active++
    const controller = new AbortController()
    const deadline = Date.now() + timeoutMs
    const cancel = () => controller.abort()
    caller?.addEventListener("abort", cancel, { once: true })
    if (caller?.aborted) cancel()
    const timer = setTimeout(cancel, timeoutMs)
    timer.unref()
    try {
      using lock = await Lock.writeWithSignal(`organization-command:${sessionID}`, controller.signal)
      if (!lock || controller.signal.aborted) fail("RUNTIME_OFFLINE", "Command request ended before transmission")
      return await body({ signal: controller.signal, deadline })
    } finally {
      active--
      clearTimeout(timer)
      caller?.removeEventListener("abort", cancel)
    }
  }
  type Query = { sessionID: string; requestID: string }
  type Work = { signal: AbortSignal; deadline: number }
  async function reconcile(credentials: Credentials, query: Query, work: Work) {
    const previous = await admissions.get(credentials, query)
    if (previous.accepted) return previous
    const authorization = previous.attempt.authorization
    try {
      const connection = connections.capture(authorization.permit.runtimeID)
      const reply = await connection.exchange({ kind: "query", authorization }, work)
      if (reply.kind !== "query") unknown(query.requestID)
      if (!reply.query.result) await admissions.absent(connection, reply.query)
      return await admissions.get(credentials, query)
    } catch (error) {
      if (
        error instanceof OrganizationError &&
        ["AUTHENTICATION_REQUIRED", "PERMISSION_DENIED", "NOT_FOUND", "PROTOCOL_MISMATCH"].includes(error.data.code)
      )
        throw error
      if (["admitted", "not_dispatched"].includes(previous.attempt.state))
        fail("RUNTIME_OFFLINE", "The previous attempt was not dispatched; reconnect before retrying")
      unknown(query.requestID)
    }
  }
  return {
    async input(credentials: Credentials, value: Command.InputRequest, signal?: AbortSignal) {
      credentials = { ...credentials }
      const request = Command.InputRequest.parse(value)
      const query = { sessionID: request.sessionID, requestID: request.requestID }
      return serial(request.sessionID, signal, async (work) => {
        const previous = await admissions.inspectInput(credentials, request)
        if (previous?.accepted) return { existing: true, receipt: previous.accepted }
        if (previous) {
          const current = await reconcile(credentials, query, work)
          if (current.accepted) return { existing: true, receipt: current.accepted }
          if (!current.attempt.result?.skip) {
            const connection = connections.capture(request.runtimeID)
            const authorization = await admissions.prepareSkip(
              current.attempt.authorization.permit.attemptID,
              connection,
            )
            const reply = await connection
              .exchange({ kind: "skip", authorization }, work)
              .catch(() => unknown(request.requestID))
            if (reply.kind !== "result") unknown(request.requestID)
            const settled = await admissions.get(credentials, query)
            if (settled.accepted) return { existing: true, receipt: settled.accepted }
            if (!settled.attempt.result?.skip) unknown(request.requestID)
          }
        }
        if (work.signal.aborted) fail("RUNTIME_OFFLINE", "Command request ended before admission")
        const prepared = await admissions.input(credentials, request)
        if (prepared.kind === "accepted") return { existing: true, receipt: prepared.receipt }
        const attemptID = prepared.delivery.authorization.permit.attemptID
        try {
          if (work.signal.aborted) fail("RUNTIME_OFFLINE", "Command request ended before dispatch")
          await admissions.dispatch(attemptID, prepared.connection)
        } catch (error) {
          await admissions.dropped(attemptID)
          throw error
        }
        let reply: Command.Reply
        try {
          reply = await prepared.connection.exchange({ kind: "input", delivery: prepared.delivery }, work)
        } catch (error) {
          if (error instanceof OrganizationError && error.data.outcome === "not_dispatched") {
            await admissions.dropped(attemptID)
            throw new OrganizationError({ ...error.data, requestID: request.requestID })
          }
          await admissions.unknown(attemptID)
          unknown(request.requestID)
        }
        if (reply.kind !== "result") {
          await admissions.unknown(attemptID)
          unknown(request.requestID)
        }
        const observed = await admissions.get(credentials, query)
        if (observed.accepted) return { existing: false, receipt: observed.accepted }
        throw new OrganizationError({
          code: "REVISION_CONFLICT",
          requestID: request.requestID,
          outcome: "rejected",
          retryable: false,
          message: "Runtime rejected this command; inspect the retained attempt before retrying",
        })
      }).catch((error) => {
        if (error instanceof OrganizationError)
          throw new OrganizationError({ ...error.data, requestID: request.requestID })
        throw error
      })
    },
    async get(credentials: Credentials, query: Query, signal?: AbortSignal) {
      credentials = { ...credentials }
      query = { ...query }
      return serial(query.sessionID, signal, async (work) => {
        const prior = await admissions.get(credentials, query)
        if (prior.accepted) return prior
        try {
          return await reconcile(credentials, query, work)
        } catch (error) {
          if (
            !(error instanceof OrganizationError) ||
            !["COMMAND_OUTCOME_UNKNOWN", "RUNTIME_OFFLINE"].includes(error.data.code)
          )
            throw error
          return admissions.get(credentials, query)
        }
      })
    },
  }
}
export type CommandForwarder = ReturnType<typeof createCommandForwarder>
