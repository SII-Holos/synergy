import { Session } from "."
import type { Info } from "./types"

export namespace LightLoopReviewAccess {
  export interface Input {
    agent: string
    reviewSessionID: string
    reviewSession?: Info
  }

  export interface Context {
    parent: Info & { workflow: Extract<Info["workflow"], { kind: "lightloop" }> }
    reviewSession: Info
  }

  export async function resolve(input: Input): Promise<Context | undefined> {
    if (input.agent !== "lightloop-reviewer") return undefined
    const reviewSession = input.reviewSession ?? (await Session.get(input.reviewSessionID).catch(() => undefined))
    if (!reviewSession || reviewSession.id !== input.reviewSessionID) return undefined
    if (reviewSession.cortex?.agent !== "lightloop-reviewer") return undefined

    const parentSessionID = reviewSession.cortex.parentSessionID
    if (!parentSessionID) return undefined

    const parent = await Session.get(parentSessionID).catch(() => undefined)
    if (parent?.workflow?.kind !== "lightloop") return undefined
    if (parent.workflow.stopRequest?.reviewSessionID !== reviewSession.id) return undefined

    return { parent: parent as Context["parent"], reviewSession }
  }

  export async function assertForTarget(input: Input & { targetSessionID: string; action: "approve" | "reject" }) {
    const context = await resolve(input)
    if (!context || context.parent.id !== input.targetSessionID) {
      throw new Error(`Only the recorded reviewer session may ${input.action} this stop request`)
    }
    return context
  }
}
