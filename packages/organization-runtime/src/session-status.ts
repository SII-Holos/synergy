import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import type { Info, StatusInfo } from "@ericsanchezok/synergy-harness/session/types"
import { readCommandControlVersion } from "./command-intake"

export function currentRunID(session: Info, status?: StatusInfo) {
  const runtime = SessionManager.getRuntime(session.id)
  const observed = status ?? runtime?.status
  return (
    runtime?.owner?.rootID ??
    (observed?.type === "busy" ? observed.activity?.rootID : undefined) ??
    (session.resume?.state === "queued" ? session.resume.rootID : undefined)
  )
}

export async function observeSessionStatus(
  session: Info,
  orgID: string,
  rootSessionID = session.id,
  supplied?: StatusInfo,
) {
  const native = supplied ?? (await SessionManager.statusesFor([session]))[session.id] ?? { type: "idle" }
  const observation = {
    observedAt: Date.now(),
    controlVersion: await readCommandControlVersion(orgID, rootSessionID),
    runID: currentRunID(session, native),
  }
  return Sync.Status.parse(
    native.type === "paused"
      ? { ...observation, type: native.type, since: native.since, reason: native.reason }
      : native.type === "retry"
        ? { ...observation, type: native.type, attempt: native.attempt, next: native.next }
        : { ...observation, type: native.type },
  )
}
