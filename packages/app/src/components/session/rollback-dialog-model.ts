export type RollbackDialogAction = "show" | "close" | "wait"

export function rollbackDialogAction(input: {
  rollbackKey?: string
  activeDialogID?: string
  rollbackDialogID?: string
  presentedKey?: string
  dismissedKey?: string
}): RollbackDialogAction {
  const rollbackDialogActive = input.rollbackDialogID !== undefined && input.activeDialogID === input.rollbackDialogID

  if (rollbackDialogActive && input.rollbackKey !== input.presentedKey) return "close"
  if (!input.rollbackKey || input.activeDialogID) return "wait"
  if (input.rollbackKey === input.presentedKey || input.rollbackKey === input.dismissedKey) return "wait"
  return "show"
}
