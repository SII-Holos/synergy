import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function sessionActivityTime(session: Pick<Session, "time">): number {
  return session.time.updated ?? session.time.created
}

export function sortChildSessionsByActivity(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a) || b.id.localeCompare(a.id))
}

export function childSessionsForParent(sessions: readonly Session[], parentID: string | undefined): Session[] {
  if (!parentID) return []
  return sortChildSessionsByActivity(sessions.filter((session) => session.parentID === parentID))
}
