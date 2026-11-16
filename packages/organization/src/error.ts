import { NamedError } from "@ericsanchezok/synergy-util/error"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export const OrganizationError = NamedError.create("OrganizationError", OrganizationProtocol.Error)

export function fail(code: OrganizationProtocol.Error["code"], message: string, currentRevision?: number): never {
  throw new OrganizationError({ code, message, currentRevision, outcome: "not_dispatched", retryable: false })
}

export function revision(expected: number, current: number) {
  if (expected !== current) fail("REVISION_CONFLICT", "The record changed; reload before retrying", current)
}

export function errorStatus(code: OrganizationProtocol.Error["code"]) {
  switch (code) {
    case "INVALID_REQUEST":
      return 400
    case "AUTHENTICATION_REQUIRED":
      return 401
    case "PERMISSION_DENIED":
      return 403
    case "NOT_FOUND":
      return 404
    case "SERVICE_UNAVAILABLE":
    case "RUNTIME_OFFLINE":
      return 503
    case "COMMAND_OUTCOME_UNKNOWN":
      return 504
    default:
      return 409
  }
}
