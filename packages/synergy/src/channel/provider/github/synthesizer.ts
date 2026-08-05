import z from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "channel.github.synthesizer" })

export const GithubChannelPollState = z
  .object({
    repository: z.string(),
    baselineTimestampMs: z.number(),
    lastUpdatedAt: z.number(),
    seenIssues: z.record(z.string(), z.object({ number: z.number().int().positive(), updatedAt: z.string() })),
    seenPullRequests: z.record(
      z.string(),
      z.object({
        number: z.number().int().positive(),
        headSha: z.string(),
        state: z.enum(["open", "closed"]),
        draft: z.boolean(),
        updatedAt: z.string(),
      }),
    ),
    seenComments: z.record(
      z.string(),
      z.object({ id: z.number().int().positive(), issueNumber: z.number().int().positive(), createdAt: z.string() }),
    ),
  })
  .strict()
export type GithubChannelPollState = z.infer<typeof GithubChannelPollState>

export const GithubChannelEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue.opened"),
    repository: z.string(),
    issueNumber: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    sender: z.string(),
    createdAt: z.number(),
    issueId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("pull_request.opened"),
    repository: z.string(),
    pullNumber: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    sender: z.string(),
    headSha: z.string(),
    baseRef: z.string(),
    createdAt: z.number(),
    pullId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("pull_request.synchronize"),
    repository: z.string(),
    pullNumber: z.number().int().positive(),
    title: z.string(),
    headSha: z.string(),
    sender: z.string(),
    createdAt: z.number(),
    pullId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("pull_request.ready_for_review"),
    repository: z.string(),
    pullNumber: z.number().int().positive(),
    title: z.string(),
    headSha: z.string(),
    sender: z.string(),
    createdAt: z.number(),
    pullId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("comment.created"),
    repository: z.string(),
    issueNumber: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: z.string(),
    sender: z.string(),
    createdAt: z.number(),
    isPullRequest: z.boolean(),
    pullHeadSha: z.string().optional(),
  }),
])
export type GithubChannelEvent = z.infer<typeof GithubChannelEvent>

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function senderLogin(value: JsonRecord, fallback: string): string {
  return text(record(value.user).login) ?? text(record(value.sender).login) ?? fallback
}

export function initializeBaseline(repository: string, timestampMs = Date.now()): GithubChannelPollState {
  return GithubChannelPollState.parse({
    repository,
    baselineTimestampMs: timestampMs,
    lastUpdatedAt: timestampMs,
    seenIssues: {},
    seenPullRequests: {},
    seenComments: {},
  })
}

/**
 * Synthesize channel events from paginated GitHub list responses. The state
 * tracks per-repository watermarks and seen identities so each remote fact
 * produces exactly one event (dedup is then reinforced by the delivery key).
 */
export function synthesizeEvents(
  inputState: GithubChannelPollState,
  input: {
    repository: string
    issues: unknown[]
    pullRequests: unknown[]
    commentsByIssue: Record<number, unknown[]>
  },
): { state: GithubChannelPollState; events: GithubChannelEvent[] } {
  const state = structuredClone(GithubChannelPollState.parse(inputState))
  const events: GithubChannelEvent[] = []

  // --- Issues opened (non-PR issues only) ---
  for (const value of input.issues) {
    const issue = record(value)
    if (Object.keys(record(issue.pull_request)).length > 0) continue
    const number = positiveInteger(issue.number)
    const issueId = positiveInteger(issue.id)
    const createdAt = timestamp(issue.created_at)
    const updatedAt = text(issue.updated_at)
    if (!number || !issueId || createdAt === undefined || !updatedAt) continue

    const key = String(number)
    if (!state.seenIssues[key] && createdAt >= state.baselineTimestampMs) {
      state.seenIssues[key] = { number, updatedAt }
      events.push({
        kind: "issue.opened",
        repository: input.repository,
        issueNumber: number,
        title: text(issue.title) ?? `Issue #${number}`,
        body: text(issue.body) ?? "",
        sender: senderLogin(issue, "github"),
        createdAt,
        issueId,
      })
    }
    if (state.seenIssues[key]) state.seenIssues[key] = { number, updatedAt }
  }

  // --- Pull request opened / synchronize / ready_for_review ---
  for (const value of input.pullRequests) {
    const pullRequest = record(value)
    const number = positiveInteger(pullRequest.number)
    const pullId = positiveInteger(pullRequest.id)
    const createdAt = timestamp(pullRequest.created_at)
    const updatedAt = text(pullRequest.updated_at)
    const headSha = text(record(pullRequest.head).sha)
    const baseRef = text(record(pullRequest.base).ref)
    const stateValue = pullRequest.state === "open" || pullRequest.state === "closed" ? pullRequest.state : undefined
    const draft = pullRequest.draft === true
    if (!number || !pullId || createdAt === undefined || !updatedAt || !headSha || !stateValue) continue

    const key = String(number)
    const previous = state.seenPullRequests[key]
    if (!previous && stateValue === "open" && createdAt >= state.baselineTimestampMs) {
      state.seenPullRequests[key] = { number, headSha, state: stateValue, draft, updatedAt }
      // Draft PRs are excluded from auto-review; they only trigger once they
      // become ready for review (see the ready_for_review branch below).
      if (draft) continue
      events.push({
        kind: "pull_request.opened",
        repository: input.repository,
        pullNumber: number,
        title: text(pullRequest.title) ?? `PR #${number}`,
        body: text(pullRequest.body) ?? "",
        sender: senderLogin(pullRequest, "github"),
        headSha,
        baseRef: baseRef ?? "main",
        createdAt,
        pullId,
      })
      continue
    }
    if (previous && stateValue === "open") {
      // Draft → ready transition: the PR was recorded as a draft and is now
      // ready for review; emit a dedicated review-triggering event.
      if (previous.draft && !draft) {
        state.seenPullRequests[key] = { number, headSha, state: stateValue, draft, updatedAt }
        events.push({
          kind: "pull_request.ready_for_review",
          repository: input.repository,
          pullNumber: number,
          title: text(pullRequest.title) ?? `PR #${number}`,
          headSha,
          sender: senderLogin(pullRequest, "github"),
          createdAt: timestamp(updatedAt) ?? createdAt,
          pullId,
        })
        continue
      }
      // Head SHA change on a ready PR triggers a re-review. Draft PR pushes
      // only update state (no synchronize event).
      if (previous.headSha !== headSha && !draft) {
        state.seenPullRequests[key] = { number, headSha, state: stateValue, draft, updatedAt }
        events.push({
          kind: "pull_request.synchronize",
          repository: input.repository,
          pullNumber: number,
          title: text(pullRequest.title) ?? `PR #${number}`,
          headSha,
          sender: senderLogin(pullRequest, "github"),
          createdAt: timestamp(updatedAt) ?? createdAt,
          pullId,
        })
        continue
      }
    }
    if (previous) {
      state.seenPullRequests[key] = { number, headSha, state: stateValue, draft, updatedAt }
    }
  }

  // --- Issue/PR comments (the @synergy-agent trigger surface) ---
  for (const [issueNumberRaw, comments] of Object.entries(input.commentsByIssue)) {
    const issueNumber = Number(issueNumberRaw)
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue
    for (const value of comments) {
      const comment = record(value)
      const commentId = positiveInteger(comment.id)
      const createdAt = timestamp(comment.created_at)
      if (!commentId || createdAt === undefined) continue

      const key = String(commentId)
      if (state.seenComments[key]) continue
      state.seenComments[key] = { id: commentId, issueNumber, createdAt: new Date(createdAt).toISOString() }

      const body = text(comment.body) ?? ""
      if (!body) continue
      // Skip our own bot comments (posted via the app) — they would echo back.
      const sender = senderLogin(comment, "github")
      if (/\[bot\]$/i.test(sender)) continue

      const pullRequest = input.pullRequests.find((value) => positiveInteger(record(value).number) === issueNumber)
      events.push({
        kind: "comment.created",
        repository: input.repository,
        issueNumber,
        commentId,
        body,
        sender,
        createdAt,
        isPullRequest: pullRequest !== undefined,
        ...(pullRequest ? { pullHeadSha: text(record(record(pullRequest).head).sha) } : {}),
      })
    }
  }

  // Advance the watermark from every observed item.
  const watermarks = [
    ...input.issues.map((item) => timestamp(record(item).updated_at)),
    ...input.pullRequests.map((item) => timestamp(record(item).updated_at)),
    ...Object.values(input.commentsByIssue)
      .flat()
      .map((item) => timestamp(record(item).created_at)),
  ].filter((value): value is number => value !== undefined)
  const nextWatermark = watermarks.reduce((maximum, value) => Math.max(maximum, value), state.lastUpdatedAt)
  state.lastUpdatedAt = Math.max(state.lastUpdatedAt, nextWatermark)

  // Bound state growth: keep open PRs plus the 5k most recent closed, and
  // keep at most 10k comment IDs (oldest dropped).
  const openPullRequests = Object.entries(state.seenPullRequests).filter(
    ([, pullRequest]) => pullRequest.state === "open",
  )
  const closedPullRequests = Object.entries(state.seenPullRequests)
    .filter(([, pullRequest]) => pullRequest.state === "closed")
    .sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 5_000)
  state.seenPullRequests = Object.fromEntries([...openPullRequests, ...closedPullRequests])

  const commentEntries = Object.entries(state.seenComments)
    .sort(([, left], [, right]) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 10_000)
  state.seenComments = Object.fromEntries(commentEntries)

  const parsedState = GithubChannelPollState.parse(state)
  if (events.length > 0) {
    log.info("synthesized github channel events", { repository: input.repository, count: events.length })
  }
  return { state: parsedState, events }
}
