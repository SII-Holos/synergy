export function isNewSessionView(input: {
  hasSessionId: boolean
  resolvingHome: boolean
  isGlobal: boolean
  messageCount: number
}) {
  if (!input.hasSessionId) return true
  if (input.resolvingHome) return false
  if (input.isGlobal && input.messageCount === 0) return true
  return false
}
