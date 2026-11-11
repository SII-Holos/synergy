import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"

export class OrganizationCommandReceiptError extends Error {
  readonly code = "COMMAND_OUTCOME_UNKNOWN"
  readonly outcome = "unknown"
  constructor() {
    super("The command receipt could not be confirmed")
    this.name = "OrganizationCommandReceiptError"
  }
}
export function organizationCommandAccepted(
  request: Command.CreateRequest | Command.InputRequest | Command.ControlRequest | Command.DecisionRequest,
  value: unknown,
  accountID: string,
): Command.Accepted {
  const result = Command.Accepted.safeParse(value)
  if (!result.success) throw new OrganizationCommandReceiptError()
  const accepted = result.data
  const permit = accepted.permit
  if (
    permit.orgID !== request.orgID ||
    permit.requestID !== request.requestID ||
    permit.projectID !== request.projectID ||
    permit.runtimeID !== request.runtimeID ||
    permit.actor.subjectID !== accountID ||
    ("sessionID" in request && permit.sessionID !== request.sessionID)
  )
    throw new OrganizationCommandReceiptError()
  if ("creation" in request && accepted.effect.kind === "session") return accepted
  if ("input" in request && accepted.effect.kind === "inbox" && accepted.effect.mode === request.input.mode)
    return accepted
  if (
    "control" in request &&
    accepted.effect.kind === "control" &&
    accepted.effect.operation === request.control.operation &&
    (request.control.operation !== "cancel" ||
      (accepted.effect.operation === "cancel" && accepted.effect.runID === request.control.runID))
  )
    return accepted
  if (
    "decision" in request &&
    accepted.effect.kind === "decision" &&
    accepted.effect.requestID === request.decision.requestID &&
    accepted.effect.sourceSessionID === (request.decision.sourceSessionID ?? request.sessionID)
  )
    return accepted
  throw new OrganizationCommandReceiptError()
}
