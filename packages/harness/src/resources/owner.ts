export async function sessionResourceOwner(sessionID: string): Promise<string> {
  const { Session } = await import("../session")
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const session = await Session.get(current)
    if (!session.parentID) return current
    current = session.parentID
  }
  throw new Error("Cyclic session resource ownership")
}
