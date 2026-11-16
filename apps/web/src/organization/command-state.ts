import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Persist } from "@/utils/persist"

const Request = Command.CreateRequest.or(Command.InputRequest).or(Command.ControlRequest)
export type OrganizationPendingCommand = Command.CreateRequest | Command.InputRequest | Command.ControlRequest
type CommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function createOrganizationCommandState(storage: CommandStorage, connection: string, owner: string) {
  const target = Persist.connection(connection, `organization-command:${owner}`)
  const key = `${target.storage}:${target.key}`
  function pending() {
    const value = storage.getItem(key)
    if (!value) return
    return Request.parse(JSON.parse(value))
  }
  return {
    pending,
    begin(value: OrganizationPendingCommand) {
      const request = Request.parse(value)
      const previous = pending()
      if (previous && JSON.stringify(previous) !== JSON.stringify(request))
        throw new Error("Check the pending request before submitting another operation")
      storage.setItem(key, JSON.stringify(request))
      return request
    },
    clear(requestID: string) {
      if (pending()?.requestID === requestID) storage.removeItem(key)
    },
  }
}
