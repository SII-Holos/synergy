import { EnvironmentOrigin } from "../environment/origin"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { RolloutLifecycle } from "./rollout/lifecycle"
import { RolloutLedger } from "./rollout/ledger"
import { SessionTransferGate } from "./transfer-gate"

async function validate(
  origin: Readonly<EnvironmentOrigin.Session>,
  admission: boolean,
  target?: Readonly<EnvironmentOrigin.Target>,
) {
  const [raw] = await Storage.readMany<Record<string, unknown>>([
    StoragePath.sessionInfo(Identifier.asScopeID(origin.scopeID), Identifier.asSessionID(origin.sessionID)),
  ])
  if (!raw) throw new Error("Environment origin requires its canonical Session")
  const session = Session.PersistedInfo.parse({ ...raw, workspace: null })
  if (session.id !== origin.sessionID || session.scope.id !== origin.scopeID)
    throw new Error("Environment origin belongs to another Session or Scope")
  if (target?.environmentID && session.environmentID !== target.environmentID)
    throw new Error("Environment origin differs from its Session's selected Environment")
  const owner = RolloutLifecycle.owner(session)
  const [root, message, run, tool] = await Promise.all([
    MessageV2.readInfo({ scopeID: origin.scopeID, sessionID: origin.sessionID, messageID: origin.rootID }),
    MessageV2.readInfo({ scopeID: origin.scopeID, sessionID: origin.sessionID, messageID: origin.messageID }),
    RolloutLedger.getRun(owner, origin.runID),
    RolloutLedger.toolForPart(owner, {
      runID: origin.runID,
      messageID: origin.messageID,
      toolCallID: origin.callID,
      tool: origin.tool,
    }),
  ])
  if (
    root.role !== "user" ||
    root.sessionID !== origin.sessionID ||
    !root.isRoot ||
    root.rootID !== root.id ||
    root.id !== origin.rootID ||
    message.role !== "assistant" ||
    message.id !== origin.messageID ||
    message.sessionID !== session.id ||
    message.rootID !== root.id ||
    run.id !== origin.runID ||
    run.id !== root.id ||
    run.owner.kind !== "session" ||
    run.owner.scopeID !== origin.scopeID ||
    run.owner.sessionID !== origin.sessionID ||
    !tool
  )
    throw new Error("Environment origin does not match its canonical native root, Run and tool call")
  if (
    admission &&
    (session.paused ||
      session.time.archived ||
      run.status !== "running" ||
      run.cancelRequestedAt ||
      run.recording === "failed" ||
      tool.status !== "running")
  )
    throw new Error("Environment origin cannot start another native effect")
}

export function registerSessionEnvironmentOrigin() {
  EnvironmentOrigin.registerSessionAuthority({
    async admission(origin, target) {
      await SessionTransferGate.assert(origin.sessionID)
      await validate(origin, true, target)
    },
    async mutation(origin) {
      await SessionTransferGate.assertOwnerMutation(origin.sessionID)
      await validate(origin, false)
    },
  })
}
