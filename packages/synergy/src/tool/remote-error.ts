import { SynergyLinkError } from "@ericsanchezok/synergy-link-protocol"

export type SynergyLinkTransportFailureReason = "disconnected" | "transport_liveness_lost"

export class SynergyLinkRemoteError extends Error {
  constructor(
    readonly code: SynergyLinkError.Code,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "SynergyLinkRemoteError"
  }
}
