export const organizationMemberMessages = {
  reset: { id: "organization.members.reset", message: "Reset password" },
  resetTitle: { id: "organization.members.resetTitle", message: "Create password reset link" },
  resetHint: {
    id: "organization.members.resetHint",
    message: "Create a one-time password reset link. Completing the reset revokes this member's existing sign-ins.",
  },
  createReset: { id: "organization.members.createReset", message: "Create reset link" },
  resetLink: { id: "organization.members.resetLink", message: "Password reset link" },
  resetFor: { id: "organization.members.resetFor", message: "Password reset for {name}" },
  sharePrivately: {
    id: "organization.members.sharePrivately",
    message: "Share this link privately with the account owner.",
  },
  expires: { id: "organization.members.expires", message: "Expires {date}" },
  done: { id: "organization.members.done", message: "Done" },
  account: { id: "organization.account.title", message: "Account" },
  invitations: { id: "organization.invitations.title", message: "Invitations" },
  invitationsHint: {
    id: "organization.invitations.hint",
    message: "Review invitation status. Links are shown only when they are created.",
  },
  invitationsEmpty: { id: "organization.invitations.empty", message: "No invitations to show." },
  revoke: { id: "organization.invitations.revoke", message: "Revoke invitation" },
  revokeHint: {
    id: "organization.invitations.revokeHint",
    message: "This invitation will stop accepting new members. Existing members keep their access.",
  },
  invitationIdentity: { id: "organization.invitations.identity", message: "Invitation {id}" },
  issuedBy: { id: "organization.invitations.issuedBy", message: "Issued by account {id}" },
  invitationOpen: { id: "organization.invitations.open", message: "Available" },
  invitationConsumed: { id: "organization.invitations.consumed", message: "Used" },
  invitationRevoked: { id: "organization.invitations.revoked", message: "Revoked" },
  invitationExpired: { id: "organization.invitations.expired", message: "Expired" },
  invitationInvalidated: { id: "organization.invitations.invalidated", message: "Issuer access changed" },
  leave: { id: "organization.account.leave", message: "Leave organization" },
  leaveHint: {
    id: "organization.account.leaveHint",
    message:
      "Your membership and organization access will end. Your previous contributions remain attributed to you. Rejoining requires a new invitation.",
  },
  membership: { id: "organization.account.membership", message: "Membership" },
  lastOwner: {
    id: "organization.account.lastOwner",
    message: "Transfer ownership to another member before leaving this organization.",
  },
  consumed: {
    id: "organization.invitations.alreadyUsed",
    message: "This invitation has already been used. Manage the member's access in Members.",
  },
}
