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
 * - Comments only trigger on an explicit mention of the GitHub App's slug
 *   (e.g. `@my-bot` for an app whose slug is `my-bot`) and require
 *   `autoRespond`. Replies are posted as the App, so the mention name must
 *   equal the App slug — the same identity users see on the bot's comments.
 * - Issue openings auto-respond when `autoRespond` is on.
 * - PR opened/synchronize/ready_for_review auto-review when `autoReview` is
 *   on. Draft PRs never produce events (handled in the synthesizer), so no
 *   draft check is needed here.
 */
export function gateGithubEvent(
  event: GithubChannelEvent,
  input: {
    autoReview: boolean
    autoRespond: boolean
    /** The GitHub App slug users @-mention (resolved from `GET /app`, or configured). */
    mention?: string
  },
): GithubEventGate {
  switch (event.kind) {
    case "comment.created":
      if (!input.autoRespond) return { kind: "skip", reason: "autoRespond disabled" }
      if (!input.mention) return { kind: "skip", reason: "mention name unavailable" }
      // Escape the slug so regex metacharacters are treated literally, and
      // use a negative lookahead so similar handles such as @slug-extra do
      // not match.
      const escaped = input.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      if (!new RegExp(`@${escaped}(?![\\w-])`, "i").test(event.body)) {
        return { kind: "skip", reason: `no @${input.mention} mention` }
      }
      return { kind: "deliver" }
    case "issue.opened":
      if (!input.autoRespond) return { kind: "skip", reason: "autoRespond disabled" }
      return { kind: "deliver" }
    case "pull_request.opened":
    case "pull_request.synchronize":
    case "pull_request.ready_for_review":
      if (!input.autoReview) return { kind: "skip", reason: "autoReview disabled" }
      return { kind: "deliver" }
  }
}
