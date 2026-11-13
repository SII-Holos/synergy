import type { MessageDescriptor } from "@lingui/core"

export const organizationHandoffTargetMessages = {
  choose: { id: "organization.handoff.targets.choose", message: "Choose a destination" },
  refresh: { id: "organization.handoff.targets.refresh", message: "Refresh destinations" },
  next: { id: "organization.handoff.targets.next", message: "Next page of destinations" },
  first: { id: "organization.handoff.targets.first", message: "First page of destinations" },
  empty: { id: "organization.handoff.targets.empty", message: "No destinations on this page." },
  unavailable: {
    id: "organization.handoff.targets.unavailable",
    message: "No destination on this page is ready. Check its connection or update Synergy, then refresh.",
  },
  offline: { id: "organization.handoff.targets.offline", message: "Offline" },
  incompatible: { id: "organization.handoff.targets.incompatible", message: "Update required" },
  pending: { id: "organization.handoff.targets.pending", message: "Registration pending" },
  revoked: { id: "organization.handoff.targets.revoked", message: "Access revoked" },
  directoryChecking: {
    id: "organization.handoff.targets.directoryChecking",
    message: "Checking the originally selected directory…",
  },
} satisfies Record<string, MessageDescriptor>
