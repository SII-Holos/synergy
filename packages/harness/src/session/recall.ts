import { SessionContextContributions } from "./context-contributions"
export const RECALL_TIMEOUT_MS = SessionContextContributions.DEFAULT_TIMEOUT_MS
const recallCache = new Map<string, SessionContextContributions.Collected>()
export function cacheResult(sessionID: string, result: SessionContextContributions.Collected) {
  recallCache.set(sessionID, result)
}
export function getCachedResult(sessionID: string) {
  return recallCache.get(sessionID)
}
export function evictRecallCache(sessionID: string) {
  recallCache.delete(sessionID)
}
