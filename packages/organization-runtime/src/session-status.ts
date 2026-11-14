import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Info, StatusInfo } from "@ericsanchezok/synergy-harness/session/types"
import { readCommandControlVersion } from "./command-intake"

export async function currentRunID(session: Info, status?: StatusInfo) {
  const runtime = SessionManager.getRuntime(session.id)
  const observed = status ?? runtime?.status
  const active =
    runtime?.owner?.rootID ??
    (observed?.type === "busy" ? observed.activity?.rootID : undefined) ??
    (observed?.type === "retry" ? observed.rootID : undefined) ??
    (session.resume?.state === "queued" ? session.resume.rootID : undefined)
  if (active) return active
  if (!session.paused && observed?.type !== "paused") return
  const rootID = await SessionInbox.latestRootID(session.id)
  if (!rootID) return
  const run = await RolloutLedger.getRun(RolloutLifecycle.owner(session), rootID).catch((error) => {
    if (error instanceof Storage.NotFoundError) return
    throw error
  })
  if (run) {
    if (
      run.id !== rootID ||
      run.owner.kind !== "session" ||
      run.owner.sessionID !== session.id ||
      run.owner.scopeID !== session.scope.id
    )
      throw new Error("The current native Run has another Session owner")
    if (run.status !== "running" && run.status !== "interrupted") return
  }
  return rootID
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
    runID: await currentRunID(session, native),
  }
  return Sync.Status.parse(
    native.type === "paused"
      ? { ...observation, type: native.type, since: native.since, reason: native.reason }
      : native.type === "retry"
        ? { ...observation, type: native.type, attempt: native.attempt, next: native.next }
        : { ...observation, type: native.type },
  )
}
