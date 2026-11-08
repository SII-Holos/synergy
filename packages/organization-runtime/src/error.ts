import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export class OrganizationRuntimeError extends Error {
  readonly data: OrganizationProtocol.Error
  constructor(data: OrganizationProtocol.Error) {
    super(data.message)
    this.name = "OrganizationRuntimeError"
    this.data = OrganizationProtocol.Error.parse(data)
  }
}
