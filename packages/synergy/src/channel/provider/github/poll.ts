import { Log } from "@/util/log"
import { SessionRetry } from "@/session/retry"
import { GitHubChannelAuth, GitHubApiError, type RequestDescriptor } from "./api"
import { GithubChannelPollState, initializeBaseline, synthesizeEvents, type GithubChannelEvent } from "./synthesizer"
import { record, positiveInteger } from "./record"
import { registerBodyChat, registerCommentChat } from "./reactions"
import { gateGithubEvent } from "./gate"
import type { ChannelHost } from "../../host"
import type { MessageContext } from "../../types"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { externalIdentityHash } from "../../../util/identity"
import { Lock } from "@/util/lock"

const log = Log.create({ service: "channel.github.poll" })

/** Lookback window used on the very first poll of a repository so events that
 * happened while the channel was disabled, failing, or just being configured
 * are recovered instead of lost forever. */
const FIRST_POLL_LOOKBACK_MS = 24 * 60 * 60 * 1_000

type RepositoryParts = { owner: string; repo: string }
type PollPage<T> = { data: T; headers: Headers }

function splitRepository(repository: string): RepositoryParts {
  const [owner, repo, ...extra] = repository.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error(`Invalid GitHub repository name: ${repository}`)
  return { owner, repo }
}

function nextPageUrl(headers: Headers): string | undefined {
  const link = headers.get("link")
  if (!link) return undefined
  for (const entry of link.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/)
    if (match?.[2].split(/\s+/).includes("next")) return match[1]
  }
  return undefined
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index]!)
      }
    }),
  )
  return results
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError")
}

async function readPollState(accountHash: string, repository: string): Promise<GithubChannelPollState | undefined> {
  const raw = await Storage.read<unknown>(StoragePath.githubChannelPollState(accountHash, repository)).catch(
    () => undefined,
  )
  if (raw === undefined) return undefined
  const parsed = GithubChannelPollState.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

async function writePollState(accountHash: string, repository: string, state: GithubChannelPollState): Promise<void> {
  const key = StoragePath.githubChannelPollState(accountHash, repository)
  using _ = await Lock.write(`github-channel:poll-state:${accountHash}:${repository}`)
  await Storage.write(key, state)
}

/**
 * Poll one repository for issues, pull requests, and comments and deliver
 * synthesized events as channel conversation messages. Runs on the configured
 * interval (default 5 minutes; lower frequency than the legacy integration).
 */
export async function pollRepository(input: {
  accountId: string
  accountHash: string
  repository: string
  intervalMs: number
  pageSize: number
  maxPages: number
  autoReview: boolean
  autoRespond: boolean
  /** GitHub App slug users @-mention (resolved from the App identity). */
  mention?: string
  signal: AbortSignal
  host: ChannelHost.Instance
}): Promise<void> {
  const { owner, repo } = splitRepository(input.repository)

  const appId = Number(process.env.SYNERGY_GITHUB_APP_ID)
  const privateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? ""
  const jwt = GitHubChannelAuth.generateJWT({ appId, privateKey })
  const installation = await GitHubChannelAuth.GitHubClient.send<unknown>(
    GitHubChannelAuth.GitHubClient.resolveInstallation({ owner, repo, jwt: jwt as string }),
    input.signal,
  )
  const installationId = positiveInteger(record(installation).id)
  if (!installationId) throw new Error(`GitHub App installation for ${input.repository} has no valid ID`)
  const installationToken = await GitHubChannelAuth.getInstallationToken(installationId, input.signal)

  let state = await readPollState(input.accountHash, input.repository)
  // On the very first poll (fresh state) the baseline is "now", so events
  // that happened while the channel was disabled, failing, or just being
  // set up would fall outside the normal overlap window and be lost forever.
  // Look back 24h instead: comments are deduped by ID with no baseline gate,
  // so old @-mention summons are recovered, while issue/PR opened events keep
  // their baseline gate and are not re-emitted for stale items.
  const isFirstPoll = state === undefined
  if (!state) {
    state = initializeBaseline(input.repository)
    await writePollState(input.accountHash, input.repository, state)
  }

  const overlapMs = Math.max(input.intervalMs, 5 * 60 * 1_000)
  const lookbackMs = isFirstPoll ? FIRST_POLL_LOOKBACK_MS : overlapMs
  const since = new Date(Math.max(0, state.lastUpdatedAt - lookbackMs)).toISOString()

  // 1. Issues/PRs updated since the watermark (PR-shaped issues carry a pull_request key).
  const issuePage = await fetchPages({
    descriptor: GitHubChannelAuth.GitHubClient.listRepositoryIssues({
      owner,
      repo,
      since,
      pageSize: input.pageSize,
      installationToken,
    }),
    installationToken,
    maxPages: input.maxPages,
    intervalMs: input.intervalMs,
    signal: input.signal,
    extract: (data) => (Array.isArray(data) ? data : []),
  })
  const issueItems = issuePage.items
  let truncated = issuePage.truncated

  // 2. Pull request details for PR-shaped issue entries (need head SHA + base ref).
  const pullNumbers = new Set(
    issueItems.flatMap((item) => {
      const itemRecord = record(item)
      return Object.keys(record(itemRecord.pull_request)).length > 0 && positiveInteger(itemRecord.number)
        ? [positiveInteger(itemRecord.number)!]
        : []
    }),
  )
  const pullRequests = await mapConcurrent([...pullNumbers], 8, (pullNumber) =>
    GitHubChannelAuth.GitHubClient.send<unknown>(
      GitHubChannelAuth.GitHubClient.getPullRequest({ owner, repo, pullNumber, installationToken }),
      input.signal,
    ),
  )

  // 3. Comments on every issue/PR in the window (the App-slug mention trigger surface).
  const commentTargets = new Set([
    ...issueItems.flatMap((item) => {
      const number = positiveInteger(record(item).number)
      return number ? [number] : []
    }),
  ])
  const commentsByIssue: Record<number, unknown[]> = {}
  await mapConcurrent([...commentTargets], 4, async (issueNumber) => {
    const comments = await fetchPages({
      descriptor: GitHubChannelAuth.GitHubClient.listIssueComments({
        owner,
        repo,
        issueNumber,
        since,
        installationToken,
      }),
      installationToken,
      maxPages: input.maxPages,
      intervalMs: input.intervalMs,
      signal: input.signal,
      extract: (data) => (Array.isArray(data) ? data : []),
    })
    commentsByIssue[issueNumber] = comments.items
    if (comments.truncated) truncated = true
  })

  // 4. Synthesize events (dedup via seen state) and deliver each as a conversation message.
  const { state: nextState, events } = synthesizeEvents(state, {
    repository: input.repository,
    issues: issueItems,
    pullRequests,
    commentsByIssue,
  })
  if (truncated) {
    // A truncated read means items beyond the page cap exist in the window.
    // Keep the old watermark so the next poll re-reads from the same point
    // and picks up the omitted items; seen state still advances so already
    // processed events are not re-delivered.
    nextState.lastUpdatedAt = state.lastUpdatedAt
    log.warn("github poll truncated; watermark preserved for the next poll", { repository: input.repository })
  }
  await writePollState(input.accountHash, input.repository, nextState)

  for (const event of events) {
    await deliverEvent(input, event)
  }
}

function eventIssueNumber(event: GithubChannelEvent): number {
  switch (event.kind) {
    case "issue.opened":
    case "comment.created":
      return event.issueNumber
    case "pull_request.opened":
    case "pull_request.synchronize":
    case "pull_request.ready_for_review":
      return event.pullNumber
  }
}

async function deliverEvent(
  input: {
    accountId: string
    repository: string
    autoReview: boolean
    autoRespond: boolean
    mention?: string
    host: ChannelHost.Instance
  },
  event: GithubChannelEvent,
): Promise<void> {
  // Gate events by the account toggles (autoReview / autoRespond) and the
  // App-slug mention requirement for comments.
  const gate = gateGithubEvent(event, {
    autoReview: input.autoReview,
    autoRespond: input.autoRespond,
    mention: input.mention,
  })
  if (gate.kind === "skip") {
    log.info("github event skipped", {
      repository: input.repository,
      kind: event.kind,
      reason: gate.reason,
    })
    return
  }

  const issueNumber = eventIssueNumber(event)
  const chatId = `${input.repository}#${issueNumber}`
  const scopeKey = chatId
  const messageId = eventMessageId(event)

  // Register the reaction target so the provider can attach status reactions
  // (e.g. 👀 ACK / 🚀 done) to the real GitHub object: comments map to the
  // comment ID, synthetic events (issue/PR opened, synchronize, ready) map
  // to the issue/PR body.
  if (event.kind === "comment.created") {
    registerCommentChat(String(event.commentId), chatId)
  } else {
    registerBodyChat(messageId, chatId)
  }

  const isComment = event.kind === "comment.created"
  const ctx: MessageContext = {
    channelType: "github",
    accountId: input.accountId,
    chatId,
    chatType: "group",
    chatName: chatId,
    senderId: event.sender,
    senderName: event.sender,
    text: eventPrompt(event),
    messageId,
    timestamp: event.createdAt,
    // comment.created events only reach this point after the gate confirmed
    // an explicit bot mention, so mark them as mentioned to let the command
    // parser strip the @handle from the agent prompt. The raw comment body is
    // supplied as commandText (the prompt wraps it in event context) and the
    // bot handle is listed in mentions so slash commands like
    // `@synergy-agent /new` parse correctly.
    wasMentioned: isComment,
    ...(isComment
      ? {
          commandText: event.body,
          mentions: [{ key: "github", name: input.mention ?? event.sender }],
          replyToMessageId: String(event.commentId),
        }
      : {}),
    scopeKey,
  }

  const result = await input.host.conversations.receive(ctx)
  if (!result.accepted) {
    log.info("github event not accepted by channel", {
      repository: input.repository,
      messageId,
      reason: result.reason,
    })
    return
  }
  // Track execution so account drain can wait for in-flight generations.
  result.execution.catch((error) => {
    log.warn("github event execution failed", { repository: input.repository, messageId, error })
  })
}

function eventMessageId(event: GithubChannelEvent): string {
  switch (event.kind) {
    case "issue.opened":
      return `issue-${event.issueId}`
    case "pull_request.opened":
      return `pr-opened-${event.pullId}`
    case "pull_request.synchronize":
      return `pr-sync-${event.pullId}-${event.headSha.slice(0, 12)}`
    case "pull_request.ready_for_review":
      return `pr-ready-${event.pullId}-${event.headSha.slice(0, 12)}`
    case "comment.created":
      // Use the raw numeric comment ID so status reactions (e.g. 👀) land on
      // the real GitHub comment.
      return String(event.commentId)
    default:
      return "github-event"
  }
}

function eventPrompt(event: GithubChannelEvent): string {
  switch (event.kind) {
    case "issue.opened":
      return [
        `New GitHub issue opened in ${event.repository} by @${event.sender}:`,
        ``,
        `**#${event.issueNumber}: ${event.title}**`,
        ``,
        event.body || "_no description_",
        ``,
        `Investigate the issue against the checked-out repository and respond with a diagnosis. If it is a clear bug, implement the smallest root-cause fix and report the commit.`,
      ].join("\n")
    case "pull_request.opened":
      return [
        `New GitHub pull request opened in ${event.repository} by @${event.sender}:`,
        ``,
        `**#${event.pullNumber}: ${event.title}**`,
        ``,
        event.body || "_no description_",
        ``,
        `Review this pull request against its base branch (${event.baseRef}). Inspect the diff in the checkout, run the relevant tests and type checks, and report only actionable findings with precise file and line evidence.`,
      ].join("\n")
    case "pull_request.synchronize":
      return [
        `GitHub pull request #${event.pullNumber} in ${event.repository} was updated (head ${event.headSha.slice(0, 12)}) by @${event.sender}.`,
        ``,
        `Review the updated change against its base and report only new actionable findings.`,
      ].join("\n")
    case "pull_request.ready_for_review":
      return [
        `GitHub pull request #${event.pullNumber} in ${event.repository} is now ready for review (head ${event.headSha.slice(0, 12)}).`,
        ``,
        `Review the change against its base and report only actionable findings with precise file and line evidence.`,
      ].join("\n")
    case "comment.created":
      return [
        `@${event.sender} commented on ${event.isPullRequest ? `pull request` : `issue`} #${event.issueNumber} in ${event.repository}:`,
        ``,
        event.body,
        ``,
        `Answer the comment directly. If it is a question about the repository or the change, ground your answer in the code in the checkout. If it asks for a fix, implement the smallest root-cause fix and report the commit.`,
      ].join("\n")
    default: {
      const exhaustive: never = event
      return `GitHub event in ${String((exhaustive as { repository?: unknown }).repository ?? "unknown")}`
    }
  }
}

async function fetchPages(input: {
  descriptor: RequestDescriptor
  installationToken: string
  maxPages: number
  intervalMs: number
  signal: AbortSignal
  extract: (data: unknown) => unknown[]
}): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = []
  let descriptor: RequestDescriptor | undefined = input.descriptor
  let truncated = false
  for (let page = 1; descriptor; page++) {
    const response: PollPage<unknown> = await GitHubChannelAuth.GitHubClient.sendPage(descriptor, input.signal)
    items.push(...input.extract(response.data))
    const next = nextPageUrl(response.headers)
    if (!next) break
    if (page >= input.maxPages) {
      // Degrade instead of throwing: a busy repository (e.g. the 24h first
      // lookback on a large repo) can exceed the page cap. Returning the
      // pages already collected keeps the poll loop alive; the caller must
      // NOT advance the watermark on a truncated read so omitted items are
      // picked up on later polls rather than skipped forever.
      truncated = true
      log.warn("github polling reached the configured page limit; continuing with collected pages", {
        page,
        maxPages: input.maxPages,
        collected: items.length,
      })
      break
    }
    const remainingHeader = response.headers.get("x-ratelimit-remaining")
    if (remainingHeader !== null && Number(remainingHeader) <= 5) {
      await SessionRetry.sleep(input.intervalMs ?? 300_000, input.signal)
    }
    descriptor = {
      url: next,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.installationToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "synergy-github-channel/1.0",
      },
    }
  }
  return { items, truncated }
}

/**
 * Run one polling loop per repository until the signal aborts. Handles
 * rate-limit backoff and repository-level failures without killing the loop.
 */
export async function runRepositoryPollLoop(input: {
  accountId: string
  repository: string
  intervalMs: number
  pageSize: number
  maxPages: number
  autoReview: boolean
  autoRespond: boolean
  /** GitHub App slug users @-mention (resolved from the App identity). */
  mention?: string
  signal: AbortSignal
  host: ChannelHost.Instance
}): Promise<void> {
  const accountHash = externalIdentityHash(input.accountId)
  while (!input.signal.aborted) {
    let delayMs = input.intervalMs
    try {
      await pollRepository({
        accountId: input.accountId,
        accountHash,
        repository: input.repository,
        intervalMs: input.intervalMs,
        pageSize: input.pageSize,
        maxPages: input.maxPages,
        autoReview: input.autoReview,
        autoRespond: input.autoRespond,
        mention: input.mention,
        signal: input.signal,
        host: input.host,
      })
    } catch (error) {
      if (isAbort(error, input.signal)) return
      if (error instanceof GitHubApiError && (error.status === 403 || error.status === 429)) {
        delayMs = Math.max(input.intervalMs, error.retryAfterMs ?? 0)
      }
      log.warn("github repository poll failed", { repository: input.repository, delayMs, error })
    }
    try {
      await SessionRetry.sleep(delayMs, input.signal)
    } catch (error) {
      if (isAbort(error, input.signal)) return
      throw error
    }
  }
}
