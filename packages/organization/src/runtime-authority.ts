import { OrganizationProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

export async function runtimeAuthority(target: {
  runtimeID: string
  orgID: string
  deploymentIncarnation: string
  connectionEpoch: number
}) {
  const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(target.runtimeID))
  if (
    !runtime ||
    runtime.runtimeID !== target.runtimeID ||
    runtime.orgID !== target.orgID ||
    runtime.deploymentIncarnation !== target.deploymentIncarnation ||
    runtime.state !== "active" ||
    runtime.connectionEpoch !== target.connectionEpoch
  )
    fail("PERMISSION_DENIED", "Runtime is not authorized")
  const account =
    runtime.runtimeKind === "member" ? await Record.read(Record.Account, Keys.account(runtime.accountID)) : undefined
  if (
    runtime.runtimeKind === "member" &&
    (!account ||
      account.accountID !== runtime.accountID ||
      account.orgID !== runtime.orgID ||
      account.state !== "active")
  )
    fail("PERMISSION_DENIED", "Runtime account is not active")
  return { runtime, account }
}

export function assertRuntimeConnection(runtime: Record.RuntimeRegistration, handshake: Protocol.Handshake) {
  if (
    handshake.runtimeKind !== runtime.runtimeKind ||
    handshake.runtimeID !== runtime.runtimeID ||
    handshake.orgID !== runtime.orgID ||
    handshake.deploymentIncarnation !== runtime.deploymentIncarnation ||
    handshake.connectionEpoch !== runtime.connectionEpoch ||
    (handshake.runtimeKind === "member" &&
      runtime.runtimeKind === "member" &&
      (handshake.accountID !== runtime.accountID || handshake.deviceID !== runtime.deviceID))
  )
    fail("STALE_CONNECTION", "Runtime registration and active connection do not match")
}
