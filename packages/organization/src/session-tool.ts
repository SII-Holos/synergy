import { OrganizationSessionToolProtocol as SessionTool } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { accountSession } from "./authorization"
import type { ExecutionGrants } from "./execution-grants"
import { OrganizationSharing as Sharing } from "./sharing"
import { fail } from "./error"

export async function readSessionForExecution(
  grants: ExecutionGrants,
  value: SessionTool.ReadRequest,
  signal: AbortSignal,
): Promise<SessionTool.ReadResult> {
  const { authority, ...query } = SessionTool.ReadRequest.parse(value)
  signal.throwIfAborted()
  return grants.withAuthority(authority, async ({ grant, recheck }) => {
    let original: string | undefined
    const authorize = async () => {
      signal.throwIfAborted()
      const account = await recheck()
      return Storage.snapshot(async () => {
        const { session } = await accountSession(account, query.targetSessionID, "session.read")
        if (session.shareState !== "shared")
          fail("PERMISSION_DENIED", "Cross-Session tool reads require an explicitly shared projection")
        const binding = JSON.stringify([
          session.sessionID,
          session.driverRuntimeID,
          session.bindingEpoch,
          session.shareGeneration,
        ])
        if (original && original !== binding)
          fail("SHARE_REVOKED", "The shared Session binding changed during the read")
        original = binding
        return session
      })
    }
    const projection = await Sharing.readForExecution({ query, authorize, signal })
    await authorize()
    signal.throwIfAborted()
    return SessionTool.ReadResult.parse({
      orgID: grant.orgID,
      callerSessionID: grant.sessionID,
      rootID: grant.rootID,
      ...projection,
    })
  })
}
