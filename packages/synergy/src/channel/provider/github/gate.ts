import type { GithubChannelEvent } from "./synthesizer"

export type GithubEventGate =
  | {
      kind: "deliver"
    }
  | {
      kind: "skip"
      reason: string
    }

/**
 * Decide whether a synthesized GitHub event should be delivered to the
 * channel conversation pipeline.
 *
 * - Comments only trigger on an explicit @synergy mention (the summon
 *   surface) and require `autoRespond`.
 * - Issue openings auto-respond when `autoRespond` is on.
 * - PR opened/synchronize auto-review when `autoReview` is on.
 */
export function gateGithubEvent(
  event: GithubChannelEvent,
  input: {
    autoReview: boolean
    autoRespond: boolean
  },
): GithubEventGate {
  switch (event.kind) {
    case "comment.created":
      if (!input.autoRespond) return { kind: "skip", reason: "autoRespond disabled" }
      if (!/@synergy\b/i.test(event.body)) {
        return { kind: "skip", reason: "no @synergy mention" }
      }
      return { kind: "deliver" }
    case "issue.opened":
      if (!input.autoRespond) return { kind: "skip", reason: "autoRespond disabled" }
      return { kind: "deliver" }
    case "pull_request.opened":
    case "pull_request.synchronize":
      if (!input.autoReview) return { kind: "skip", reason: "autoReview disabled" }
      return { kind: "deliver" }
  }
}
