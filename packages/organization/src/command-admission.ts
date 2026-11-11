import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { authorize } from "./authorization"
import { authenticate, type Credentials } from "./auth/session"
import { OrganizationSessionDirectory } from "./session-directory"
import { OrganizationRecord as Record } from "./storage/records"
import { runtimeAuthority, assertRuntimeConnection } from "./runtime-authority"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail, OrganizationError } from "./error"
import type { RuntimeConnections, RuntimeConnectionLease } from "./runtime-connection"
import type { CommandSigningAuthority } from "./signing"
import { digest } from "./auth/secret"
import { OrganizationExecutionGrants } from "./execution-grants"

const Lookup = z.strictObject({ sessionID: Identity.ID.optional(), requestID: Identity.ID })
type Target = Pick<Command.Permit, "orgID" | "requestID" | "sessionID" | "projectID" | "runtimeID">
type Prepared = { kind: "admitted"; authorization: Command.SignedPermit; connection: RuntimeConnectionLease }
type Accepted = { kind: "accepted"; receipt: Command.Accepted }

function unknown(requestID: string): never {
  throw new OrganizationError({
    code: "COMMAND_OUTCOME_UNKNOWN",
    requestID,
    outcome: "unknown",
    retryable: false,
    message: "Reconcile the existing command attempt before authorizing another attempt",
  })
}
function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createCommandAdmissions(options: {
  connections: RuntimeConnections
  signing: CommandSigningAuthority
}) {
  const { connections, signing } = options
  function standalone() {
    if (Storage.inTransaction()) fail("INVALID_REQUEST", "Command admission must own its commit boundary")
  }
  async function attempt(attemptID: string) {
    const current = await Record.read(Record.CommandAttempt, Keys.commandAttempt(Identity.ID.parse(attemptID)))
    if (!current || current.authorization.permit.attemptID !== attemptID) fail("NOT_FOUND", "Command attempt not found")
    return current
  }
  async function lookupTarget(
    credentials: Credentials,
    request: Target,
    payloadHash: string,
    operation: Command.Permit["operation"],
  ) {
    const current = await authorize(credentials, "session.read", { sessionID: request.sessionID })
    const { account, session } = current
    if (
      request.orgID !== account.orgID ||
      request.projectID !== session.projectID ||
      request.runtimeID !== session.driverRuntimeID
    )
      fail("REVISION_CONFLICT", "Command target does not match the Session directory")
    const previous = await Record.read(Record.CommandRequest, Keys.commandRequest(account.accountID, request.requestID))
    if (previous) {
      const original = previous.first
      if (
        original.orgID !== account.orgID ||
        original.actor.subjectID !== account.accountID ||
        original.requestID !== request.requestID ||
        original.sessionID !== request.sessionID ||
        original.projectID !== request.projectID ||
        original.runtimeID !== request.runtimeID ||
        original.operation !== operation ||
        original.payloadHash !== payloadHash
      )
        fail("REVISION_CONFLICT", "Logical command identity cannot change its payload or target")
    }
    return { current, previous }
  }
  async function admit(
    credentials: Credentials,
    operation: Command.Permit["operation"],
    resolve: () => Promise<
      Awaited<ReturnType<typeof lookupTarget>> & { request: Target; payloadHash: string; execution?: boolean }
    >,
  ): Promise<Prepared | Accepted> {
    standalone()
    let connection: RuntimeConnectionLease | undefined
    let deadline: number | undefined
    return Storage.transaction(
      async () => {
        connection = undefined
        deadline = undefined
        const { current, previous, request, payloadHash, execution } = await resolve()
        const { account, session } = current
        const requestKey = Keys.commandRequest(account.accountID, request.requestID)
        if (previous?.accepted) return { kind: "accepted" as const, receipt: previous.accepted }
        await authorize(
          credentials,
          operation === "pause" || operation === "cancel" || operation === "decision"
            ? "session.stop"
            : "session.execute",
          {
            sessionID: request.sessionID,
          },
        )
        const stateKey = Keys.commandState(session.sessionID)
        const state = await Record.read(Record.CommandState, stateKey)
        if (state?.pendingAttemptID) {
          const pending = (await attempt(state.pendingAttemptID)).authorization.permit
          if (pending.actor.subjectID === account.accountID && pending.requestID === request.requestID)
            unknown(request.requestID)
          fail("REVISION_CONFLICT", "Reconcile the earlier Session command before admitting this request")
        }
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(session.driverRuntimeID))
        if (
          !runtime ||
          runtime.runtimeID !== session.driverRuntimeID ||
          runtime.orgID !== account.orgID ||
          runtime.deploymentIncarnation !== signing.identity.deploymentIncarnation ||
          runtime.state !== "active"
        )
          fail("RUNTIME_OFFLINE", "Session Runtime is not available")
        await runtimeAuthority({
          runtimeID: runtime.runtimeID,
          orgID: account.orgID,
          deploymentIncarnation: signing.identity.deploymentIncarnation,
          connectionEpoch: runtime.connectionEpoch,
        })
        connection = connections.capture(runtime.runtimeID)
        const handshake = connection.handshake
        assertRuntimeConnection(runtime, handshake)
        const authorizedAt = Date.now()
        deadline = authorizedAt + 30_000
        const prepared = Command.Permit.parse({
          schemaVersion: 1,
          purpose: "session-command",
          orgID: account.orgID,
          deploymentIncarnation: signing.identity.deploymentIncarnation,
          keyID: signing.identity.keyID,
          requestID: request.requestID,
          payloadHash,
          sessionID: session.sessionID,
          projectID: session.projectID,
          runtimeID: runtime.runtimeID,
          bindingEpoch: session.bindingEpoch,
          connectionEpoch: handshake.connectionEpoch,
          commandSeq: (state?.commandSeq ?? 0) + 1,
          shareGeneration: session.shareGeneration,
          controlRevision: session.controlRevision,
          authRevision: account.authRevision,
          admissionID: crypto.randomUUID(),
          attemptID: crypto.randomUUID(),
          operation,
          actor: {
            kind: "account",
            orgID: account.orgID,
            subjectID: account.accountID,
            displayName: account.displayName,
            clientKind: current.clientKind,
            requestID: request.requestID,
          },
          authorizedAt,
          deadline,
        })
        const provisionalGrantID = execution
          ? await OrganizationExecutionGrants.provision(session, prepared)
          : undefined
        const permit = Command.Permit.parse({ ...prepared, ...(provisionalGrantID ? { provisionalGrantID } : {}) })
        const authorization = await signing.sign(permit)
        await Storage.write(
          Keys.commandAttempt(permit.attemptID),
          Record.CommandAttempt.parse({
            schemaVersion: 1,
            authorization,
            state: "admitted",
            updatedAt: authorizedAt,
          }),
        )
        const index = Record.CommandAttemptIndex.parse({ attemptID: permit.attemptID })
        await Storage.write(Keys.sessionCommand(session.sessionID, permit.commandSeq), index)
        await Storage.write(Keys.requestAttempt(account.accountID, request.requestID, permit.commandSeq), index)
        await Storage.write(
          requestKey,
          Record.CommandRequest.parse({
            schemaVersion: 1,
            first: previous?.first ?? permit,
            lastAttemptID: permit.attemptID,
          }),
        )
        await Storage.write(
          stateKey,
          Record.CommandState.parse({
            schemaVersion: 1,
            commandSeq: permit.commandSeq,
            pendingAttemptID: permit.attemptID,
          }),
        )
        return { kind: "admitted" as const, authorization, connection }
      },
      {
        commitGuard() {
          connection?.assertCurrent()
          if (deadline !== undefined && Date.now() >= deadline)
            fail("RUNTIME_OFFLINE", "Command admission expired before commit")
        },
      },
    )
  }

  async function transition(
    attemptID: string,
    next: "dispatching" | "not_dispatched" | "unknown",
    connection?: RuntimeConnectionLease,
  ) {
    standalone()
    let deadline: number | undefined
    return Storage.transaction(
      async () => {
        deadline = undefined
        const current = await attempt(attemptID)
        if (["accepted", "rejected"].includes(current.state) || current.state === next) return current
        if (next === "unknown" ? current.state !== "dispatching" : current.state !== "admitted")
          fail("REVISION_CONFLICT", "Command transmission state does not allow this transition")
        if (next === "dispatching") {
          if (
            !connection ||
            connection.handshake.runtimeID !== current.authorization.permit.runtimeID ||
            connection.handshake.connectionEpoch !== current.authorization.permit.connectionEpoch
          )
            fail("STALE_CONNECTION", "Command dispatch requires its original connection")
          connection.assertCurrent()
          deadline = current.authorization.permit.deadline
          if (Date.now() >= deadline) fail("RUNTIME_OFFLINE", "Command permit expired before dispatch")
        }
        const updated = { ...current, state: next, updatedAt: Date.now() }
        await Storage.write(Keys.commandAttempt(attemptID), updated)
        return updated
      },
      {
        commitGuard() {
          connection?.assertCurrent()
          if (deadline !== undefined && Date.now() >= deadline)
            fail("RUNTIME_OFFLINE", "Command permit expired before dispatch commit")
        },
      },
    )
  }

  async function prepareSkip(attemptID: string, connection: RuntimeConnectionLease) {
    standalone()
    let deadline: number | undefined
    return Storage.transaction(
      async () => {
        deadline = undefined
        const current = await attempt(attemptID)
        const permit = current.authorization.permit
        if (!["not_dispatched", "rejected"].includes(current.state))
          fail("REVISION_CONFLICT", "Reconcile the original attempt before preparing a skip")
        if (connection.handshake.runtimeID !== permit.runtimeID)
          fail("STALE_CONNECTION", "Skip targets another Runtime")
        connection.assertCurrent()
        if (
          current.skip &&
          current.skip.permit.connectionEpoch === connection.handshake.connectionEpoch &&
          current.skip.permit.deadline > Date.now()
        ) {
          deadline = current.skip.permit.deadline
          return current.skip
        }
        const authorizedAt = Date.now()
        const skip = await signing.signSkip({
          schemaVersion: 1,
          purpose: "session-command-skip",
          command: permit,
          connectionEpoch: connection.handshake.connectionEpoch,
          authorizedAt,
          deadline: authorizedAt + 30_000,
        })
        deadline = skip.permit.deadline
        await Storage.write(Keys.commandAttempt(attemptID), { ...current, skip, updatedAt: authorizedAt })
        await Storage.write(Keys.commandSkip(attemptID, digest(JSON.stringify(skip.permit))), skip)
        return skip
      },
      {
        commitGuard() {
          connection.assertCurrent()
          if (deadline !== undefined && Date.now() >= deadline)
            fail("RUNTIME_OFFLINE", "Command skip expired before commit")
        },
      },
    )
  }

  async function observe(connection: RuntimeConnectionLease, value: Command.Result) {
    standalone()
    const result = Command.Result.parse(value)
    return Storage.transaction(
      async () => {
        connection.assertCurrent()
        const permit = result.attempt.permit
        const current = await attempt(permit.attemptID)
        if (
          connection.handshake.runtimeID !== permit.runtimeID ||
          connection.handshake.orgID !== permit.orgID ||
          connection.handshake.deploymentIncarnation !== permit.deploymentIncarnation ||
          connection.handshake.connectionEpoch < permit.connectionEpoch ||
          !equal(current.authorization.permit, permit)
        )
          fail("PROTOCOL_MISMATCH", "Runtime receipt does not match the admitted command")
        if (current.result && !equal(current.result.attempt, result.attempt))
          fail("PROTOCOL_MISMATCH", "Runtime attempt outcome cannot change")
        if (result.skip) {
          const proof = await Record.read(
            Command.SignedSkip,
            Keys.commandSkip(permit.attemptID, digest(JSON.stringify(result.skip.permit))),
          )
          if (!proof || !equal(proof.permit, result.skip.permit) || !equal(proof.permit.command, permit))
            fail("PROTOCOL_MISMATCH", "Runtime skip receipt does not match its service proof")
        }
        if (result.attempt.status === "skipped" && !result.skip)
          fail("PROTOCOL_MISMATCH", "Skipped attempt requires its durable skip proof")
        if (
          result.attempt.status === "accepted" &&
          (!result.accepted || result.attempt.acceptedAttemptID !== result.accepted.permit.attemptID)
        )
          fail("PROTOCOL_MISMATCH", "Accepted attempt requires its logical effect receipt")
        const requestKey = Keys.commandRequest(permit.actor.subjectID, permit.requestID)
        const request = await Record.read(Record.CommandRequest, requestKey)
        if (
          !request ||
          request.first.payloadHash !== permit.payloadHash ||
          request.first.sessionID !== permit.sessionID
        )
          fail("PROTOCOL_MISMATCH", "Runtime receipt has no matching logical request")
        if (result.accepted) {
          const accepted = result.accepted.permit
          const original = await attempt(accepted.attemptID)
          if (
            !equal(original.authorization.permit, accepted) ||
            accepted.orgID !== permit.orgID ||
            accepted.actor.subjectID !== permit.actor.subjectID ||
            accepted.requestID !== permit.requestID ||
            accepted.payloadHash !== permit.payloadHash ||
            accepted.sessionID !== permit.sessionID ||
            accepted.runtimeID !== permit.runtimeID ||
            (request.accepted && !equal(request.accepted, result.accepted))
          )
            fail("PROTOCOL_MISMATCH", "Logical command effect cannot change")
          await Storage.write(requestKey, Record.CommandRequest.parse({ ...request, accepted: result.accepted }))
        }
        const observed = {
          ...result,
          accepted: result.accepted ?? current.result?.accepted,
          skip: result.skip ?? current.result?.skip,
        }
        const updated = Record.CommandAttempt.parse({
          ...current,
          state: result.attempt.status === "accepted" ? "accepted" : "rejected",
          result: observed,
          updatedAt: Date.now(),
        })
        await Storage.write(Keys.commandAttempt(permit.attemptID), updated)
        if (result.accepted?.permit.attemptID !== permit.attemptID) await OrganizationExecutionGrants.reject(permit)
        if (result.attempt.status === "accepted" || observed.skip) {
          const stateKey = Keys.commandState(permit.sessionID)
          const state = await Record.read(Record.CommandState, stateKey)
          if (state?.pendingAttemptID === permit.attemptID) {
            const { pendingAttemptID: _, ...settled } = state
            await Storage.write(stateKey, settled)
          }
        }
        return updated
      },
      { commitGuard: () => connection.assertCurrent() },
    )
  }

  return {
    async decision(credentials: Credentials, value: Command.DecisionRequest) {
      standalone()
      credentials = { ...credentials }
      const request = Command.DecisionRequest.parse(value)
      const payloadHash = await Command.digestDecision(request)
      const result = await admit(credentials, "decision", async () => ({
        request,
        payloadHash,
        ...(await lookupTarget(credentials, request, payloadHash, "decision")),
      }))
      if (result.kind === "accepted")
        return { kind: "accepted" as const, receipt: Command.DecisionAccepted.parse(result.receipt) }
      return {
        kind: "admitted" as const,
        delivery: { authorization: result.authorization, decision: request.decision },
        connection: result.connection,
      }
    },
    async control(credentials: Credentials, value: Command.ControlRequest) {
      standalone()
      credentials = { ...credentials }
      const request = Command.ControlRequest.parse(value)
      const payloadHash = await Command.digestControl(request)
      const result = await admit(credentials, request.control.operation, async () => ({
        request,
        payloadHash,
        ...(await lookupTarget(credentials, request, payloadHash, request.control.operation)),
      }))
      if (result.kind === "accepted")
        return { kind: "accepted" as const, receipt: Command.ControlAccepted.parse(result.receipt) }
      return {
        kind: "admitted" as const,
        delivery: { authorization: result.authorization, control: request.control },
        connection: result.connection,
      }
    },
    async input(credentials: Credentials, value: Command.InputRequest) {
      standalone()
      credentials = { ...credentials }
      const request = Command.InputRequest.parse(value)
      const payloadHash = await Command.digestInput(request)
      const result = await admit(credentials, "input", async () => ({
        request,
        payloadHash,
        execution: request.input.mode === "task",
        ...(await lookupTarget(credentials, request, payloadHash, "input")),
      }))
      if (result.kind === "accepted")
        return { kind: "accepted" as const, receipt: Command.InputAccepted.parse(result.receipt) }
      return {
        kind: "admitted" as const,
        delivery: { authorization: result.authorization, input: request.input },
        connection: result.connection,
      }
    },
    async create(credentials: Credentials, value: Command.CreateRequest) {
      standalone()
      credentials = { ...credentials }
      const request = Command.CreateRequest.parse(value)
      const sessionID = Identifier.descending("session")
      const result = await admit(credentials, "create", async () => {
        const { account } = await authorize(credentials, "project.read", { projectID: request.projectID })
        if (account.orgID !== request.orgID) fail("REVISION_CONFLICT", "Creation targets another organization")
        const previous = await Record.read(
          Record.CommandRequest,
          Keys.commandRequest(account.accountID, request.requestID),
        )
        const target = Command.CreateTarget.parse({ ...request, sessionID: previous?.first.sessionID ?? sessionID })
        const payloadHash = await Command.digestCreate(target)
        if (!previous)
          await OrganizationSessionDirectory.reservePrivate(credentials, {
            sessionID: target.sessionID,
            projectID: target.projectID,
            runtimeID: target.runtimeID,
          })
        return { request: target, payloadHash, ...(await lookupTarget(credentials, target, payloadHash, "create")) }
      })
      if (result.kind === "accepted")
        return { kind: "accepted" as const, receipt: Command.CreatedAccepted.parse(result.receipt) }
      return {
        kind: "admitted" as const,
        delivery: { authorization: result.authorization, creation: request.creation },
        connection: result.connection,
      }
    },
    observe,
    prepareSkip,
    async inspectDecision(credentials: Credentials, value: Command.DecisionRequest) {
      credentials = { ...credentials }
      const request = Command.DecisionRequest.parse(value)
      const payloadHash = await Command.digestDecision(request)
      return Storage.snapshot(async () => {
        const { previous } = await lookupTarget(credentials, request, payloadHash, "decision")
        return previous ? { attempt: await attempt(previous.lastAttemptID), accepted: previous.accepted } : undefined
      })
    },
    async inspectControl(credentials: Credentials, value: Command.ControlRequest) {
      credentials = { ...credentials }
      const request = Command.ControlRequest.parse(value)
      const payloadHash = await Command.digestControl(request)
      return Storage.snapshot(async () => {
        const { previous } = await lookupTarget(credentials, request, payloadHash, request.control.operation)
        return previous ? { attempt: await attempt(previous.lastAttemptID), accepted: previous.accepted } : undefined
      })
    },
    async inspectInput(credentials: Credentials, value: Command.InputRequest) {
      credentials = { ...credentials }
      const request = Command.InputRequest.parse(value)
      const payloadHash = await Command.digestInput(request)
      return Storage.snapshot(async () => {
        const { previous } = await lookupTarget(credentials, request, payloadHash, "input")
        return previous ? { attempt: await attempt(previous.lastAttemptID), accepted: previous.accepted } : undefined
      })
    },
    async inspectCreate(credentials: Credentials, value: Command.CreateRequest) {
      credentials = { ...credentials }
      const request = Command.CreateRequest.parse(value)
      return Storage.snapshot(async () => {
        const { account } = await authorize(credentials, "project.read", { projectID: request.projectID })
        if (account.orgID !== request.orgID) fail("REVISION_CONFLICT", "Creation targets another organization")
        const prior = await Record.read(
          Record.CommandRequest,
          Keys.commandRequest(account.accountID, request.requestID),
        )
        if (!prior) return undefined
        const target = Command.CreateTarget.parse({ ...request, sessionID: prior.first.sessionID })
        const { previous } = await lookupTarget(credentials, target, await Command.digestCreate(target), "create")
        return { attempt: await attempt(previous!.lastAttemptID), accepted: previous!.accepted }
      })
    },
    async absent(connection: RuntimeConnectionLease, value: Command.QueryResult) {
      standalone()
      const query = Command.QueryResult.parse(value)
      if (query.result) fail("INVALID_REQUEST", "An existing receipt is not an absence proof")
      const permit = query.authorization.permit
      return Storage.transaction(
        async () => {
          connection.assertCurrent()
          const current = await attempt(permit.attemptID)
          if (
            connection.handshake.orgID !== permit.orgID ||
            connection.handshake.runtimeID !== permit.runtimeID ||
            connection.handshake.deploymentIncarnation !== permit.deploymentIncarnation ||
            connection.handshake.connectionEpoch < permit.connectionEpoch ||
            !equal(current.authorization, query.authorization) ||
            current.result
          )
            fail("PROTOCOL_MISMATCH", "Runtime absence does not match the retained attempt")
          await Storage.write(Keys.commandAttempt(permit.attemptID), {
            ...current,
            state: "not_dispatched",
            updatedAt: Date.now(),
          })
        },
        { commitGuard: () => connection.assertCurrent() },
      )
    },
    async dropped(attemptID: string) {
      standalone()
      return Storage.transaction(async () => {
        const current = await attempt(attemptID)
        if (!["admitted", "dispatching"].includes(current.state)) return current
        const updated = { ...current, state: "not_dispatched" as const, updatedAt: Date.now() }
        await Storage.write(Keys.commandAttempt(attemptID), updated)
        return updated
      })
    },
    dispatch: (attemptID: string, connection: RuntimeConnectionLease) =>
      transition(attemptID, "dispatching", connection),
    notDispatched: (attemptID: string) => transition(attemptID, "not_dispatched"),
    unknown: (attemptID: string) => transition(attemptID, "unknown"),
    async get(credentials: Credentials, value: z.infer<typeof Lookup>) {
      credentials = { ...credentials }
      const query = Lookup.parse(value)
      return Storage.snapshot(async () => {
        const { account } = await authenticate(credentials)
        const request = await Record.read(
          Record.CommandRequest,
          Keys.commandRequest(account.accountID, query.requestID),
        )
        if (
          !request ||
          (query.sessionID !== undefined && request.first.sessionID !== query.sessionID) ||
          request.first.orgID !== account.orgID ||
          request.first.actor.subjectID !== account.accountID
        )
          fail("NOT_FOUND", "Command request not found")
        const { session } = await authorize(credentials, "session.read", { sessionID: request.first.sessionID })
        return { attempt: await attempt(request.lastAttemptID), accepted: request.accepted, session }
      })
    },
  }
}
export type CommandAdmissions = ReturnType<typeof createCommandAdmissions>
