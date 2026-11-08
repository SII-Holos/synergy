import type { OrganizationDesktop } from "@ericsanchezok/synergy-organization-protocol"

const messages = {
  invalid_request: "The organization request is invalid.",
  invalid_response: "The organization returned an invalid response.",
  identity_changed: "The organization identity changed. Connect to the organization again.",
  cancelled: "Organization authorization was cancelled.",
  expired: "Organization authorization expired. Start again.",
  reauthorization_required: "Authorize this organization again before continuing.",
  signed_out: "This organization account is signed out.",
  revocation_pending: "Local access is disabled. Retry sign out to revoke the organization login.",
  credentials_unavailable: "Unlock the system credential store, then retry.",
  credentials_invalid: "The saved organization credential could not be verified. Existing data has been preserved.",
  storage_unavailable: "Organization credentials could not be read or saved. Existing data has been preserved.",
  unavailable: "The organization could not be reached. Retry when it is available.",
  untrusted_sender: "This page cannot access organization connections.",
  request_in_progress: "This organization request is already in progress.",
} as const satisfies Record<OrganizationDesktop.ErrorCode, string>

export class DesktopOrganizationError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = "DesktopOrganizationError"
  }
}
