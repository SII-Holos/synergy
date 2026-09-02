import { SessionToolContext } from "../session/tool-context"
import type { Info as SessionInfo } from "../session/types"
import { BlueprintLoopReviewAccess } from "./review-access"
import { BlueprintLoopStore } from "./loop-store"

/**
 * P9 source inversion: the L1 session tool resolver checks blueprint review
 * and stop access through this registered adapter instead of importing the
 * blueprint product domain directly. Loaded through
 * src/product-registration.ts.
 */
export function registerBlueprintToolAccess() {
  SessionToolContext.registerBlueprintAccess({
    async canUseReviewTools(agent, reviewSessionID, reviewSession) {
      if (!reviewSession) return false
      return (
        (await BlueprintLoopReviewAccess.resolve({
          agent,
          reviewSessionID,
          reviewSession,
        })) !== undefined
      )
    },
    async canStopLoop(session: SessionInfo) {
      if (!session.id || session.blueprint?.loopRole !== "execution" || !session.blueprint.loopID) return false
      const loop = await BlueprintLoopStore.get(session.scope.id, session.blueprint.loopID).catch(() => undefined)
      return loop?.status === "running" && loop.sessionID === session.id
    },
  })
}
