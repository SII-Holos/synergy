import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationCommandProtocol as Command,
  OrganizationIdentity as Identity,
  OrganizationExecutionProtocol as Execution,
  OrganizationHandoffProtocol as Handoff,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionResume } from "@ericsanchezok/synergy-harness/session/resume"
import { SessionTransfer, SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { prepareSessionMigrations } from "@ericsanchezok/synergy-harness/migration"
import { RolloutQuery } from "@ericsanchezok/synergy-harness/rollout"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { OrganizationRuntimeError } from "./error"
import { OrganizationIntakePath as Keys } from "./storage/path"
import { OrganizationLocalProjects } from "./local-project"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { boundSessionSource } from "./session-source"
import { OrganizationCommandRecords as IntakeRecords } from "./command-records"

const { Request, State, Slot, Counter, Lookup, ControlState, Release, identity } = IntakeRecords
export async function readCommandControlVersion(orgID: string, sessionID: string) {
  return (await read(ControlState, Keys.control(orgID, sessionID)))?.controlVersion ?? 0
}
type Release = z.infer<typeof Release>

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
function expired(window: { authorizedAt: number; deadline: number }) {
  const now = Date.now()
  return now < window.authorizedAt || now >= window.deadline
}
class PermitExpired extends Error {}
class AdmissionChanged extends Error {}

export function createCommandIntake(options: {
  identity: Command.SigningIdentity
  runtimeID: string
  accountID?: string
  connectionEpoch: number
  signal: AbortSignal
}) {
  const authority = Command.SigningIdentity.parse(options.identity)
  const runtimeID = Identity.ID.parse(options.runtimeID)
  const accountID = options.accountID === undefined ? undefined : Identity.ID.parse(options.accountID)
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
  function readSession(sessionID: string) {
    return Session.get(sessionID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }
  async function binding(permit: Command.Permit): Promise<Command.Rejection | undefined> {
    const session = await readSession(permit.sessionID)
    if (!session) return permit.operation === "create" ? undefined : "SESSION_UNAVAILABLE"
    const current = session.organization
    if (
      !current ||
      current.orgID !== permit.orgID ||
      current.projectID !== permit.projectID ||
      current.driverRuntimeID !== permit.runtimeID ||
      current.bindingEpoch !== permit.bindingEpoch
    )
      return "STALE_BINDING"
    if (permit.operation === "create" && current.creatorID !== permit.actor.subjectID) return "STALE_BINDING"
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
      accepted?.effect.kind === "inbox" &&
      accepted.effect.mode === "task" &&
      accepted.permit.provisionalGrantID &&
      !current.request?.accepted
    ) {
      const original = accepted.permit
      await Storage.write(
        Keys.release(original.orgID, original.actor.subjectID, original.requestID),
        Release.parse({
          schemaVersion: 1,
          orgID: original.orgID,
          subjectID: original.actor.subjectID,
          requestID: original.requestID,
          sessionID: original.sessionID,
          projectID: original.projectID,
          runtimeID: original.runtimeID,
          bindingEpoch: original.bindingEpoch,
          rootID: accepted.effect.messageID,
          grantID: original.provisionalGrantID,
          actor: original.actor,
          admissionID: original.admissionID,
          attemptID: original.attemptID,
          acceptedAt: accepted.acceptedAt,
          state: "pending",
        }),
      )
    }
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
  async function releaseEntries() {
    assertStandalone()
    return Storage.snapshot(async () => {
      const result: Release[] = []
      let after: string | undefined
      do {
        const page = await Storage.childKeys({ prefix: Keys.releases(authority.orgID), after, limit: 128 })
        const values = await Storage.readMany<unknown>(page.keys)
        for (const [index, value] of values.entries()) {
          if (value === undefined) continue
          const release = parse(Release, value)
          if (
            release.orgID !== authority.orgID ||
            JSON.stringify(Keys.release(authority.orgID, release.subjectID, release.requestID)) !==
              JSON.stringify(page.keys[index])
          )
            throw failure("PROTOCOL_MISMATCH", "Execution release index identity is invalid")
          if (release.state !== "pending" || release.runtimeID !== runtimeID) continue
          const state = await read(State, Keys.state(authority.orgID, release.sessionID))
          if (state && (state.runtimeID !== runtimeID || state.bindingEpoch !== release.bindingEpoch)) continue
          result.push(release)
        }
        after = page.after
      } while (after)
      return result
    })
  }
  async function markRelease(entry: Release, receipt?: Execution.ReleaseReceipt) {
    assertStandalone()
    return Storage.transaction(async () => {
      const current = await read(Release, Keys.release(authority.orgID, entry.subjectID, entry.requestID))
      if (!current || JSON.stringify(current) !== JSON.stringify(entry))
        throw failure("REVISION_CONFLICT", "Execution release index changed before settlement")
      if (current.state === "released") return current
      return Storage.write(
        Keys.release(authority.orgID, entry.subjectID, entry.requestID),
        Release.parse({ ...current, state: "released", receipt, reconciledAt: Date.now() }),
      )
    })
  }
  function result(current: Records, attempt: Command.Attempt, accepted?: Command.Accepted): Command.Result {
    return Command.Result.parse({
      attempt,
      accepted: accepted ?? (current.matches ? current.request?.accepted : undefined),
      skip: current.skip,
    })
  }

  async function verify(authorization: Command.SignedPermit, digest: () => Promise<string>) {
    assertStandalone()
    const { permit, signature } = authorization
    assertAuthority(permit)
    if (!(await Command.verify(permit, signature, authority.publicKey)))
      throw failure("PERMISSION_DENIED", "Command signature is invalid")
    return (await digest()) === permit.payloadHash
  }
  async function reconcileDecision(accepted: Command.Accepted) {
    const effect = accepted.effect
    if (effect.kind !== "decision" || effect.decision.status === "expired") return
    const winner = effect.decision.winner
    await Storage.transaction(
      async () => {
        assertActive()
        if ((await binding(accepted.permit)) || (await SessionTransfer.isFrozen(accepted.permit.sessionID))) return
        const root = await Session.get(accepted.permit.sessionID)
        const source = await boundSessionSource(root, effect.sourceSessionID)
        await ScopeContext.provide({
          scope: source.scope,
          workspace: null,
          fn: async () => {
            const receipt = await (winner.outcome.kind === "permission"
              ? PermissionNext.reconcile({ sessionID: source.id, requestID: effect.requestID })
              : Question.reconcile({ sessionID: source.id, requestID: effect.requestID }))
            if (!receipt || JSON.stringify(decisionWinner(receipt)) !== JSON.stringify(winner))
              throw failure("PROTOCOL_MISMATCH", "Committed decision has no matching native winner")
          },
        })
      },
      { commitGuard: assertActive },
    )
  }
  function decisionWinner(receipt: NonNullable<Awaited<ReturnType<typeof PermissionNext.reconcile>>>) {
    return Command.DecisionWinner.parse({
      sessionID: receipt.sessionID,
      requestID: receipt.requestID,
      actor: receipt.actor,
      decidedAt: receipt.decidedAt,
      outcome:
        receipt.outcome.kind === "permission" ? receipt.outcome : { kind: "question", reply: receipt.outcome.reply },
    })
  }
  async function controlVersion(permit: Command.Permit) {
    return readCommandControlVersion(permit.orgID, permit.sessionID)
  }
  async function advanceControl(permit: Command.Permit) {
    const next = Command.ControlVersion.parse((await controlVersion(permit)) + 1)
    await Storage.write(Keys.control(permit.orgID, permit.sessionID), { schemaVersion: 1, controlVersion: next })
    return next
  }
  async function execution(accepted: Command.Accepted): Promise<Command.ExecutionObservation | undefined> {
    if (accepted.effect.kind !== "control" || accepted.effect.operation !== "cancel") return
    const { runID } = accepted.effect
    const { permit } = accepted
    function unavailable(reason: Extract<Command.ExecutionObservation, { state: "unavailable" }>["reason"]) {
      return { state: "unavailable" as const, runID, reason }
    }
    async function checkpoint() {
      return Storage.snapshot(async () => {
        assertActive()
        if (await binding(permit)) return unavailable("binding_changed")
        if (await SessionTransfer.isFrozen(permit.sessionID)) return unavailable("transfer_in_progress")
        return controlVersion(permit)
      })
    }
    try {
      const before = await checkpoint()
      if (typeof before !== "number") return before
      const activity = await RolloutQuery.activity(permit.sessionID, runID, signal)
      const after = await checkpoint()
      if (typeof after !== "number") return after
      if (before !== after || after < accepted.effect.controlVersion) return unavailable("state_changed")
      if (!activity) return unavailable("run_unavailable")
      if (activity.observedAt < accepted.acceptedAt) return unavailable("state_changed")
      return Command.ExecutionObservation.parse({ state: "observed", runID, controlVersion: after, activity })
    } catch {
      assertActive()
      return unavailable("query_failed")
    }
  }
  async function inspect(permit: Command.Permit, payloadMatches: boolean, control?: Command.Control) {
    assertActive()
    const current = await records(permit)
    if (current.attempt) {
      if (!payloadMatches) throw failure("REVISION_CONFLICT", "Command payload does not match its retained attempt")
      return { current }
    }
    const bindingReason = await binding(permit)
    let reason: Command.Rejection | undefined
    if (!current.matches) reason = "REQUEST_CONFLICT"
    else if (permit.operation === "create" && accountID !== undefined && permit.actor.subjectID !== accountID)
      reason = "REQUEST_CONFLICT"
    else if (!payloadMatches) reason = "PAYLOAD_MISMATCH"
    else if (permit.connectionEpoch !== connectionEpoch) reason = "STALE_CONNECTION"
    else if (expired(permit)) reason = "EXPIRED_PERMIT"
    else if (bindingReason) reason = bindingReason
    else if (!stateMatches(permit, current.state)) reason = "STALE_BINDING"
    if (!reason) {
      if (permit.commandSeq <= current.state.commandSeq || current.slot) reason = "SEQUENCE_CLOSED"
      else if (permit.commandSeq !== current.state.commandSeq + 1) reason = "SEQUENCE_GAP"
      else if (await SessionTransfer.isFrozen(permit.sessionID)) reason = "TRANSFER_BLOCKED"
      else if (permit.operation === "create") {
        if ((await readSession(permit.sessionID)) && !current.request?.accepted) reason = "SESSION_UNAVAILABLE"
      } else {
        const session = await Session.get(permit.sessionID)
        if (
          session.time.archived ||
          (control && control.operation !== "cancel" && !SessionLifecycle.latchable(session))
        )
          reason = "SESSION_UNAVAILABLE"
        else if (
          control?.operation === "continue" &&
          !current.request?.accepted &&
          (session.paused?.since !== control.pausedSince || (await controlVersion(permit)) !== control.controlVersion)
        )
          reason = "CONTROL_CONFLICT"
        else if (
          control?.operation === "cancel" &&
          !current.request?.accepted &&
          (await controlVersion(permit)) !== control.controlVersion
        )
          reason = "CONTROL_CONFLICT"
      }
    }
    return { current, reason, bindingReason }
  }
  type Inspection = Awaited<ReturnType<typeof inspect>>

  async function settle(
    permit: Command.Permit,
    checked: Inspection,
    effect?: Command.Accepted["effect"],
  ): Promise<Command.Result> {
    const { current, reason, bindingReason } = checked
    if (current.attempt) return result(current, current.attempt)
    if (reason) {
      const attempt: Command.Attempt = { schemaVersion: 1, permit, receivedAt: Date.now(), status: "rejected", reason }
      await persist(permit, current, attempt, undefined, !bindingReason)
      return result(current, attempt)
    }
    let accepted = current.request?.accepted
    if (!accepted) {
      if (!effect) throw new Error("Command acceptance requires a native effect")
      const counterKey = Keys.intake(permit.orgID, permit.runtimeID)
      const counter = await read(Counter, counterKey)
      const intakeSeq = OrganizationProtocol.Epoch.parse((counter?.intakeSeq ?? 0) + 1)
      const acceptedAt = Date.now()
      if (acceptedAt < permit.authorizedAt || acceptedAt >= permit.deadline) throw new PermitExpired()
      accepted = Command.Accepted.parse({ schemaVersion: 1, permit, acceptedAt, intakeSeq, effect })
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
  }

  async function receive(
    authorization: Command.SignedPermit,
    digest: () => Promise<string>,
    effect: () => Promise<Command.Accepted["effect"]>,
    prepare?: () => Promise<void>,
  ): Promise<Command.Result> {
    const payloadMatches = await verify(authorization, digest)
    const { permit } = authorization
    if (prepare) {
      const retained = await Storage.transaction(
        async () => {
          const checked = await inspect(permit, payloadMatches)
          if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
            return settle(permit, checked)
        },
        { commitGuard: assertActive },
      )
      if (retained) return retained
      await prepare()
    }
    const commit = () => {
      let accepting = false
      return Storage.transaction(
        async () => {
          const checked = await inspect(permit, payloadMatches)
          if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
            return settle(permit, checked)
          accepting = true
          return settle(permit, checked, await effect())
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
      return await commit()
    } catch (error) {
      if (!(error instanceof PermitExpired)) throw error
      return commit()
    }
  }

  async function control(
    value: Command.ControlDelivery,
    received?: (result: Command.ControlResult) => void,
  ): Promise<Command.ControlResult> {
    const delivery = parse(Command.ControlDelivery, value)
    const { permit } = delivery.authorization
    const payloadMatches = await verify(delivery.authorization, () =>
      Command.digestControl(Command.controlRequest(permit, delivery.control)),
    )
    const finish = (fallback?: Command.Rejection) =>
      Storage.transaction(
        async () => {
          const checked = await inspect(permit, payloadMatches, delivery.control)
          if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
            return settle(permit, checked)
          if (fallback) return settle(permit, { ...checked, reason: fallback })
        },
        { commitGuard: assertActive },
      )
    const previous = await finish()
    if (previous) return Command.ControlResult.parse(previous)
    const session = await readSession(permit.sessionID)
    if (!session) return Command.ControlResult.parse(await finish("SESSION_UNAVAILABLE"))
    return ScopeContext.provide({ scope: session.scope, workspace: session.workspace, fn: apply })
    async function apply(): Promise<Command.ControlResult> {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new PermitExpired()), Math.max(0, permit.deadline - Date.now()))
      const pending = AbortSignal.any([signal, timeout.signal])
      try {
        if (delivery.control.operation === "pause") {
          using lock = await Lock.writeWithSignal(`session-control:${permit.sessionID}`, pending)
          pending.throwIfAborted()
          let accepting = false
          return Command.ControlResult.parse(
            await Storage.transaction(
              async () => {
                const checked = await inspect(permit, payloadMatches, delivery.control)
                if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
                  return settle(permit, checked)
                accepting = true
                const changed = await SessionLifecycle.pause({ sessionID: permit.sessionID, reason: "aborted" })
                const paused = (await Session.get(permit.sessionID)).paused
                if (!paused) throw new AdmissionChanged()
                return settle(permit, checked, {
                  kind: "control",
                  operation: "pause",
                  changed,
                  pausedSince: paused.since,
                  controlVersion: await advanceControl(permit),
                })
              },
              {
                commitGuard() {
                  assertActive()
                  if (accepting && expired(permit)) throw new PermitExpired()
                },
              },
            ),
          )
        }
        let checked: Inspection | undefined
        let accepted: Command.Result | undefined
        if (delivery.control.operation === "cancel") {
          using lock = await Lock.writeWithSignal(`session-control:${permit.sessionID}`, pending)
          pending.throwIfAborted()
          await RolloutLifecycle.cancel(permit.sessionID, delivery.control.runID, {
            signal: pending,
            async validate() {
              checked = await inspect(permit, payloadMatches, delivery.control)
              if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
                throw new AdmissionChanged()
            },
            commitGuard() {
              assertActive()
              if (expired(permit)) throw new PermitExpired()
            },
            async record(run) {
              if (!checked) throw new Error("Native cancellation has no command admission")
              accepted = await settle(permit, checked, {
                kind: "control",
                operation: "cancel",
                controlVersion: await advanceControl(permit),
                runID: run.id,
                runStatusAtReception: run.status,
                cancelRequestedAt: run.cancelRequestedAt,
              })
              const receipt = Command.ControlResult.parse(accepted)
              Storage.afterCommit(() => received?.(receipt))
            },
          })
          return Command.ControlResult.parse(accepted)
        }
        const requestID =
          "organization:" +
          createHash("sha256")
            .update(JSON.stringify([permit.orgID, permit.actor.subjectID, permit.requestID]))
            .digest("hex")
        await SessionResume.request(
          { sessionID: permit.sessionID, requestID, pausedSince: delivery.control.pausedSince },
          {
            actor: permit.actor,
            signal: pending,
            async validate() {
              checked = await inspect(permit, payloadMatches, delivery.control)
              if (checked.current.attempt || checked.reason || checked.current.request?.accepted)
                throw new AdmissionChanged()
            },
            commitGuard() {
              assertActive()
              if (expired(permit)) throw new PermitExpired()
            },
            async record(receipt) {
              if (!checked || receipt.pausedSince === undefined)
                throw new Error("Native continuation has no command admission")
              accepted = await settle(permit, checked, {
                kind: "control",
                operation: "continue",
                controlVersion: await advanceControl(permit),
                pausedSince: receipt.pausedSince,
                itemID: receipt.itemID,
                messageID: receipt.messageID,
                rootID: receipt.rootID,
              })
            },
          },
        )
        return Command.ControlResult.parse(accepted ?? (await finish("CONTROL_CONFLICT")))
      } catch (error) {
        assertActive()
        if (error instanceof PermitExpired) return Command.ControlResult.parse(await finish("EXPIRED_PERMIT"))
        if (error instanceof AdmissionChanged) return Command.ControlResult.parse(await finish("CONTROL_CONFLICT"))
        if (error instanceof RolloutLifecycle.RunNotFoundError)
          return Command.ControlResult.parse(await finish("CONTROL_CONFLICT"))
        throw error
      } finally {
        clearTimeout(timer)
      }
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

  async function continuation(session: Session.Info, accepted: Command.InputAccepted) {
    const resume = session.resume
    if (!resume?.actor || resume.rootID !== accepted.effect.messageID) return
    const owner = await Epochs.inspectOwnerBinding({ sessionID: session.id, rootSessionID: session.id })
    if (!owner) return
    const request = await read(Request, Keys.request(authority.orgID, resume.actor.subjectID, resume.actor.requestID))
    const control = request?.accepted
    if (
      !control ||
      control.effect.kind !== "control" ||
      control.effect.operation !== "continue" ||
      control.effect.rootID !== accepted.effect.messageID ||
      control.effect.itemID !== resume.itemID ||
      control.effect.messageID !== resume.messageID ||
      control.effect.pausedSince !== resume.pausedSince ||
      JSON.stringify(control.permit.actor) !== JSON.stringify(resume.actor)
    )
      throw failure("PERMISSION_DENIED", "Execution continuation requires its canonical native control receipt")
    assertAuthority(control.permit)
    if (control.permit.connectionEpoch > connectionEpoch || (await binding(control.permit)))
      throw failure("STALE_BINDING", "Execution continuation belongs to another Runtime binding")
    const current = await records(control.permit)
    if (
      !current.matches ||
      current.attempt?.status !== "accepted" ||
      !stateMatches(control.permit, current.state) ||
      current.slot?.attemptID !== control.permit.attemptID
    )
      throw failure("PROTOCOL_MISMATCH", "Execution continuation has no matching native attempt")
    return Execution.Continuation.parse({ handoffID: owner.handoffID, receipt: result(current, current.attempt) })
  }
  async function taskReceipt(lookup: z.infer<typeof Lookup>, access: "execution" | "retention") {
    assertActive()
    const request = await read(Request, Keys.request(authority.orgID, lookup.subjectID, lookup.requestID))
    const accepted = request?.accepted
    if (
      !accepted ||
      accepted.permit.actor.subjectID !== lookup.subjectID ||
      accepted.permit.requestID !== lookup.requestID
    )
      throw failure("NOT_FOUND", "Accepted task receipt not found")
    const permit = accepted.permit
    if (!permit.provisionalGrantID || accepted.effect.kind !== "inbox" || accepted.effect.mode !== "task")
      throw failure("PERMISSION_DENIED", "Execution binding requires the accepted task root")
    if (access === "execution" && (await SessionTransfer.isFrozen(permit.sessionID)))
      throw failure("HANDOFF_BLOCKED", "Session transfer blocks root binding")
    const session = await Session.get(permit.sessionID)
    const continued = await continuation(session, Command.InputAccepted.parse(accepted))
    if (!continued) {
      assertAuthority(permit)
      if (permit.connectionEpoch > connectionEpoch || (await binding(permit)))
        throw failure("STALE_BINDING", "Execution binding Session changed")
    }
    if (access === "execution" && session.time.archived)
      throw failure("PERMISSION_DENIED", "Archived Session cannot bind execution")
    const current = await records(permit)
    if (!current.matches || current.attempt?.status !== "accepted")
      throw failure("PROTOCOL_MISMATCH", "Accepted task has no matching native attempt")
    assertActive()
    return {
      current,
      attempt: current.attempt,
      permit,
      session,
      continuation: continued,
      messageID: accepted.effect.messageID,
    }
  }
  async function resourceProof(value: z.infer<typeof Lookup>, access: "execution" | "retention") {
    assertStandalone()
    const lookup = Lookup.parse(value)
    return Storage.snapshot(async () => {
      const { current, attempt, continuation } = await taskReceipt(lookup, access)
      const issuedAt = Date.now()
      return Execution.DescriptionProof.parse({
        schemaVersion: 1,
        purpose: "execution-resource-description",
        orgID: authority.orgID,
        deploymentIncarnation: authority.deploymentIncarnation,
        runtimeID,
        connectionEpoch,
        receipt: result(current, attempt),
        continuation,
        issuedAt,
        expiresAt: issuedAt + 30_000,
      })
    })
  }
  async function handoffCloseProof(input: {
    authorization: Handoff.SignedMachinePlan
    item: z.infer<typeof Execution.HandoffInventoryItem>
  }): Promise<Execution.HandoffCloseProof> {
    assertStandalone()
    const { plan, signature } = Handoff.SignedMachinePlan.parse(input.authorization)
    const item = Execution.HandoffInventoryItem.parse(input.item)
    if (
      plan.operation !== "surrender-source" ||
      plan.orgID !== authority.orgID ||
      plan.deploymentIncarnation !== authority.deploymentIncarnation ||
      plan.keyID !== authority.keyID ||
      plan.sourceRuntimeID !== runtimeID ||
      plan.runtimeID !== runtimeID ||
      plan.connectionEpoch !== connectionEpoch ||
      plan.issuedAt > Date.now() ||
      plan.expiresAt <= Date.now() ||
      !plan.preparedHash ||
      !(await Handoff.verifyMachinePlan(plan, signature, authority.publicKey)) ||
      !plan.authorization ||
      !(await Handoff.verifyPermit(plan.authorization.permit, plan.authorization.signature, authority.publicKey))
    )
      throw failure("HANDOFF_BLOCKED", "Resource closure requires the exact current source surrender authority")
    return Storage.snapshot(async () => {
      const frozen = await Epochs.assertFrozen(plan.sessionID, plan.handoffID)
      if (
        frozen.sourceID !== runtimeID ||
        frozen.targetID !== plan.targetRuntimeID ||
        frozen.fromEpoch !== plan.fromEpoch ||
        frozen.toEpoch !== plan.toEpoch ||
        frozen.scopeID !== plan.sourceBinding.projectID ||
        frozen.rootSessionID !== undefined
      )
        throw failure("HANDOFF_BLOCKED", "Resource closure belongs to another frozen source tuple")
      const session = await Session.get(plan.sessionID)
      if (
        JSON.stringify(session.organization) !== JSON.stringify(plan.sourceBinding) ||
        (await Epochs.inspect(frozen)).manifestHash !== plan.manifestHash
      )
        throw failure("HANDOFF_BLOCKED", "Resource closure does not match the canonical frozen Session")
      const request = await read(Request, Keys.request(authority.orgID, item.lookup.subjectID, item.lookup.requestID))
      const accepted = Command.InputAccepted.parse(request?.accepted)
      const permit = accepted.permit
      const current = await records(permit)
      if (
        permit.orgID !== plan.orgID ||
        permit.deploymentIncarnation !== plan.deploymentIncarnation ||
        permit.sessionID !== plan.sessionID ||
        permit.projectID !== plan.sourceBinding.projectID ||
        permit.commandSeq > plan.commandSeq ||
        permit.actor.subjectID !== item.lookup.subjectID ||
        permit.requestID !== item.lookup.requestID ||
        permit.provisionalGrantID !== item.originGrantID ||
        accepted.effect.mode !== "task" ||
        accepted.effect.messageID !== item.rootID ||
        !current.matches ||
        current.attempt?.status !== "accepted" ||
        current.slot?.attemptID !== permit.attemptID
      )
        throw failure("PROTOCOL_MISMATCH", "Retained grant does not match its canonical original root reception")
      let continuation: Execution.Continuation | undefined
      if (item.continuation) {
        const lookup = item.continuation.lookup
        const controlRequest = await read(Request, Keys.request(authority.orgID, lookup.subjectID, lookup.requestID))
        const control = Command.ControlAccepted.parse(controlRequest?.accepted)
        assertAuthority(control.permit)
        const controlRecords = await records(control.permit)
        if (
          control.effect.operation !== "continue" ||
          control.effect.rootID !== item.rootID ||
          control.permit.sessionID !== plan.sessionID ||
          control.permit.projectID !== plan.sourceBinding.projectID ||
          control.permit.bindingEpoch !== plan.fromEpoch ||
          control.permit.commandSeq > plan.commandSeq ||
          control.permit.actor.subjectID !== lookup.subjectID ||
          control.permit.requestID !== lookup.requestID ||
          control.permit.connectionEpoch > connectionEpoch ||
          !controlRecords.matches ||
          controlRecords.attempt?.status !== "accepted" ||
          controlRecords.slot?.attemptID !== control.permit.attemptID ||
          !stateMatches(control.permit, controlRecords.state) ||
          item.grantID === item.originGrantID
        )
          throw failure("PROTOCOL_MISMATCH", "Retained successor lacks its exact native independent control")
        continuation = Execution.Continuation.parse({
          handoffID: item.continuation.handoffID,
          receipt: result(controlRecords, controlRecords.attempt),
        })
      } else if (
        permit.runtimeID !== runtimeID ||
        permit.bindingEpoch !== plan.fromEpoch ||
        item.grantID !== item.originGrantID
      )
        throw failure("PROTOCOL_MISMATCH", "Original grant belongs to another source binding")
      if (item.generation > 0) {
        const message = await MessageV2.readInfo({
          scopeID: session.scope.id,
          sessionID: session.id,
          messageID: item.rootID,
        })
        const run = await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.rootID)
        if (
          message.role !== "user" ||
          !message.isRoot ||
          message.rootID !== item.rootID ||
          JSON.stringify(message.actor) !== JSON.stringify(permit.actor) ||
          run?.id !== item.rootID ||
          run.owner.kind !== "session" ||
          run.owner.sessionID !== session.id ||
          run.owner.scopeID !== session.scope.id
        )
          throw failure("PROTOCOL_MISMATCH", "Retained bound generation lacks its original native root and Run")
      }
      await Epochs.assertFrozen(plan.sessionID, plan.handoffID)
      assertActive()
      if (plan.expiresAt <= Date.now()) throw failure("HANDOFF_BLOCKED", "Source surrender authority expired")
      const issuedAt = Date.now()
      return Execution.HandoffCloseProof.parse({
        ...Handoff.Binding.parse(
          Object.fromEntries(
            Object.keys(Handoff.Binding.shape).map((key) => [key, plan[key as keyof Handoff.MachinePlan]]),
          ),
        ),
        purpose: "execution-handoff-close",
        runtimeID,
        connectionEpoch,
        grantID: item.grantID,
        rootID: item.rootID,
        generation: item.generation,
        manifestHash: plan.manifestHash,
        preparedHash: plan.preparedHash,
        receipt: result(current, current.attempt),
        continuation,
        issuedAt,
        expiresAt: Math.min(issuedAt + 30_000, plan.expiresAt),
      })
    })
  }
  return {
    control,
    handoffCloseProof,
    retentionProof(value: z.infer<typeof Lookup>): Promise<Execution.DescriptionProof> {
      return resourceProof(value, "retention")
    },
    descriptionProof(value: z.infer<typeof Lookup>): Promise<Execution.DescriptionProof> {
      return resourceProof(value, "execution")
    },
    async bindingProof(value: z.infer<typeof Lookup>, root: string): Promise<Execution.BindingProof> {
      assertStandalone()
      const lookup = Lookup.parse(value)
      const rootID = Identity.ID.parse(root)
      const prior = await read(Request, Keys.request(authority.orgID, lookup.subjectID, lookup.requestID))
      if (!prior?.accepted) throw failure("NOT_FOUND", "Accepted task receipt not found")
      const initial = await Session.get(prior.accepted.permit.sessionID)
      await prepareSessionMigrations({ scopeID: initial.scope.id, sessionID: initial.id })
      return Storage.snapshot(async () => {
        assertActive()
        const { current, attempt, permit, session, messageID, continuation } = await taskReceipt(lookup, "execution")
        if (messageID !== rootID)
          throw failure("PERMISSION_DENIED", "Execution binding requires the accepted task root")
        const [message, run] = await Promise.all([
          MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: rootID }).catch((error) => {
            if (error instanceof Storage.NotFoundError) return
            throw error
          }),
          RolloutLedger.getRun(RolloutLifecycle.owner(session), rootID).catch((error) => {
            if (error instanceof Storage.NotFoundError) return
            throw error
          }),
        ])
        const actor = Command.Actor.safeParse(message?.actor)
        if (
          !message ||
          message.role !== "user" ||
          !message.isRoot ||
          message.id !== rootID ||
          message.sessionID !== session.id ||
          message.rootID !== rootID ||
          !actor.success ||
          JSON.stringify(actor.data) !== JSON.stringify(permit.actor) ||
          !run ||
          run.id !== rootID ||
          run.owner.kind !== "session" ||
          run.owner.sessionID !== session.id ||
          run.owner.scopeID !== session.scope.id ||
          run.status === "cancelled" ||
          run.status === "failed" ||
          run.cancelRequestedAt ||
          run.recording === "failed"
        )
          throw failure("RESOURCE_UNAVAILABLE", "Accepted task has no available materialized root")
        assertActive()
        const issuedAt = Date.now()
        return Execution.BindingProof.parse({
          schemaVersion: 1,
          purpose: "execution-root-binding",
          orgID: authority.orgID,
          deploymentIncarnation: authority.deploymentIncarnation,
          runtimeID,
          connectionEpoch,
          rootID,
          receipt: result(current, attempt),
          continuation,
          issuedAt,
          expiresAt: issuedAt + 30_000,
        })
      })
    },
    async input(value: Command.InputDelivery): Promise<Command.InputResult> {
      const delivery = parse(Command.InputDelivery, value)
      const { permit } = delivery.authorization
      return Command.InputResult.parse(
        await receive(
          delivery.authorization,
          () => Command.digestInput(Command.inputRequest(permit, delivery.input)),
          async () => {
            // The receipt transaction owns uniqueness; taking the Inbox delivery lock here would invert lock order.
            const effect = await SessionInbox.deliver({
              sessionID: permit.sessionID,
              deliveryKey: `organization:${permit.orgID}:${permit.actor.subjectID}:${permit.requestID}`,
              mode: delivery.input.mode,
              message: { role: "user", actor: permit.actor, origin: { type: "user" }, parts: delivery.input.parts },
            })
            if (delivery.input.mode !== "context")
              Storage.afterCommit(() => SessionManager.scheduleWake(permit.sessionID, "organization-input"))
            return { kind: "inbox", itemID: effect.itemID, messageID: effect.messageID, mode: delivery.input.mode }
          },
        ),
      )
    },
    async decision(value: Command.DecisionDelivery): Promise<Command.DecisionResult> {
      const delivery = parse(Command.DecisionDelivery, value)
      const { permit } = delivery.authorization
      const result = await receive(
        delivery.authorization,
        () => Command.digestDecision(Command.decisionRequest(permit, delivery.decision)),
        async () => {
          const root = await Session.get(permit.sessionID)
          const source = await boundSessionSource(root, delivery.decision.sourceSessionID)
          const decision = await ScopeContext.provide({
            scope: source.scope,
            workspace: null,
            fn: () =>
              delivery.decision.kind === "permission"
                ? PermissionNext.decide({
                    sessionID: source.id,
                    requestID: delivery.decision.requestID,
                    reply: delivery.decision.reply,
                    message: delivery.decision.message,
                    actor: permit.actor,
                  })
                : Question.decide({
                    sessionID: source.id,
                    requestID: delivery.decision.requestID,
                    reply: delivery.decision.reply,
                    answers: delivery.decision.answers,
                    actor: permit.actor,
                  }),
          })
          const resolution =
            decision.status === "expired"
              ? { status: "expired" as const }
              : {
                  status: decision.status,
                  winner: decisionWinner(decision.receipt),
                }
          return {
            kind: "decision",
            sourceSessionID: source.id,
            requestID: delivery.decision.requestID,
            decision: resolution,
          }
        },
      )
      if (result.accepted) await reconcileDecision(result.accepted)
      return Command.DecisionResult.parse(result)
    },
    async create(value: Command.CreateDelivery): Promise<Command.CreatedResult> {
      const delivery = parse(Command.CreateDelivery, value)
      const { permit } = delivery.authorization
      let prepared: OrganizationLocalProjects.Creation
      return Command.CreatedResult.parse(
        await receive(
          delivery.authorization,
          () => Command.digestCreate(Command.createRequest(permit, delivery.creation)),
          async () => {
            const now = Date.now()
            const scope = await Scope.registerProject({
              type: "project",
              id: permit.projectID,
              local: null,
              time: { created: now, updated: now },
            })
            await OrganizationLocalProjects.assertCreation(scope, prepared)
            const created = await ScopeContext.provide({
              scope,
              workspace: prepared.workspace,
              fn: () =>
                Session.create({
                  id: permit.sessionID,
                  scope,
                  title: delivery.creation.title,
                  workspaceID: prepared.workspaceID,
                  environmentID: prepared.environmentID,
                  environmentSelection: prepared.environmentSelection,
                  organization: {
                    schemaVersion: 1,
                    orgID: permit.orgID,
                    projectID: permit.projectID,
                    creatorID: permit.actor.subjectID,
                    driverRuntimeID: runtimeID,
                    bindingEpoch: permit.bindingEpoch,
                  },
                }),
            })
            return { kind: "session", sessionID: created.id }
          },
          async () => {
            prepared = await OrganizationLocalProjects.prepareCreation(permit.projectID)
          },
        ),
      )
    },
    skip,
    async query(value: Command.SignedPermit): Promise<Command.QueryResult> {
      assertStandalone()
      const authorization = parse(Command.SignedPermit, value)
      const { permit, signature } = authorization
      assertAuthority(permit)
      if (permit.connectionEpoch > connectionEpoch || !(await Command.verify(permit, signature, authority.publicKey)))
        throw failure("PERMISSION_DENIED", "Command query authorization is invalid")
      const receipt = await Storage.snapshot(async () => {
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
      if (receipt.result?.accepted) await reconcileDecision(receipt.result.accepted)
      return Command.QueryResult.parse({
        ...receipt,
        ...(receipt.result?.accepted ? { execution: await execution(receipt.result.accepted) } : {}),
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
    releaseEntries,
    markRelease,
    async barrier(sessionID: string, bindingEpoch: number, commandSeq: number) {
      sessionID = Identity.ID.parse(sessionID)
      bindingEpoch = OrganizationProtocol.Epoch.parse(bindingEpoch)
      commandSeq = Identity.Revision.parse(commandSeq)
      return Storage.snapshot(async () => {
        const info = await Session.get(sessionID)
        const binding = info.organization
        if (
          !binding ||
          binding.orgID !== authority.orgID ||
          binding.driverRuntimeID !== runtimeID ||
          binding.bindingEpoch !== bindingEpoch
        )
          throw failure("STALE_BINDING", "Handoff barrier belongs to another execution binding")
        const state = await read(State, Keys.state(authority.orgID, sessionID))
        if (
          state &&
          (state.orgID !== authority.orgID ||
            state.sessionID !== sessionID ||
            state.projectID !== binding.projectID ||
            state.runtimeID !== runtimeID ||
            state.bindingEpoch !== bindingEpoch)
        )
          throw failure("STALE_BINDING", "Handoff command checkpoint belongs to another execution binding")
        if ((state?.commandSeq ?? 0) !== commandSeq)
          throw failure("HANDOFF_BLOCKED", "Handoff must reconcile every authorized command slot before freezing")
        return commandSeq
      })
    },
  }
}
