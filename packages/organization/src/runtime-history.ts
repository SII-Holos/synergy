import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

export namespace OrganizationRuntimeHistory {
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  function invalid(): never {
    return fail("PROTOCOL_MISMATCH", "Historical Member metadata has another original registration")
  }
  export function member(source: Record.HistoricalReader, runtimeID: string) {
    const runtime = source.read(Record.RuntimeRegistration, Keys.runtime(runtimeID))
    if (runtime.runtimeKind !== "member") invalid()
    const deployment = source.read(OrganizationProtocol.Deployment, Keys.deployment())
    const account = source.read(Record.Account, Keys.account(runtime.accountID))
    if (
      runtime.runtimeID !== runtimeID ||
      runtime.orgID !== deployment.orgID ||
      account.accountID !== runtime.accountID ||
      account.orgID !== runtime.orgID ||
      source.read(Record.RuntimeIndex, Keys.runtimeDevice(runtime.accountID, runtime.deviceID)).runtimeID !==
        runtimeID ||
      source.read(Record.RuntimeIndex, Keys.accountRuntime(runtime.accountID, runtimeID)).runtimeID !== runtimeID
    )
      invalid()
    return runtime
  }
  export function validate(source: Record.HistoricalReader, key: string[], value: unknown) {
    if (key[0] !== "organization") return false
    if (key[1] === "runtimes") {
      const runtime = Record.RuntimeRegistration.parse(value)
      if (runtime.runtimeKind !== "member") return false
      if (!equal(key, Keys.runtime(runtime.runtimeID)) || !equal(runtime, member(source, runtime.runtimeID))) invalid()
      return true
    }
    if (key[1] === "runtime-devices" || key[1] === "account-runtimes") {
      const index = Record.RuntimeIndex.parse(value)
      const runtime = member(source, index.runtimeID)
      const expected =
        key[1] === "runtime-devices"
          ? Keys.runtimeDevice(runtime.accountID, runtime.deviceID)
          : Keys.accountRuntime(runtime.accountID, runtime.runtimeID)
      if (!equal(key, expected)) invalid()
      return true
    }
    if (key[1] === "runtime-connections") {
      const connection = Record.RuntimeConnection.parse(value)
      const handshake = connection.handshake
      if (handshake.runtimeKind !== "member") return false
      const runtime = member(source, handshake.runtimeID)
      if (
        !equal(key, Keys.runtimeConnection(runtime.runtimeID)) ||
        handshake.orgID !== runtime.orgID ||
        handshake.deploymentIncarnation !== runtime.deploymentIncarnation ||
        handshake.accountID !== runtime.accountID ||
        handshake.deviceID !== runtime.deviceID ||
        handshake.connectionEpoch !== runtime.connectionEpoch ||
        !equal(connection, source.read(Record.RuntimeConnection, key))
      )
        invalid()
      return true
    }
    if (key[1] === "runtime-tickets") {
      const ticket = Record.RuntimeTicket.parse(value)
      const registration = source.read(Record.RuntimeRegistration, Keys.runtime(ticket.runtimeID))
      if (registration.runtimeKind !== "member") return false
      const runtime = member(source, ticket.runtimeID)
      const consumed = ticket.consumed
      if (
        !equal(key, Keys.runtimeTicket(ticket.tokenHash)) ||
        ticket.accountID !== runtime.accountID ||
        ticket.registrationRevision > runtime.revision ||
        !consumed ||
        consumed.runtimeKind !== "member" ||
        consumed.runtimeID !== runtime.runtimeID ||
        consumed.orgID !== runtime.orgID ||
        consumed.deploymentIncarnation !== runtime.deploymentIncarnation ||
        consumed.publicKey !== runtime.publicKey ||
        consumed.accountID !== runtime.accountID ||
        consumed.deviceID !== runtime.deviceID ||
        consumed.state !== "active" ||
        consumed.revision > runtime.revision ||
        consumed.connectionEpoch > runtime.connectionEpoch ||
        !equal(ticket, source.read(Record.RuntimeTicket, key))
      )
        invalid()
      return true
    }
    return false
  }
}
