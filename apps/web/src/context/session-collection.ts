type SessionIdentity = { id: string }

export function findSessionIndex(sessions: readonly SessionIdentity[], sessionID: string): number {
  return sessions.findIndex((session) => session.id === sessionID)
}

export function findSessionByID<T extends SessionIdentity>(sessions: readonly T[], sessionID: string): T | undefined {
  const index = findSessionIndex(sessions, sessionID)
  return index === -1 ? undefined : sessions[index]
}
