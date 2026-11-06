import { RuntimeContext } from "../lifecycle/context"
import { SessionContextContributions } from "./context-contributions"
export const RECALL_TIMEOUT_MS = SessionContextContributions.DEFAULT_TIMEOUT_MS
const runtimeState = RuntimeContext.state(() => ({
  recallCache: new Map<string, SessionContextContributions.Collected>(),
}))
export function cacheResult(sessionID: string, result: SessionContextContributions.Collected) {
  const instanceState = runtimeState()

  instanceState.recallCache.set(sessionID, result)
}
export function getCachedResult(sessionID: string) {
  const instanceState = runtimeState()

  return instanceState.recallCache.get(sessionID)
}
export function evictRecallCache(sessionID: string) {
  const instanceState = runtimeState()

  instanceState.recallCache.delete(sessionID)
}
