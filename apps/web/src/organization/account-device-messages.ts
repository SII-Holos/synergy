import type { MessageDescriptor } from "@lingui/core"

export const organizationDeviceMessages = {
  title: { id: "organization.devices.title", message: "My computers" },
  hint: {
    id: "organization.devices.hint",
    message:
      "Inspect preparation left by cancelled moves on computers registered to your account. These checks do not open conversations or start work.",
  },
  empty: { id: "organization.devices.empty", message: "No computers belonging to this account on this page." },
  refresh: { id: "organization.devices.refresh", message: "Refresh computers" },
  next: { id: "organization.devices.next", message: "Next computers" },
  first: { id: "organization.devices.first", message: "First computers" },
  active: { id: "organization.devices.active", message: "Registered" },
  pending: { id: "organization.devices.pending", message: "Registration pending" },
  revoked: { id: "organization.devices.revoked", message: "Access revoked" },
  recovery: {
    id: "organization.devices.recovery",
    message: "Only the original Synergy installation on this computer can finish cleaning up its cancelled moves.",
  },
  find: { id: "organization.devices.find", message: "Find cancelled moves" },
  moves: { id: "organization.devices.moves", message: "Cancelled moves" },
  noMoves: { id: "organization.devices.noMoves", message: "No cancelled moves on this page." },
  nextMoves: { id: "organization.devices.nextMoves", message: "Next moves" },
  firstMoves: { id: "organization.devices.firstMoves", message: "First moves" },
  move: { id: "organization.devices.move", message: "Move {reference}" },
  inspect: { id: "organization.devices.inspect", message: "Inspect preparation" },
  details: { id: "organization.devices.details", message: "Original move details" },
  handoff: { id: "organization.devices.handoff", message: "Move reference" },
  session: { id: "organization.devices.session", message: "Conversation reference" },
} satisfies Record<string, MessageDescriptor>

export const organizationDirectoryMessages = {
  unavailable: {
    id: "organization.handoff.directory.unavailable",
    message: "The name of the originally selected directory has not been verified here.",
  },
  hint: {
    id: "organization.handoff.directory.hint",
    message:
      "The original destination directory must be identified before its versions can be accepted. Your computer's current default folder cannot replace it.",
  },
} satisfies Record<string, MessageDescriptor>
