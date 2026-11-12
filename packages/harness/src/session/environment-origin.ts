import { EnvironmentOrigin } from "../environment/origin"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { PersistedInfo } from "./types"
import { MessageV2 } from "./message-v2"
import { RolloutOwner } from "./rollout/owner"
import { RolloutLedger } from "./rollout/ledger"
import { SessionEnvironmentOriginEvidence } from "./environment-origin-evidence"

async function validate(
  origin: Readonly<EnvironmentOrigin.Session>,
  admission: boolean,
  target?: Readonly<EnvironmentOrigin.Target>,
) {
  origin = EnvironmentOrigin.Session.parse(origin)
  target = target && Object.freeze({ ...target })
  const [raw] = await Storage.readMany<Record<string, unknown>>([
    StoragePath.sessionInfo(Identifier.asScopeID(origin.scopeID), Identifier.asSessionID(origin.sessionID)),
  ])
  if (!raw) throw new Error("Environment origin requires its canonical Session")
  const session = PersistedInfo.parse({ ...raw, workspace: null })
  SessionEnvironmentOriginEvidence.verifySession(origin, session, target)
  const owner = RolloutOwner.session(session)
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
  const evidence = { session, root, message, run, tool }
  SessionEnvironmentOriginEvidence.verify(origin, evidence, admission, target)
  return evidence
}

export const inspectSessionEnvironmentOrigin = (origin: Readonly<EnvironmentOrigin.Session>) => validate(origin, false)

export function registerSessionEnvironmentOrigin(gate: {
  admission(sessionID: string): Promise<void>
  mutation(sessionID: string): Promise<void>
}) {
  const admission = gate.admission.bind(gate)
  const mutation = gate.mutation.bind(gate)
  EnvironmentOrigin.registerSessionAuthority({
    async admission(origin, target) {
      await admission(origin.sessionID)
      await validate(origin, true, target)
    },
    async mutation(origin) {
      await mutation(origin.sessionID)
      await validate(origin, false)
    },
  })
}
