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
  function unknown(requestID: string, cause?: unknown): never {
    throw new OrganizationError(
      {
        code: "COMMAND_OUTCOME_UNKNOWN",
        requestID,
        outcome: "unknown",
        retryable: false,
        message: "Runtime reception is unknown; query or explicitly retry this request ID",
      },
      { cause },
    )
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
  type Query = { sessionID?: string; requestID: string }
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
      unknown(query.requestID, error)
    }
  }
  type Prepared =
    | { kind: "accepted"; receipt: Command.Accepted }
    | {
        kind: "admitted"
        command: Extract<Command.Delivery, { kind: "input" | "create" | "control" }>
        connection: ReturnType<RuntimeConnections["capture"]>
      }
  async function submit(
    credentials: Credentials,
    request: { requestID: string; runtimeID: string },
    key: string,
    signal: AbortSignal | undefined,
    inspect: () => ReturnType<CommandAdmissions["inspectInput"]>,
    prepare: () => Promise<Prepared>,
  ) {
    const query = { requestID: request.requestID }
    return serial(key, signal, async (work) => {
      const previous = await inspect()
      if (previous?.accepted) return { existing: true, receipt: previous.accepted }
      if (previous) {
        const current = await reconcile(credentials, query, work)
        if (current.accepted) return { existing: true, receipt: current.accepted }
        if (!current.attempt.result?.skip) {
          const connection = connections.capture(request.runtimeID)
          const authorization = await admissions.prepareSkip(current.attempt.authorization.permit.attemptID, connection)
          const reply = await connection
            .exchange({ kind: "skip", authorization }, work)
            .catch((error) => unknown(request.requestID, error))
          if (reply.kind !== "result") unknown(request.requestID)
          const settled = await admissions.get(credentials, query)
          if (settled.accepted) return { existing: true, receipt: settled.accepted }
          if (!settled.attempt.result?.skip) unknown(request.requestID)
        }
      }
      if (work.signal.aborted) fail("RUNTIME_OFFLINE", "Command request ended before admission")
      const prepared = await prepare()
      if (prepared.kind === "accepted") return { existing: true, receipt: prepared.receipt }
      const attemptID = prepared.command.delivery.authorization.permit.attemptID
      try {
        if (work.signal.aborted) fail("RUNTIME_OFFLINE", "Command request ended before dispatch")
        await admissions.dispatch(attemptID, prepared.connection)
      } catch (error) {
        await admissions.dropped(attemptID)
        throw error
      }
      let reply: Command.Reply
      try {
        reply = await prepared.connection.exchange(prepared.command, work)
      } catch (error) {
        if (error instanceof OrganizationError && error.data.outcome === "not_dispatched") {
          await admissions.dropped(attemptID)
          throw new OrganizationError({ ...error.data, requestID: request.requestID }, { cause: error })
        }
        await admissions.unknown(attemptID)
        unknown(request.requestID, error)
      }
      if (
        reply.kind === "error" &&
        reply.error.code === "SERVICE_UNAVAILABLE" &&
        reply.error.outcome === "not_dispatched"
      ) {
        await admissions.dropped(attemptID)
        throw new OrganizationError({
          code: "SERVICE_UNAVAILABLE",
          requestID: request.requestID,
          outcome: "not_dispatched",
          retryable: reply.error.retryable,
          message: "Runtime did not admit the command; explicitly retry this request ID",
        })
      }
      if (reply.kind !== "result") {
        await admissions.unknown(attemptID)
        unknown(request.requestID)
      }
      const observed = await admissions.get(credentials, query)
      if (observed.accepted) return { existing: false, receipt: observed.accepted }
      if (observed.attempt.result?.attempt.status === "rejected" && !observed.attempt.result.skip) {
        try {
          if (work.signal.aborted) throw work.signal.reason
          const authorization = await admissions.prepareSkip(attemptID, prepared.connection)
          const closure = await prepared.connection.exchange({ kind: "skip", authorization }, work)
          if (closure.kind !== "result" || !closure.result.skip) throw new Error("Command sequence closure is absent")
        } catch (cause) {
          throw new OrganizationError(
            {
              code: "COMMAND_OUTCOME_UNKNOWN",
              requestID: request.requestID,
              outcome: "unknown",
              retryable: false,
              message:
                "Runtime rejected the command, but its sequence closure is unconfirmed; reconcile this request ID",
            },
            { cause },
          )
        }
      }
      throw new OrganizationError({
        code: "REVISION_CONFLICT",
        requestID: request.requestID,
        outcome: "rejected",
        retryable: false,
        message: "Runtime rejected this command; inspect the retained attempt before retrying",
      })
    }).catch((error) => {
      if (error instanceof OrganizationError) {
        if (error.data.requestID === request.requestID) throw error
        throw new OrganizationError({ ...error.data, requestID: request.requestID }, { cause: error })
      }
      unknown(request.requestID, error)
    })
  }
  return {
    async control(credentials: Credentials, value: Command.ControlRequest, signal?: AbortSignal) {
      credentials = { ...credentials }
      const request = Command.ControlRequest.parse(value)
      const result = await submit(
        credentials,
        request,
        request.sessionID,
        signal,
        () => admissions.inspectControl(credentials, request),
        async () => {
          const prepared = await admissions.control(credentials, request)
          return prepared.kind === "accepted"
            ? prepared
            : {
                kind: "admitted",
                connection: prepared.connection,
                command: { kind: "control", delivery: prepared.delivery },
              }
        },
      )
      return { ...result, receipt: Command.ControlAccepted.parse(result.receipt) }
    },
    async input(credentials: Credentials, value: Command.InputRequest, signal?: AbortSignal) {
      credentials = { ...credentials }
      const request = Command.InputRequest.parse(value)
      const result = await submit(
        credentials,
        request,
        request.sessionID,
        signal,
        () => admissions.inspectInput(credentials, request),
        async () => {
          const prepared = await admissions.input(credentials, request)
          return prepared.kind === "accepted"
            ? prepared
            : {
                kind: "admitted",
                connection: prepared.connection,
                command: { kind: "input", delivery: prepared.delivery },
              }
        },
      )
      return { ...result, receipt: Command.InputAccepted.parse(result.receipt) }
    },
    async create(credentials: Credentials, value: Command.CreateRequest, signal?: AbortSignal) {
      credentials = { ...credentials }
      const request = Command.CreateRequest.parse(value)
      const result = await submit(
        credentials,
        request,
        `create:${request.orgID}:${request.requestID}`,
        signal,
        () => admissions.inspectCreate(credentials, request),
        async () => {
          const prepared = await admissions.create(credentials, request)
          return prepared.kind === "accepted"
            ? prepared
            : {
                kind: "admitted",
                connection: prepared.connection,
                command: { kind: "create", delivery: prepared.delivery },
              }
        },
      )
      return { ...result, receipt: Command.CreatedAccepted.parse(result.receipt) }
    },
    async get(credentials: Credentials, query: Query, signal?: AbortSignal) {
      credentials = { ...credentials }
      query = { ...query }
      const initial = await admissions.get(credentials, query)
      const permit = initial.attempt.authorization.permit
      const key = permit.operation === "create" ? `create:${permit.orgID}:${permit.requestID}` : permit.sessionID
      return serial(key, signal, async (work) => {
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
