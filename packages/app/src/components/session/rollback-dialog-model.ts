export type RollbackDialogAction = "show" | "close" | "wait"

export function rollbackDialogAction(input: {
  rollbackKey?: string
  activeDialogID?: string
  rollbackDialogID?: string
  activeRollbackKey?: string
  seenKey?: string
}): RollbackDialogAction {
  const rollbackDialogActive = input.rollbackDialogID !== undefined && input.activeDialogID === input.rollbackDialogID

  if (rollbackDialogActive && input.rollbackKey !== input.activeRollbackKey) return "close"
  if (!input.rollbackKey || input.activeDialogID) return "wait"
  if (input.rollbackKey === input.seenKey) return "wait"
  return "show"
}
