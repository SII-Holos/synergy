import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
  OrganizationCloudExecutionProtocol as CloudEnvironment,
  OrganizationCloudCleanupProtocol as CloudCleanup,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderCatalogSource } from "@ericsanchezok/synergy-harness/provider/catalog-source"
import { ProviderRequestSource } from "@ericsanchezok/synergy-harness/provider/request-source"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { RuntimeIdentity } from "./home"
import type { MemberConnection } from "./connection"
import type { createCommandIntake } from "./command-intake"
import { OrganizationRuntimeError } from "./error"
import { OrganizationExecutionLeases as Leases } from "./execution-leases"
import { createMemberModelProvider, MemberModelContext } from "./model-provider"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { EnvironmentExecutionSource } from "@ericsanchezok/synergy-harness/environment/execution-source"
import { prepareInitialWorkspace } from "./initial-workspace"

interface Connection {
  connection: MemberConnection["connected"]
  resources: MemberConnection["resources"]
  intake: ReturnType<typeof createCommandIntake>
  origin: string
  ca?: string | string[]
  signal: AbortSignal
}

interface ExecutionLineage {
  sessionID: string
  rootID: string
  actor: { subjectID: string; requestID: string }
}

export interface MemberExecutionResolution {
  source: Connection
  session: Awaited<ReturnType<typeof Session.get>>
  lineage?: ExecutionLineage
  descriptionProof: Execution.DescriptionProof
  proof: Execution.BindingProof
  description: Execution.Description
  accepted: ExecutionLineage
}

const state = RuntimeContext.state(() => ({
  connection: undefined as Connection | undefined,
  identity: undefined as RuntimeIdentity | undefined,
}))
const models = ScopedState.create(() => new Map<string, Provider.Info>())

export function denied(message: string) {
  return new OrganizationRuntimeError({
    code: "PERMISSION_DENIED",
    message,
    outcome: "not_dispatched",
    retryable: false,
  })
}

export function attachMemberExecution(input: Connection) {
  input.signal.throwIfAborted()
  const current = state()
  if (current.connection) throw denied("Member execution already has a current connection")
  const resource = input.resources
  const tracked: Connection = {
    ...input,
    resources: {
      ...resource,
      async describe(value, signal) {
        const proof = Execution.DescriptionProof.parse(value)
        await input.intake.cleanupProof(Leases.reference(proof))
        const intent = await Leases.begin(proof)
        const result = await resource.describe(proof, signal)
        await Leases.confirm(intent, result.grant)
        return result
      },
      async bind(value, signal) {
        const proof = Execution.BindingProof.parse(value)
        await input.intake.cleanupProof(Leases.reference(proof))
        const intent = await Leases.begin(proof)
        const grant = await resource.bind(proof, signal)
        await Leases.confirm(intent, grant)
        return grant
      },
    },
  }
  current.connection = tracked
  input.signal.addEventListener(
    "abort",
    () => {
      if (current.connection === tracked) current.connection = undefined
    },
    { once: true },
  )
}

function current() {
  const value = state().connection
  if (!value) throw denied("Organization command admission is unavailable")
  value.signal.throwIfAborted()
  return value
}

export async function withMemberHandoffPlan<T>(
  value: Handoff.SignedMachinePlan,
  signal: AbortSignal,
  body: (plan: Readonly<Handoff.MachinePlan>, assert: () => void) => Promise<T>,
): Promise<T> {
  const authorization = Handoff.SignedMachinePlan.parse(value)
  const source = current()
  const owner = WorkspaceContent.captureOwner(signal)
  const connection = source.connection
  const signer = { ...connection.signingIdentity }
  const selected = {
    orgID: connection.orgID,
    deploymentIncarnation: connection.deploymentIncarnation,
    runtimeID: connection.runtimeID,
    connectionEpoch: connection.connectionEpoch,
  }
  const { plan } = authorization
  const assert = () => {
    owner()
    signal.throwIfAborted()
    source.signal.throwIfAborted()
    EnvironmentExecutionSource.assertRegisteredOwner("organization")
    if (
      current() !== source ||
      source.connection !== connection ||
      connection.signingIdentity.keyID !== signer.keyID ||
      connection.signingIdentity.publicKey !== signer.publicKey ||
      connection.orgID !== selected.orgID ||
      connection.deploymentIncarnation !== selected.deploymentIncarnation ||
      connection.runtimeID !== selected.runtimeID ||
      connection.connectionEpoch !== selected.connectionEpoch ||
      plan.orgID !== selected.orgID ||
      plan.deploymentIncarnation !== selected.deploymentIncarnation ||
      plan.runtimeID !== selected.runtimeID ||
      plan.connectionEpoch !== selected.connectionEpoch ||
      plan.keyID !== signer.keyID
    )
      throw new OrganizationRuntimeError({
        code: "HANDOFF_BLOCKED",
        message: "Environment mapping requires its original live enrolled machine authorization",
        outcome: "not_dispatched",
        retryable: false,
      })
  }
  const admit = () => {
    assert()
    const now = Date.now()
    if (plan.issuedAt > now || plan.expiresAt <= now)
      throw new OrganizationRuntimeError({
        code: "HANDOFF_BLOCKED",
        message: "Environment mapping requires its original live enrolled machine authorization",
        outcome: "not_dispatched",
        retryable: false,
      })
  }
  admit()
  if (!(await Handoff.verifyMachinePlan(plan, authorization.signature, signer.publicKey)))
    throw denied("Environment mapping has no original service signature")
  admit()
  const result = await body(plan, assert)
  try {
    assert()
  } catch (error) {
    throw new OrganizationRuntimeError(
      {
        code: "HANDOFF_BLOCKED",
        message: "Original Environment mapping callback ended after native acceptance",
        outcome: "unknown",
        retryable: false,
      },
      { cause: error },
    )
  }
  return result
}

function assertInfrastructureOwner(selection: Execution.Selection) {
  if (
    (selection.infrastructure.workspace || selection.infrastructure.environment) &&
    !EnvironmentExecutionSource.has("organization")
  )
    throw new OrganizationRuntimeError({
      code: "RESOURCE_UNAVAILABLE",
      message: "The selected organization infrastructure requires its execution mapping owner",
      retryable: false,
      outcome: "not_dispatched",
    })
}

export async function withMemberExecution<T>(
  identity: RuntimeIdentity,
  input: {
    sessionID: string
    scopeID?: string
    parentSessionID?: string
    signal?: AbortSignal
  },
  fn: (resolution: MemberExecutionResolution, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withMemberResolution(identity, input, fn, true)
}

export async function drainMemberFiles(value: Epochs.Binding, signal: AbortSignal) {
  const binding = Epochs.Binding.parse(value)
  const owner = WorkspaceContent.captureOwner(signal)
  if (Storage.inTransaction()) throw denied("Member file drainage must run outside a transaction")
  const assert = async () => {
    owner()
    const actual = await Epochs.ownerPreparationBinding({ sessionID: binding.sessionID, handoffID: binding.handoffID })
    owner()
    if (JSON.stringify(actual) !== JSON.stringify(binding))
      throw denied("Member file drainage requires its exact source epoch")
  }
  await assert()
  using held = await Lock.writeWithSignal(`organization-execution:${binding.sessionID}`, signal)
  if (!held) throw denied("Member file drainage could not retain its original resolution lock")
  await assert()
}

export async function withMemberFiles<T>(
  input: {
    sessionID: string
    scopeID?: string
    parentSessionID?: string
    origin?: EnvironmentOrigin.Captured
    signal?: AbortSignal
  },
  fn: (resolution: MemberExecutionResolution & { assertCaller(): Promise<void> }, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  input = { ...input }
  const origin = input.origin
  const identity = state().identity
  if (!identity) throw denied("Organization Workspace file resolution is not registered")
  const selectedIdentity = RuntimeIdentity.parse(identity)
  return withMemberResolution(
    identity,
    input,
    async (resolution, signal) => {
      if (!resolution.description.grant.selection.infrastructure.workspace)
        throw denied("The accepted Session has no organization Workspace file owner")
      const original = resolution.session
      const sessionID = original.id
      const scopeID = original.scope.id
      const lineage = JSON.stringify(resolution.lineage)
      const accepted = { sessionID: resolution.accepted.sessionID, rootID: resolution.accepted.rootID }
      const cortex = (session: typeof original) =>
        session.cortex && {
          taskID: session.cortex.taskID,
          parentSessionID: session.cortex.parentSessionID,
          parentMessageID: session.cortex.parentMessageID,
        }
      const caller = JSON.stringify({
        parentID: original.parentID,
        organization: original.organization,
        cortex: cortex(original),
      })
      async function assertCaller() {
        signal.throwIfAborted()
        if (state().connection !== resolution.source) throw denied("Workspace file connection changed")
        if (!origin) return
        origin.assertCurrent()
        const selected = origin.value
        if (selected.kind !== "session" || selected.sessionID !== sessionID || selected.scopeID !== scopeID)
          throw denied("Workspace files require their original native caller")
        await EnvironmentOrigin.assertAdmission(origin, { scopeID })
        const current = await sessionFor(sessionID, selectedIdentity, resolution.source)
        if (
          JSON.stringify({
            parentID: current.parentID,
            organization: current.organization,
            cortex: cortex(current),
          }) !== caller ||
          JSON.stringify(await executionLineage(current, selectedIdentity, resolution.source)) !== lineage ||
          (!lineage && (accepted.sessionID !== selected.sessionID || accepted.rootID !== selected.rootID))
        )
          throw denied("Workspace files cannot replace their original caller or accepted lineage")
        origin.assertCurrent()
        signal.throwIfAborted()
        if (state().connection !== resolution.source) throw denied("Workspace file connection changed")
      }
      await assertCaller()
      return fn({ ...resolution, assertCaller }, signal)
    },
    false,
  )
}

export async function withMemberEnvironment<T>(
  input: { sessionID: string; scopeID: string; origin?: EnvironmentOrigin.Captured; signal?: AbortSignal },
  fn: (
    resolution: MemberExecutionResolution & {
      assertConnection(): void
      assertCaller(phase: "admission" | "mutation"): Promise<void>
    },
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  if (Storage.inTransaction()) throw denied("Environment resolution must run outside a native transaction")
  input = { ...input }
  const identity = state().identity
  if (!identity) throw denied("Organization Environment resolution is not registered")
  const selectedIdentity = RuntimeIdentity.parse(identity),
    owner = WorkspaceContent.captureOwner()
  const captured = await withMemberResolution(
    selectedIdentity,
    input,
    async (resolution, signal) => {
      const origin = input.origin,
        original = resolution.session
      const native = origin?.value
      if (
        native &&
        (native.kind !== "session" || native.sessionID !== original.id || native.scopeID !== original.scope.id)
      )
        throw denied("Environment requires its original native Session caller")
      const snapshot = (session: typeof original) =>
        JSON.stringify({
          parentID: session.parentID,
          organization: session.organization,
          environmentID: session.environmentID,
          workspaceID: session.workspaceID,
          workspaceGeneration: session.workspace?.generation,
          cortex: session.cortex && {
            taskID: session.cortex.taskID,
            parentSessionID: session.cortex.parentSessionID,
            parentMessageID: session.cortex.parentMessageID,
          },
        })
      const selected = snapshot(original),
        lineage = JSON.stringify(resolution.lineage)
      const accepted = { sessionID: resolution.accepted.sessionID, rootID: resolution.accepted.rootID }
      const assertConnection = () => {
        owner()
        resolution.source.signal.throwIfAborted()
        if (state().connection !== resolution.source) throw denied("Environment connection changed")
        origin?.assertCurrent()
      }
      const assertCaller = async (phase: "admission" | "mutation") => {
        assertConnection()
        if (phase === "admission") input.signal?.throwIfAborted()
        const verify = async () => {
          assertConnection()
          const currentSession = await sessionFor(original.id, selectedIdentity, resolution.source)
          if (
            snapshot(currentSession) !== selected ||
            JSON.stringify(await executionLineage(currentSession, selectedIdentity, resolution.source)) !== lineage ||
            (native?.kind === "session" &&
              !lineage &&
              (accepted.sessionID !== native.sessionID || accepted.rootID !== native.rootID))
          )
            throw denied("Environment cannot replace its original native selection or accepted lineage")
          if (origin) {
            if (phase === "admission")
              await EnvironmentOrigin.assertAdmission(origin, {
                scopeID: original.scope.id,
                environmentID: original.environmentID ?? undefined,
              })
            else await EnvironmentOrigin.assertMutation(origin.value)
          }
          assertConnection()
        }
        if (phase === "mutation") await Storage.transaction(verify, { commitGuard: assertConnection })
        else await verify()
        assertConnection()
        if (phase === "admission") input.signal?.throwIfAborted()
      }
      await assertCaller("admission")
      return { resolution: { ...resolution, assertCaller, assertConnection }, signal }
    },
    false,
  )
  await captured.resolution.assertCaller("admission")
  return fn(captured.resolution, captured.signal)
}

export async function inspectMemberFiles(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  input: Parameters<MemberConnection["resources"]["inspectWorkspaceFile"]>[1],
  signal?: AbortSignal,
) {
  const original = Leases.Authority.parse(authority)
  const selected = { grantID: selector.grantID, generation: selector.generation }
  const file = structuredClone(input)
  const source = current()
  const cancellation = AbortSignal.any([source.signal, ...(signal ? [signal] : [])])
  const proof = await source.intake.cleanupProof(original, selected)
  cancellation.throwIfAborted()
  if (state().connection !== source) throw denied("Workspace inspection connection changed")
  const result = await source.resources.inspectWorkspaceFile(proof, file, cancellation)
  cancellation.throwIfAborted()
  if (state().connection !== source) throw denied("Workspace inspection connection changed")
  return result
}

export async function inspectMemberEnvironment(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  input: Parameters<MemberConnection["resources"]["inspectEnvironment"]>[1],
  signal?: AbortSignal,
) {
  const original = Leases.Authority.parse(authority)
  const retained = { grantID: selector.grantID, generation: selector.generation }
  const query = CloudEnvironment.InspectionQuery.parse(input)
  const source = current(),
    owner = WorkspaceContent.captureOwner()
  const cancellation = AbortSignal.any([source.signal, ...(signal ? [signal] : [])])
  const proof = await source.intake.cleanupProof(original, retained)
  cancellation.throwIfAborted()
  owner()
  if (state().connection !== source) throw denied("Environment inspection connection changed")
  const result = await source.resources.inspectEnvironment(proof, query, cancellation)
  cancellation.throwIfAborted()
  owner()
  if (state().connection !== source) throw denied("Environment inspection connection changed")
  return result
}

async function environmentRetirement(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  query: CloudEnvironment.RetirementQuery,
  signal: AbortSignal | undefined,
  method: "retireEnvironment" | "inspectEnvironmentRetirement",
) {
  if (Storage.inTransaction()) throw denied("Environment retirement must run outside a native transaction")
  const original = Leases.Authority.parse(structuredClone(authority))
  const selected = { grantID: selector.grantID, generation: selector.generation }
  const input = CloudEnvironment.RetirementQuery.parse(structuredClone(query))
  const source = current(),
    runtime = RuntimeContext.current(),
    primary = runtime.storage
  const owner = WorkspaceContent.captureOwner(signal)
  const assert = () => {
    owner()
    const actual = Storage.current()
    if (
      !primary ||
      runtime.storage !== primary ||
      actual.store !== primary.store ||
      actual.artifactDirectory !== primary.artifactDirectory ||
      actual.artifactObjects !== primary.artifactObjects ||
      RuntimeContext.current() !== runtime ||
      state().connection !== source ||
      input.reference.orgID !== original.orgID ||
      input.reference.runtimeID !== source.connection.runtimeID ||
      (method === "retireEnvironment" && actual.store.options.readonly)
    )
      throw denied("Environment retirement lost its original Home, primary or enrolled connection")
    source.signal.throwIfAborted()
  }
  assert()
  const cancellation = AbortSignal.any([source.signal, ...(signal ? [signal] : [])])
  const proof = await source.intake.cleanupProof(original, selected)
  assert()
  let result: CloudEnvironment.RetirementResult
  try {
    result = await source.resources[method](proof, input, cancellation)
  } catch (error) {
    if (error instanceof OrganizationRuntimeError) throw error
    throw new OrganizationRuntimeError(
      {
        code: "SERVICE_UNAVAILABLE",
        outcome: "unknown",
        retryable: false,
        message: "Original Environment retirement has no confirmed reply",
      },
      { cause: error },
    )
  }
  try {
    assert()
    cancellation.throwIfAborted()
  } catch (error) {
    throw new OrganizationRuntimeError(
      {
        code: "SERVICE_UNAVAILABLE",
        outcome: "unknown",
        retryable: false,
        message: "Original Environment retirement reply lost its original owner",
      },
      { cause: error },
    )
  }
  return result
}

export function retireMemberEnvironment(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  query: CloudEnvironment.RetirementQuery,
  signal?: AbortSignal,
) {
  return environmentRetirement(authority, selector, query, signal, "retireEnvironment")
}

export function inspectMemberEnvironmentRetirement(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  query: CloudEnvironment.RetirementQuery,
  signal?: AbortSignal,
) {
  return environmentRetirement(authority, selector, query, signal, "inspectEnvironmentRetirement")
}

async function withNativeCleanupProof<T>(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number } | undefined,
  signal: AbortSignal | undefined,
  body: (proof: Execution.InspectionProof, resources: MemberConnection["resources"], signal: AbortSignal) => Promise<T>,
) {
  if (Storage.inTransaction()) throw denied("Native Environment cleanup must run outside a native transaction")
  const original = Leases.Authority.parse(structuredClone(authority))
  const selected = selector && { ...selector }
  const source = current(),
    owner = WorkspaceContent.captureOwner(signal)
  const assert = () => {
    owner()
    EnvironmentExecutionSource.assertRegisteredOwner("organization")
    source.signal.throwIfAborted()
    if (
      state().connection !== source ||
      original.runtimeID !== source.connection.runtimeID ||
      original.orgID !== source.connection.orgID ||
      original.deploymentIncarnation !== source.connection.deploymentIncarnation
    )
      throw denied("Native cleanup lost its original enrolled Runtime connection")
  }
  assert()
  const cancellation = AbortSignal.any([source.signal, ...(signal ? [signal] : [])])
  const proof = await source.intake.cleanupProof(original, selected)
  assert()
  let result: T
  try {
    result = await body(proof, source.resources, cancellation)
  } catch (error) {
    if (error instanceof OrganizationRuntimeError) throw error
    throw new OrganizationRuntimeError(
      {
        code: "SERVICE_UNAVAILABLE",
        outcome: "unknown",
        retryable: false,
        message: "Original native cleanup has no confirmed response",
      },
      { cause: error },
    )
  }
  try {
    assert()
    cancellation.throwIfAborted()
  } catch (error) {
    throw new OrganizationRuntimeError(
      {
        code: "SERVICE_UNAVAILABLE",
        outcome: "unknown",
        retryable: false,
        message: "Native cleanup lost its original owner before acknowledgement",
      },
      { cause: error },
    )
  }
  return result
}

export function inspectMemberNativeGrant(
  authority: Leases.Authority,
  selector?: { grantID: string; generation: number },
  signal?: AbortSignal,
) {
  return withNativeCleanupProof(authority, selector, signal, (proof, resources, cancellation) =>
    resources.inspectRetention(proof, cancellation),
  )
}

export function discoverMemberEnvironmentCleanup(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  page: { limit?: number; cursor?: string },
  signal?: AbortSignal,
) {
  const selected = CloudCleanup.DiscoveryProof.shape.page.parse(structuredClone(page))
  return withNativeCleanupProof(authority, selector, signal, (proof, resources, cancellation) =>
    resources.discoverEnvironmentCleanup(proof, selected, cancellation),
  )
}

export function reconcileMemberEnvironmentCleanup(
  authority: Leases.Authority,
  selector: { grantID: string; generation: number },
  action: "inspect" | "retire",
  candidate: CloudCleanup.Candidate,
  signal?: AbortSignal,
) {
  const selected = CloudCleanup.Candidate.parse(structuredClone(candidate))
  return withNativeCleanupProof(authority, selector, signal, (proof, resources, cancellation) =>
    resources.reconcileEnvironmentCleanup(proof, action, selected, cancellation),
  )
}

async function withMemberResolution<T>(
  identity: RuntimeIdentity,
  input: { sessionID: string; scopeID?: string; parentSessionID?: string; signal?: AbortSignal },
  fn: (resolution: MemberExecutionResolution, signal: AbortSignal) => Promise<T>,
  nativeOnly: boolean,
): Promise<T> {
  identity = RuntimeIdentity.parse(identity)
  input = { ...input }
  const source = current()
  const signal = input.signal ? AbortSignal.any([source.signal, input.signal]) : source.signal
  using held = await Lock.writeWithSignal(`organization-execution:${input.sessionID}`, signal)
  signal.throwIfAborted()
  const session = await sessionFor(input.sessionID, identity, source)
  if (
    (input.scopeID !== undefined && input.scopeID !== session.scope.id) ||
    (input.parentSessionID !== undefined && input.parentSessionID !== session.parentID)
  )
    throw denied("Member execution target does not match its canonical Session")
  const queued = await SessionInbox.peekTask(session.id)
  const root = queued ? undefined : await SessionExecutionOwners.latestRoot(session.id)
  const lineage = await executionLineage(session, identity, source)
  const lookup = lineage?.actor ?? actor(queued?.message?.actor ?? root?.actor, identity)
  const descriptionProof = await source.intake.descriptionProof(lookup)
  const accepted = descriptionProof.receipt.accepted!
  const acceptedSessionID = lineage?.sessionID ?? session.id
  const acceptedRootID = lineage?.rootID ?? queued?.messageID ?? root?.id
  if (accepted.permit.sessionID !== acceptedSessionID || accepted.effect.messageID !== acceptedRootID)
    throw denied("Member execution requires the receipt for its selected native task")
  const description = await source.resources.describe(descriptionProof, signal)
  if (nativeOnly) assertInfrastructureOwner(description.grant.selection)
  const proof = await source.intake.bindingProof(lookup, acceptedRootID)
  const lineageAccepted = lineage ?? { sessionID: session.id, rootID: acceptedRootID, actor: lookup }
  return await fn({ source, session, lineage, descriptionProof, proof, description, accepted: lineageAccepted }, signal)
}

function assertBinding(
  session: Awaited<ReturnType<typeof Session.get>>,
  identity: RuntimeIdentity,
  source: Connection,
) {
  if (
    !session.organization ||
    session.time.archived ||
    session.organization.orgID !== identity.orgID ||
    session.organization.orgID !== source.connection.orgID ||
    session.organization.projectID !== session.scope.id ||
    session.organization.driverRuntimeID !== source.connection.runtimeID
  )
    throw denied("Member execution requires its current organization Session binding")
}

async function sessionFor(sessionID: string, identity: RuntimeIdentity, source: Connection) {
  const session = await Session.get(sessionID)
  assertBinding(session, identity, source)
  return session
}

async function executionLineage(
  session: Awaited<ReturnType<typeof Session.get>>,
  identity: RuntimeIdentity,
  source: Connection,
): Promise<ExecutionLineage | undefined> {
  const visited = new Set<string>()
  let current = session
  while (current.parentID) {
    if (!visited.add(current.id)) throw denied("Member execution requires an acyclic Cortex lineage")
    const cortex = current.cortex
    if (
      !cortex ||
      cortex.parentSessionID !== current.parentID ||
      !cortex.taskID ||
      !cortex.parentMessageID ||
      !["queued", "running", "interrupted"].includes(cortex.status)
    )
      throw denied("Member execution requires an admitted Cortex child Session")
    const parent = await Session.get(current.parentID).catch(() => undefined)
    if (!parent) throw denied("Member execution requires its Cortex parent Session")
    assertBinding(parent, identity, source)
    const parentMessage = await MessageV2.readInfo({
      scopeID: parent.scope.id,
      sessionID: parent.id,
      messageID: cortex.parentMessageID,
    }).catch(() => undefined)
    if (!parentMessage || parentMessage.sessionID !== parent.id)
      throw denied("Member execution requires the recorded Cortex parent message")
    const rootID = parentMessage.rootID ?? parentMessage.id
    const root = await MessageV2.readInfo({ scopeID: parent.scope.id, sessionID: parent.id, messageID: rootID }).catch(
      () => undefined,
    )
    if (!root || root.role !== "user" || !root.isRoot || root.rootID !== root.id)
      throw denied("Member execution requires the Cortex parent root")
    const rootActor = Command.Actor.safeParse(root.actor)
    if (rootActor.success && rootActor.data.orgID === identity.orgID)
      return {
        sessionID: parent.id,
        rootID: root.id,
        actor: { subjectID: rootActor.data.subjectID, requestID: rootActor.data.requestID },
      }
    if (rootActor.success) throw denied("Member execution requires an organization Cortex root actor")
    current = parent
  }
  return undefined
}

function actor(value: unknown, identity: RuntimeIdentity) {
  const parsed = Command.Actor.safeParse(value)
  if (!parsed.success || parsed.data.orgID !== identity.orgID)
    throw denied("Member execution requires an accepted organization actor")
  return { subjectID: parsed.data.subjectID, requestID: parsed.data.requestID }
}

export function registerMemberExecution(identity: RuntimeIdentity) {
  state().identity = RuntimeIdentity.parse(identity)
  Leases.register(identity.orgID)
  ProviderCatalogSource.register({ providers: async () => Object.fromEntries(models()) })
  SessionExecutionSource.register({
    async authorize(input) {
      const source = current()
      const signal = input.signal ? AbortSignal.any([source.signal, input.signal]) : source.signal
      using held = await Lock.writeWithSignal(`organization-execution:${input.sessionID}`, signal)
      signal.throwIfAborted()
      const session = await sessionFor(input.sessionID, identity, source)
      if (input.scopeID !== session.scope.id || input.parentSessionID !== session.parentID)
        throw denied("Member execution target does not match its canonical Session")
      const queued = await SessionInbox.peekTask(session.id)
      const root = queued ? undefined : await SessionExecutionOwners.latestRoot(session.id)
      const lineage = await executionLineage(session, identity, source)
      const lookup = lineage?.actor ?? actor(queued?.message?.actor ?? root?.actor, identity)
      const proof = await source.intake.descriptionProof(lookup)
      const accepted = proof.receipt.accepted!
      const acceptedSessionID = lineage?.sessionID ?? session.id
      const acceptedRootID = lineage?.rootID ?? queued?.messageID ?? root?.id
      if (accepted.permit.sessionID !== acceptedSessionID || accepted.effect.messageID !== acceptedRootID)
        throw denied("Member execution requires the receipt for its selected native task")
      const description = await source.resources.describe(proof, signal)
      assertInfrastructureOwner(description.grant.selection)
      const resource = description.resources.find(
        (resource) => resource.resourceID === description.grant.selection.modelResourceID,
      )!
      const provider = createMemberModelProvider(resource, source.origin)
      const modelID = Object.keys(provider.models)[0]!
      if (root && (root.model.providerID !== provider.id || root.model.modelID !== modelID))
        throw denied("Organization model changed after its native root was materialized")
      await ScopeContext.provide({
        scope: session.scope,
        workspace: session.workspace,
        fn: async () => {
          signal.throwIfAborted()
          const catalog = models()
          if (JSON.stringify(catalog.get(provider.id)) !== JSON.stringify(provider)) {
            catalog.set(provider.id, provider)
            await Provider.reload()
          }
          signal.throwIfAborted()
          const selected = (await Session.get(session.id)).modelSelection?.selected.model
          if (selected?.providerID !== provider.id || selected.modelID !== modelID)
            await Session.setModelSelection(session.id, { model: { providerID: provider.id, modelID } })
        },
      })
    },
  })
  SessionExecutionContributions.register({
    id: "organization-initial-workspace",
    async prepareModel(session, context) {
      if (!session.organization || session.organization.orgID !== identity.orgID) return
      await withMemberResolution(
        identity,
        {
          sessionID: session.id,
          scopeID: session.scope.id,
          parentSessionID: session.parentID,
          signal: context.signal,
        },
        async (resolution, signal) => {
          if (!resolution.description.grant.selection.infrastructure.workspace) return
          const root = await SessionExecutionOwners.latestRoot(session.id)
          if (root?.id !== context.rootMessageID || (!resolution.lineage && resolution.accepted.rootID !== root.id))
            throw denied("Initial Working requires its exact materialized native task")
          const source = resolution.source
          const grant = await source.resources.bind(resolution.proof, signal)
          const files = await source.resources.workspaceFiles(
            resolution.proof,
            { operation: { action: "describe" } },
            signal,
          )
          signal.throwIfAborted()
          if (
            resolution.description.grant.grantID !== grant.grantID ||
            grant.deploymentIncarnation !== source.connection.deploymentIncarnation ||
            JSON.stringify(resolution.description.grant.selection) !== JSON.stringify(grant.selection)
          )
            throw denied("Initial Working changed its original accepted resource selection")
          await prepareInitialWorkspace({
            sessionID: session.id,
            grant,
            reference: files.reference,
            signal,
            assert() {
              signal.throwIfAborted()
              if (current() !== source) throw denied("Initial Working lost its original machine connection")
            },
          })
        },
        true,
      )
    },
  })
  ProviderRequestSource.register({
    async prepare(input) {
      const source = current()
      const signal = AbortSignal.any([source.signal, input.abort])
      signal.throwIfAborted()
      using held = await Lock.writeWithSignal(`organization-execution:${input.sessionID}`, signal)
      signal.throwIfAborted()
      const session = await sessionFor(input.sessionID, identity, source)
      const lineage = await executionLineage(session, identity, source)
      const rootID = input.user.rootID ?? (input.user.isRoot ? input.user.id : undefined)
      if (!rootID || input.user.sessionID !== session.id)
        throw denied("Organization model call requires its native root")
      const root = await MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: rootID })
      if (root.role !== "user" || !root.isRoot || root.rootID !== root.id)
        throw denied("Organization model call requires its canonical native root")
      if (input.model.providerID !== root.model.providerID || input.model.id !== root.model.modelID)
        throw denied("Organization model call differs from its canonical native root")
      const accepted = lineage ?? { sessionID: session.id, rootID: root.id, actor: actor(root.actor, identity) }
      const proof = await source.intake.bindingProof(accepted.actor, accepted.rootID)
      const grant = await source.resources.bind(proof, signal)
      assertInfrastructureOwner(grant.selection)
      if (input.model.providerID !== `organization-${grant.selection.modelResourceID}`)
        throw denied("Organization model call differs from its accepted resource selection")
      const issuedAt = Date.now()
      const capability = await source.resources.reserve(
        {
          schemaVersion: 1,
          purpose: "gateway-call",
          orgID: grant.orgID,
          deploymentIncarnation: grant.deploymentIncarnation,
          runtimeID: grant.runtimeID,
          connectionEpoch: source.connection.connectionEpoch,
          grantID: grant.grantID,
          sessionID: grant.sessionID,
          rootID: grant.rootID,
          bindingEpoch: grant.bindingEpoch,
          resourceID: grant.selection.modelResourceID,
          callID: crypto.randomUUID(),
          issuedAt,
          expiresAt: issuedAt + 30_000,
        },
        signal,
      )
      const modelPermit = Gateway.ModelPermit.safeParse(capability.permit)
      const packageName =
        modelPermit.success && modelPermit.data.protocol === "openai-compatible"
          ? "@ai-sdk/openai-compatible"
          : modelPermit.success && modelPermit.data.protocol === "anthropic-compatible"
            ? "@ai-sdk/anthropic"
            : undefined
      if (
        !modelPermit.success ||
        !packageName ||
        input.model.api.id !== modelPermit.data.modelID ||
        input.model.api.npm !== packageName
      )
        throw denied("Organization model changed after native request preparation")
      signal.throwIfAborted()
      return {
        key: Gateway.encode(capability),
        context: MemberModelContext.parse({
          schemaVersion: 1,
          purpose: "organization-model",
          origin: source.origin,
          signingIdentity: source.connection.signingIdentity,
          ca: source.ca,
        }),
      }
    },
  })
}
