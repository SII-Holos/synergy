import {
  OrganizationCommandProtocol as Command,
  OrganizationGatewayProtocol as Gateway,
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
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import type { MemberIdentity } from "./home"
import type { MemberConnection } from "./connection"
import type { createCommandIntake } from "./command-intake"
import { OrganizationRuntimeError } from "./error"
import { createMemberModelProvider, MemberModelContext } from "./model-provider"

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

const state = RuntimeContext.state(() => ({ connection: undefined as Connection | undefined }))
const models = ScopedState.create(() => new Map<string, Provider.Info>())

function denied(message: string) {
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
  current.connection = input
  input.signal.addEventListener(
    "abort",
    () => {
      if (current.connection === input) current.connection = undefined
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

function assertBinding(session: Awaited<ReturnType<typeof Session.get>>, identity: MemberIdentity, source: Connection) {
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

async function sessionFor(sessionID: string, identity: MemberIdentity, source: Connection) {
  const session = await Session.get(sessionID)
  assertBinding(session, identity, source)
  return session
}

async function executionLineage(
  session: Awaited<ReturnType<typeof Session.get>>,
  identity: MemberIdentity,
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

function actor(value: unknown, identity: MemberIdentity) {
  const parsed = Command.Actor.safeParse(value)
  if (!parsed.success || parsed.data.orgID !== identity.orgID)
    throw denied("Member execution requires an accepted organization actor")
  return { subjectID: parsed.data.subjectID, requestID: parsed.data.requestID }
}

export function registerMemberExecution(identity: MemberIdentity) {
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
      if (description.grant.selection.connectionResourceIDs.length)
        throw denied("Selected organization connections are not available in this Runtime")
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
      const packageName =
        capability.permit.protocol === "openai-compatible" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic"
      if (input.model.api.id !== capability.permit.modelID || input.model.api.npm !== packageName)
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
