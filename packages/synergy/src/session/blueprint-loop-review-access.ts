import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import { Session } from "."
import type { Info } from "./types"

export namespace BlueprintLoopReviewAccess {
  export interface Input {
    agent: string
    reviewSessionID: string
    reviewSession?: Info
  }

  export interface Context {
    loop: BlueprintLoopInfo
    executionSession: Info
    reviewSession: Info
  }

  export async function resolve(input: Input): Promise<Context | undefined> {
    const reviewSession = input.reviewSession ?? (await Session.get(input.reviewSessionID).catch(() => undefined))
    if (!reviewSession || reviewSession.id !== input.reviewSessionID) return undefined
    if (reviewSession.blueprint?.loopRole !== "audit" || !reviewSession.blueprint.loopID) return undefined
    if (reviewSession.cortex?.agent !== input.agent) return undefined

    const executionSessionID = reviewSession.cortex.parentSessionID
    if (!executionSessionID) return undefined
    const executionSession = await Session.get(executionSessionID).catch(() => undefined)
    if (!executionSession) return undefined
    if (executionSession.blueprint?.loopRole !== "execution") return undefined
    if (executionSession.blueprint.loopID !== reviewSession.blueprint.loopID) return undefined

    const loop = await BlueprintLoopStore.get(executionSession.scope.id, reviewSession.blueprint.loopID).catch(
      () => undefined,
    )
    if (!loop || loop.status !== "auditing") return undefined
    if (loop.sessionID !== executionSession.id) return undefined
    if (loop.auditSessionID !== reviewSession.id) return undefined
    if ((loop.auditAgent || "supervisor") !== input.agent) return undefined

    return { loop, executionSession, reviewSession }
  }

  export async function assertForTarget(input: Input & { targetSessionID: string; action: "approve" | "reject" }) {
    const context = await resolve(input)
    if (!context || context.executionSession.id !== input.targetSessionID) {
      throw new Error(`Only the recorded reviewer session may ${input.action} this BlueprintLoop review`)
    }
    return context
  }
}
