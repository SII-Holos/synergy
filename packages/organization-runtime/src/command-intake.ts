import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationIdentity as Identity,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionTransfer } from "@ericsanchezok/synergy-harness/session/transfer"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRuntimeError } from "./error"
import { OrganizationIntakePath as Keys } from "./storage/path"

const RequestIdentity = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  subjectID: Identity.ID,
  requestID: Identity.ID,
  sessionID: Identity.ID,
  projectID: Identity.ID,
  runtimeID: Identity.ID,
  operation: Command.Operation,
  payloadHash: OrganizationProtocol.Digest,
})
const Request = z
  .strictObject({ identity: RequestIdentity, accepted: Command.Accepted.optional() })
  .refine(
    (value) => !value.accepted || JSON.stringify(value.identity) === JSON.stringify(identity(value.accepted.permit)),
    "Accepted effect must belong to its logical request",
  )
const State = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  sessionID: Identity.ID,
  projectID: Identity.ID,
  runtimeID: Identity.ID,
  bindingEpoch: OrganizationProtocol.Epoch,
  commandSeq: Identity.Revision,
})
const Slot = z.strictObject({ schemaVersion: z.literal(1), attemptID: Identity.ID })
const Counter = z.strictObject({ schemaVersion: z.literal(1), intakeSeq: Identity.Revision })
const Lookup = z.strictObject({ subjectID: Identity.ID, requestID: Identity.ID })

function failure(code: OrganizationProtocol.Error["code"], message: string) {
  return new OrganizationRuntimeError({ code, message, outcome: "rejected", retryable: false })
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input)
  if (!value.success) throw failure("PROTOCOL_MISMATCH", "Command data does not match the supported protocol")
  return value.data
}
async function read<T>(schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
  const [value] = await Storage.readMany<unknown>([key])
  return value === undefined ? undefined : parse(schema, value)
}
function identity(permit: Command.Permit) {
  return RequestIdentity.parse({
    schemaVersion: 1,
    orgID: permit.orgID,
    subjectID: permit.actor.subjectID,
    requestID: permit.requestID,
    sessionID: permit.sessionID,
    projectID: permit.projectID,
    runtimeID: permit.runtimeID,
    operation: permit.operation,
    payloadHash: permit.payloadHash,
  })
}
function expired(window: { authorizedAt: number; deadline: number }) {
  const now = Date.now()
  return now < window.authorizedAt || now >= window.deadline
}
class PermitExpired extends Error {}

export function createCommandIntake(options: {
  identity: Command.SigningIdentity
  runtimeID: string
  connectionEpoch: number
  signal: AbortSignal
}) {
  const authority = Command.SigningIdentity.parse(options.identity)
  const runtimeID = Identity.ID.parse(options.runtimeID)
  const connectionEpoch = OrganizationProtocol.Epoch.parse(options.connectionEpoch)
  const signal = options.signal

  function assertActive() {
    if (signal.aborted) throw failure("STALE_CONNECTION", "Command connection is no longer active")
  }
  function assertStandalone() {
    if (Storage.inTransaction()) throw failure("INVALID_REQUEST", "Command intake must own its commit boundary")
    assertActive()
  }
  function assertAuthority(permit: Command.Permit) {
    assertActive()
    if (
      permit.orgID !== authority.orgID ||
      permit.deploymentIncarnation !== authority.deploymentIncarnation ||
      permit.keyID !== authority.keyID ||
      permit.runtimeID !== runtimeID
    )
      throw failure("PERMISSION_DENIED", "Command authority does not match this Runtime")
  }
  async function binding(permit: Command.Permit): Promise<Command.Rejection | undefined> {
    const session = await Session.get(permit.sessionID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!session) return "SESSION_UNAVAILABLE"
    const current = session.organization
    if (
      !current ||
      current.orgID !== permit.orgID ||
      current.projectID !== permit.projectID ||
      current.driverRuntimeID !== permit.runtimeID ||
      current.bindingEpoch !== permit.bindingEpoch
    )
      return "STALE_BINDING"
  }
  async function records(permit: Command.Permit) {
    const expected = identity(permit)
    const requestKey = Keys.request(permit.orgID, permit.actor.subjectID, permit.requestID)
    const attemptKey = Keys.attempt(permit.orgID, permit.sessionID, permit.attemptID)
    const stateKey = Keys.state(permit.orgID, permit.sessionID)
    const slotKey = Keys.slot(permit.orgID, permit.sessionID, permit.commandSeq)
    const skipKey = Keys.skip(permit.orgID, permit.sessionID, permit.attemptID)
    const request = await read(Request, requestKey)
    const attempt = await read(Command.Attempt, attemptKey)
    const skip = await read(Command.SkipReceipt, skipKey)
    if (attempt && JSON.stringify(attempt.permit) !== JSON.stringify(permit))
      throw failure("REVISION_CONFLICT", "Command attempt identity cannot be reused")
    if (skip && (!attempt || JSON.stringify(skip.permit.command) !== JSON.stringify(permit)))
      throw failure("PROTOCOL_MISMATCH", "Command skip receipt does not match its attempt")
    const state = (await read(State, stateKey)) ?? {
      schemaVersion: 1,
      orgID: permit.orgID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      runtimeID: permit.runtimeID,
      bindingEpoch: permit.bindingEpoch,
      commandSeq: 0,
    }
    const slot = await read(Slot, slotKey)
    const matches = !request || JSON.stringify(request.identity) === JSON.stringify(expected)
    return {
      expected,
      requestKey,
      attemptKey,
      stateKey,
      slotKey,
      skipKey,
      request,
      attempt,
      skip,
      state,
      slot,
      matches,
    }
  }
  type Records = Awaited<ReturnType<typeof records>>

  function stateMatches(permit: Command.Permit, state: z.infer<typeof State>) {
    return (
      state.orgID === permit.orgID &&
      state.sessionID === permit.sessionID &&
      state.projectID === permit.projectID &&
      state.runtimeID === permit.runtimeID &&
      state.bindingEpoch === permit.bindingEpoch
    )
  }
  async function persist(
    permit: Command.Permit,
    current: Records,
    attempt: Command.Attempt,
    accepted?: Command.Accepted,
    advance = true,
  ) {
    if (!current.request || accepted) {
      await Storage.write(current.requestKey, { identity: current.expected, ...(accepted ? { accepted } : {}) })
      await Storage.write(
        Keys.sessionRequest(permit.orgID, permit.sessionID, permit.actor.subjectID, permit.requestID),
        {
          schemaVersion: 1,
          subjectID: permit.actor.subjectID,
          requestID: permit.requestID,
        },
      )
    }
    await Storage.write(current.attemptKey, attempt)
    if (
      advance &&
      stateMatches(permit, current.state) &&
      permit.commandSeq === current.state.commandSeq + 1 &&
      !current.slot
    ) {
      await Storage.write(current.slotKey, { schemaVersion: 1, attemptID: permit.attemptID })
      await Storage.write(current.stateKey, { ...current.state, commandSeq: permit.commandSeq })
    }
  }
  function result(current: Records, attempt: Command.Attempt, accepted?: Command.Accepted): Command.Result {
    return Command.Result.parse({
      attempt,
      accepted: accepted ?? (current.matches ? current.request?.accepted : undefined),
      skip: current.skip,
    })
  }

  async function input(value: Command.InputDelivery): Promise<Command.Result> {
    assertStandalone()
    const delivery = parse(Command.InputDelivery, value)
    const { permit, signature } = delivery.authorization
    assertAuthority(permit)
    if (!(await Command.verify(permit, signature, authority.publicKey)))
      throw failure("PERMISSION_DENIED", "Command signature is invalid")
    const payloadMatches =
      (await Command.digestInput(Command.inputRequest(permit, delivery.input))) === permit.payloadHash
    const receive = () => {
      let accepting = false
      return Storage.transaction(
        async () => {
          assertActive()
          const current = await records(permit)
          if (current.attempt) {
            if (!payloadMatches)
              throw failure("REVISION_CONFLICT", "Command payload does not match its retained attempt")
            return result(current, current.attempt)
          }
          const bindingReason = await binding(permit)
          let reason: Command.Rejection | undefined
          if (!current.matches) reason = "REQUEST_CONFLICT"
          else if (!payloadMatches) reason = "PAYLOAD_MISMATCH"
          else if (permit.connectionEpoch !== connectionEpoch) reason = "STALE_CONNECTION"
          else if (expired(permit)) reason = "EXPIRED_PERMIT"
          else if (bindingReason) reason = bindingReason
          else if (!stateMatches(permit, current.state)) reason = "STALE_BINDING"
          if (!reason) {
            if (permit.commandSeq <= current.state.commandSeq || current.slot) reason = "SEQUENCE_CLOSED"
            else if (permit.commandSeq !== current.state.commandSeq + 1) reason = "SEQUENCE_GAP"
            else if (await SessionTransfer.isFrozen(permit.sessionID)) reason = "TRANSFER_BLOCKED"
            else if ((await Session.get(permit.sessionID)).time.archived) reason = "SESSION_UNAVAILABLE"
          }
          if (reason) {
            const attempt: Command.Attempt = {
              schemaVersion: 1,
              permit,
              receivedAt: Date.now(),
              status: "rejected",
              reason,
            }
            await persist(permit, current, attempt, undefined, !bindingReason)
            return result(current, attempt)
          }
          let accepted = current.request?.accepted
          if (!accepted) {
            accepting = true
            const counterKey = Keys.intake(permit.orgID, permit.runtimeID)
            const counter = await read(Counter, counterKey)
            const intakeSeq = OrganizationProtocol.Epoch.parse((counter?.intakeSeq ?? 0) + 1)
            // The receipt transaction owns uniqueness; taking the Inbox delivery lock here would invert lock order.
            const effect = await SessionInbox.deliver({
              sessionID: permit.sessionID,
              deliveryKey: `organization:${permit.orgID}:${permit.actor.subjectID}:${permit.requestID}`,
              mode: delivery.input.mode,
              message: { role: "user", actor: permit.actor, origin: { type: "user" }, parts: delivery.input.parts },
            })
            const acceptedAt = Date.now()
            if (acceptedAt < permit.authorizedAt || acceptedAt >= permit.deadline) throw new PermitExpired()
            accepted = Command.Accepted.parse({
              schemaVersion: 1,
              permit,
              acceptedAt,
              intakeSeq,
              effect: { kind: "inbox", itemID: effect.itemID, messageID: effect.messageID, mode: delivery.input.mode },
            })
            await Storage.write(counterKey, { schemaVersion: 1, intakeSeq })
          }
          const attempt: Command.Attempt = {
            schemaVersion: 1,
            permit,
            receivedAt: Date.now(),
            status: "accepted",
            acceptedAttemptID: accepted.permit.attemptID,
          }
          await persist(permit, current, attempt, accepted)
          return result(current, attempt, accepted)
        },
        {
          commitGuard() {
            assertActive()
            if (accepting && expired(permit)) throw new PermitExpired()
          },
        },
      )
    }
    try {
      return await receive()
    } catch (error) {
      if (!(error instanceof PermitExpired)) throw error
      return receive()
    }
  }

  async function skip(value: Command.SignedSkip): Promise<Command.Result> {
    assertStandalone()
    const signed = parse(Command.SignedSkip, value)
    const proof = signed.permit
    const permit = proof.command
    assertAuthority(permit)
    if (!(await Command.verifySkip(proof, signed.signature, authority.publicKey)))
      throw failure("PERMISSION_DENIED", "Command skip signature is invalid")
    if (proof.connectionEpoch !== connectionEpoch) throw failure("STALE_CONNECTION", "Skip connection changed")
    if (expired(proof)) throw failure("REVISION_CONFLICT", "Command skip permit expired")
    return Storage.transaction(
      async () => {
        assertActive()
        const current = await records(permit)
        if (current.skip || current.attempt?.status === "accepted") return result(current, current.attempt!)
        if (!current.matches) throw failure("REVISION_CONFLICT", "Logical command payload changed")
        if ((await binding(permit)) || !stateMatches(permit, current.state))
          throw failure("STALE_BINDING", "Skip target binding changed")
        if (permit.commandSeq > current.state.commandSeq + 1)
          throw failure("REVISION_CONFLICT", "Earlier command slots require reconciliation")
        if (current.slot && current.slot.attemptID !== permit.attemptID)
          throw failure("REVISION_CONFLICT", "Command slot belongs to another attempt")
        if (permit.commandSeq <= current.state.commandSeq && !current.slot)
          throw failure("REVISION_CONFLICT", "Command slot has no retained receipt")
        const attempt: Command.Attempt = current.attempt ?? {
          schemaVersion: 1,
          permit,
          receivedAt: Date.now(),
          status: "skipped",
        }
        await persist(permit, current, attempt)
        const receipt = Command.SkipReceipt.parse({ schemaVersion: 1, permit: proof, receivedAt: Date.now() })
        await Storage.write(current.skipKey, receipt)
        return Command.Result.parse({ ...result(current, attempt), skip: receipt })
      },
      {
        commitGuard() {
          assertActive()
          if (expired(proof)) throw failure("REVISION_CONFLICT", "Command skip permit expired before commit")
        },
      },
    )
  }

  return {
    input,
    skip,
    async query(value: Command.SignedPermit): Promise<Command.QueryResult> {
      assertStandalone()
      const authorization = parse(Command.SignedPermit, value)
      const { permit, signature } = authorization
      assertAuthority(permit)
      if (permit.connectionEpoch > connectionEpoch || !(await Command.verify(permit, signature, authority.publicKey)))
        throw failure("PERMISSION_DENIED", "Command query authorization is invalid")
      return Storage.snapshot(async () => {
        assertActive()
        const current = await records(permit)
        if (!current.matches) throw failure("REVISION_CONFLICT", "Logical command payload changed")
        const original = current.attempt
          ? current
          : current.request?.accepted
            ? await records(current.request.accepted.permit)
            : undefined
        if (original && !original.attempt) throw failure("PROTOCOL_MISMATCH", "Accepted effect has no retained attempt")
        assertActive()
        return Command.QueryResult.parse({
          authorization,
          result: original ? result(original, original.attempt!) : undefined,
        })
      })
    },
    async accepted(input: z.infer<typeof Lookup>) {
      const lookup = Lookup.parse(input)
      const current = await read(Request, Keys.request(authority.orgID, lookup.subjectID, lookup.requestID))
      if (
        current &&
        (current.identity.orgID !== authority.orgID ||
          current.identity.subjectID !== lookup.subjectID ||
          current.identity.requestID !== lookup.requestID)
      )
        throw failure("PROTOCOL_MISMATCH", "Command receipt identity does not match its key")
      return current?.accepted
    },
  }
}
