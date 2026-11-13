import { ProcessAccessSource } from "@ericsanchezok/synergy-harness/process/access-source"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeIdentity } from "./home"
import { boundSessionSource } from "./session-source"
import { denied, withMemberExecution, type MemberExecutionResolution } from "./execution-source"
import { OrganizationRuntimeError } from "./error"

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const lineage = (session: Session.Info) =>
  session.cortex && {
    taskID: session.cortex.taskID,
    parentSessionID: session.cortex.parentSessionID,
    parentMessageID: session.cortex.parentMessageID,
  }

async function nativeCaller(caller: ProcessAccessSource.Caller) {
  if (caller.owner.kind !== "session" || caller.owner.sessionID !== caller.sessionID)
    throw denied("Process access requires its original native Session caller")
  const session = await Session.get(caller.sessionID)
  const [message, root, run, tools] = await Promise.all([
    MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: caller.messageID }),
    MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: caller.runID }),
    RolloutLedger.getRun(caller.owner, caller.runID),
    RolloutLedger.tools(caller.owner, caller.runID),
  ])
  const tool = tools.find(
    (tool) => tool.messageID === caller.messageID && tool.toolCallID === caller.callID && tool.tool === "process",
  )
  if (
    session.scope.id !== caller.owner.scopeID ||
    root.role !== "user" ||
    !root.isRoot ||
    root.rootID !== root.id ||
    message.role !== "assistant" ||
    message.sessionID !== session.id ||
    (message.rootID ?? message.parentID) !== caller.runID ||
    !same(run.owner, caller.owner) ||
    run.id !== caller.runID ||
    run.status !== "running" ||
    run.recording === "failed" ||
    run.cancelRequestedAt !== undefined ||
    !tool ||
    !same(tool.owner, caller.owner) ||
    tool.runID !== caller.runID ||
    tool.status !== "running" ||
    tool.ended !== undefined
  )
    throw denied("Process access requires its genuine running native Tool and Run")
  return { session, toolID: tool.id }
}

async function originalRoot(
  root: Session.Info,
  producer: Session.Info,
  producerRootID: string,
  accepted: MemberExecutionResolution["accepted"],
) {
  await boundSessionSource(root, producer.id)
  let current = producer,
    rootID = producerRootID
  const visited = new Set<string>()
  for (;;) {
    if (visited.has(current.id)) return false
    visited.add(current.id)
    const original = await MessageV2.readInfo({ scopeID: current.scope.id, sessionID: current.id, messageID: rootID })
    if (
      original.role !== "user" ||
      !original.isRoot ||
      original.rootID !== original.id ||
      original.sessionID !== current.id
    )
      return false
    if (current.id === accepted.sessionID) return rootID === accepted.rootID
    const cortex = current.cortex
    if (!current.parentID || !cortex?.taskID || cortex.parentSessionID !== current.parentID || !cortex.parentMessageID)
      return false
    const parent = await Session.get(current.parentID)
    const message = await MessageV2.readInfo({
      scopeID: parent.scope.id,
      sessionID: parent.id,
      messageID: cortex.parentMessageID,
    })
    rootID = message.rootID ?? message.id
    current = parent
  }
}

async function producer(
  value: Readonly<ProcessAccessSource.Ownership>,
  root: Session.Info,
  accepted: MemberExecutionResolution["accepted"],
) {
  const ownership = ProcessAccessSource.Ownership.parse(structuredClone(value))
  if (ownership.owner.kind !== "session") return false
  const [session, processes, tools] = await Promise.all([
    Session.get(ownership.owner.sessionID),
    RolloutLedger.processes(ownership.owner, ownership.runID),
    RolloutLedger.tools(ownership.owner, ownership.runID),
  ])
  if (session.scope.id !== ownership.owner.scopeID || session.scope.id !== root.scope.id) return false
  if (!(await originalRoot(root, session, ownership.runID, accepted))) return false
  const record = processes.find((record) => record.id === ownership.id)
  const tool = tools.find((tool) => tool.id === ownership.toolExecutionID)
  if (
    !record ||
    !same(record.owner, ownership.owner) ||
    record.runID !== ownership.runID ||
    record.toolExecutionID !== ownership.toolExecutionID ||
    !tool ||
    tool.tool !== "bash" ||
    !same(tool.owner, ownership.owner) ||
    tool.runID !== ownership.runID
  )
    return false
  const message = await MessageV2.readInfo({
    scopeID: session.scope.id,
    sessionID: session.id,
    messageID: tool.messageID,
  })
  if (
    message.role !== "assistant" ||
    message.sessionID !== session.id ||
    (message.rootID ?? message.parentID) !== ownership.runID
  )
    return false
  const executionID = EnvironmentExecution.operationID({
    scopeID: session.scope.id,
    sessionID: session.id,
    messageID: tool.messageID,
    callID: tool.toolCallID,
  })
  const info = await EnvironmentExecution.get(executionID, session.scope.id)
  return (
    info.id === executionID &&
    info.scopeID === session.scope.id &&
    info.origin.kind === "session" &&
    info.origin.scopeID === session.scope.id &&
    info.origin.sessionID === session.id &&
    info.origin.rootID === ownership.runID &&
    info.origin.runID === ownership.runID &&
    info.origin.messageID === tool.messageID &&
    info.origin.callID === tool.toolCallID &&
    info.origin.tool === "bash"
  )
}

export function registerOrganizationProcessAccess(value: RuntimeIdentity) {
  const identity = RuntimeIdentity.parse(value)
  ProcessAccessSource.register({
    async resolve(input) {
      const caller = structuredClone(input.caller),
        signal = input.signal
      const initial = await withMemberExecution(
        identity,
        {
          sessionID: caller.sessionID,
          scopeID: caller.owner.scopeID,
          signal,
        },
        async (resolution, cancellation) => {
          const original = await nativeCaller(caller)
          const grant = Execution.BoundGrant.parse(
            resolution.description.grant.state === "provisional"
              ? await resolution.source.resources.bind(resolution.proof, cancellation)
              : resolution.description.grant,
          )
          cancellation.throwIfAborted()
          const native = await nativeCaller(caller)
          if (native.toolID !== original.toolID)
            throw denied("Process access changed its original native Tool while binding")
          if (
            grant.sessionID !== resolution.accepted.sessionID ||
            grant.rootID !== resolution.accepted.rootID ||
            grant.retention.state !== "held"
          )
            throw denied("Process access requires its actual accepted retained root")
          if (
            !resolution.lineage &&
            (caller.sessionID !== resolution.accepted.sessionID || caller.runID !== resolution.accepted.rootID)
          )
            throw denied("Process caller cannot replace its accepted native root")
          return { resolution, cancellation, native, grant }
        },
      )
      const source = initial.resolution.source
      const snapshot = JSON.stringify({
        sessionID: initial.native.session.id,
        scopeID: initial.native.session.scope.id,
        parentID: initial.native.session.parentID,
        cortex: lineage(initial.native.session),
        organization: initial.native.session.organization,
        toolID: initial.native.toolID,
        lineage: initial.resolution.lineage,
        accepted: initial.resolution.accepted,
        grantID: initial.grant.grantID,
        generation: initial.grant.retention.generation,
        bindingEpoch: initial.grant.bindingEpoch,
        selectionRevision: initial.grant.selectionRevision,
      })
      const assert = () => {
        signal.throwIfAborted()
        initial.cancellation.throwIfAborted()
        source.signal.throwIfAborted()
      }
      const recheck = async () => {
        assert()
        await withMemberExecution(
          identity,
          { sessionID: caller.sessionID, scopeID: caller.owner.scopeID, signal },
          async (current) => {
            if (current.source !== source) throw denied("Process access changed its original enrolled connection")
            const native = await nativeCaller(caller)
            const grant = Execution.BoundGrant.parse(current.description.grant)
            if (
              grant.retention.state !== "held" ||
              JSON.stringify({
                sessionID: native.session.id,
                scopeID: native.session.scope.id,
                parentID: native.session.parentID,
                cortex: lineage(native.session),
                organization: native.session.organization,
                toolID: native.toolID,
                lineage: current.lineage,
                accepted: current.accepted,
                grantID: grant.grantID,
                generation: grant.retention.generation,
                bindingEpoch: grant.bindingEpoch,
                selectionRevision: grant.selectionRevision,
              }) !== snapshot
            )
              throw denied("Process access changed its original native caller or accepted root")
            assert()
          },
        )
        assert()
      }
      return {
        assert,
        recheck,
        async allows(ownership) {
          assert()
          const root = await Session.get(initial.resolution.accepted.sessionID)
          try {
            const allowed = await producer(ownership, root, initial.resolution.accepted)
            assert()
            return allowed
          } catch (error) {
            if (
              error instanceof Storage.NotFoundError ||
              (error instanceof OrganizationRuntimeError && error.data.code === "NOT_FOUND")
            )
              return false
            throw error
          }
        },
      }
    },
  })
}
