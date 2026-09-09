export function resolveRollbackDialogSeenKey(input: {
  sessionID?: string
  rollbackID?: string
  rollbackAck?: { rollbackID: string }
  pendingKey?: string
}): string | undefined {
  if (!input.sessionID || !input.rollbackID) return undefined
  const rollbackKey = `${input.sessionID}:${input.rollbackID}`
  if (input.rollbackAck?.rollbackID === input.rollbackID) return rollbackKey
  if (input.pendingKey === rollbackKey) return rollbackKey
  return undefined
}
