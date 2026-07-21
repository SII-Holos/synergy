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

  /**
   * Resolve the review context. Validates that:
   * 1. The review session exists and is a Cortex-delegated child of an execution session
   * 2. The execution parent has a lightloop workflow with a matching stopRequest
   * 3. The actual execution agent and review agent differ (no self-review)
   * 4. The review session's Cortex agent matches the workflow's recorded reviewAgent
   */
  export async function resolve(input: Input): Promise<Context | undefined> {
    const reviewSession = input.reviewSession ?? (await Session.get(input.reviewSessionID).catch(() => undefined))
    if (!reviewSession || reviewSession.id !== input.reviewSessionID) return undefined

    const parentSessionID = reviewSession.cortex?.parentSessionID
    if (!parentSessionID) return undefined

    const parent = await Session.get(parentSessionID).catch(() => undefined)
    if (parent?.workflow?.kind !== "lightloop") return undefined
    if (parent.workflow.stopRequest?.reviewSessionID !== reviewSession.id) return undefined

    // Validate reviewer agent matches the workflow's recorded reviewAgent
    const expectedReviewer = parent.workflow.reviewAgent ?? "lightloop-reviewer"
    if (reviewSession.cortex?.agent !== expectedReviewer) return undefined

    // Plugin-owned: validate no self-review (execution !== reviewer agent)
    if (parent.workflow.pluginOwner) {
      const executionAgent = parent.workflow.executionAgent
      const reviewerAgent = reviewSession.cortex?.agent
      if (!executionAgent || !reviewerAgent) return undefined
      if (executionAgent === reviewerAgent) return undefined // reject self-review
    }

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
