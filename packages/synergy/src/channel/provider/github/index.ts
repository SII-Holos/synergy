import { Config } from "@/config/config"
import { Scope } from "@/scope"
import { Log } from "@/util/log"
import { SessionManager } from "@/session/manager"
import type { ChannelHost } from "../../host"
import * as ChannelTypes from "../../types"
import { GitHubChannelAuth, buildCredentialCommand } from "./api"
import { GithubChannelWorkspace } from "./workspace"
import { runRepositoryPollLoop } from "./poll"
import { lookupBodyChat, lookupCommentChat } from "./reactions"
import { externalIdentityHash } from "../../../util/identity"
const log = Log.create({ service: "channel.github" })

/**
 * Map the generic channel status emoji vocabulary (Typing/DONE/ERROR) and
 * free-form inputs onto the GitHub reaction content set. GitHub only accepts:
 * +1, -1, laugh, confused, heart, hooray, rocket, eyes.
 */
function normalizeReactionEmoji(emoji: string): string | undefined {
  const normalized = emoji.trim().toLowerCase()
  switch (normalized) {
    case "typing":
    case "eyes":
      return "eyes"
    case "done":
    case "rocket":
      return "rocket"
    case "error":
    case "confused":
      return "confused"
    case "+1":
    case "thumbsup":
    case "thumbs_up":
      return "+1"
    case "-1":
    case "thumbsdown":
    case "thumbs_down":
      return "-1"
    case "laugh":
    case "hooray":
    case "heart":
      return normalized
    default:
      return undefined
  }
}

type ThreadFacts = {
  pullNumber?: number
  defaultBranch?: string
  /** PR head branch ref (e.g. `feature/xyz`), present when the thread is a PR. */
  headRef?: string
  /** PR head repository full name (e.g. `owner/repo`); differs from the base for fork PRs. */
  headRepoFullName?: string
}

type AccountState = {
  config: Config.ChannelGithubAccount
  accountHash: string
  abort: AbortController
  loops: Promise<void>[]
  threadFacts: Map<string, ThreadFacts>
  /** GitHub handle users @-mention to summon the bot (App slug or configured override). */
  mention: string
}

function parseChatId(chatId: string): { repository: string; issueNumber: number } | undefined {
  const hashIndex = chatId.lastIndexOf("#")
  if (hashIndex <= 0 || hashIndex === chatId.length - 1) return undefined
  const repository = chatId.slice(0, hashIndex)
  const issueNumber = Number(chatId.slice(hashIndex + 1))
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return undefined
  return { repository, issueNumber }
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = repository.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error(`Invalid GitHub repository name: ${repository}`)
  return { owner, repo }
}
/**
 * Reject a fix-delivery branch that equals the resolved repository base
 * branch: pushing it would update the default branch directly instead of
 * opening a pull request. The caller passes the canonical branch name
 * (resolved from the supplied ref by `resolveCanonicalBranch`).
 */
export function assertNotBaseBranch(branch: string, baseBranch: string): void {
  // "refs/heads/main" pushes the same remote ref as "main"; normalize the
  // ref prefix so both forms are rejected.
  const normalized = branch.replace(/^refs\/heads\//, "")
  if (normalized === baseBranch) {
    throw new Error(
      `Branch "${branch}" is the repository base branch; create a dedicated fix branch (e.g. synergy/fix/<issue>-<slug>) before delivering`,
    )
  }
}

/**
 * Resolve a ref to its canonical local branch (e.g. `HEAD` resolves to
 * `refs/heads/<branch>` when a branch is checked out). Returns undefined when
 * the ref does not name a local branch (missing ref, tag, detached HEAD).
 */
export async function resolveCanonicalBranch(directory: string, ref: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", "--symbolic-full-name", ref], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) return undefined
  const canonical = stdout.trim()
  return canonical.startsWith("refs/heads/") ? canonical : undefined
}

function joinOutboundText(parts: ChannelTypes.OutboundPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.trim()) chunks.push(part.text.trim())
      continue
    }
    if ("url" in part && part.url) {
      chunks.push(`[${part.filename ?? part.type}](${part.url})`)
    }
  }
  return chunks.join("\n\n")
}

class NonStreamingSession implements ChannelTypes.StreamingSession {
  async start(): Promise<void> {}
  async update(_text: string): Promise<void> {}
  async updateToolProgress(_progress: ChannelTypes.StreamingToolProgress[]): Promise<void> {}
  async close(_finalText?: string, _error?: boolean): Promise<void> {}
  isActive(): boolean {
    return false
  }
}

export class GithubProvider implements ChannelTypes.Provider<Config.ChannelGithubAccount, Config.ChannelGithub> {
  readonly type = "github"
  readonly lifecycle = "self_connected" as const
  readonly defaultAgent = "github-channel-agent"
  readonly conversation = {
    replyMessage: (input: Parameters<GithubProvider["replyMessage"]>[0]) => this.replyMessage(input),
    pushMessage: (input: Parameters<GithubProvider["pushMessage"]>[0]) => this.pushMessage(input),
    addReaction: (input: Parameters<GithubProvider["addReaction"]>[0]) => this.addReaction(input),
    removeReaction: (input: Parameters<GithubProvider["removeReaction"]>[0]) => this.removeReaction(input),
    createStreamingSession: (input: Parameters<GithubProvider["createStreamingSession"]>[0]) =>
      this.createStreamingSession(input),
  } satisfies ChannelTypes.ConversationCapabilities

  private accounts = new Map<string, AccountState>()

  async connect(input: {
    accountId: string
    accountConfig: Config.ChannelGithubAccount
    channelConfig: Config.ChannelGithub
    signal: AbortSignal
    host: ChannelHost.Instance
    onDisconnect?: (reason?: string) => void
    onResponseCardAction?: (
      callback: ChannelTypes.ResponseCardCallback,
    ) => Promise<ChannelTypes.ResponseCardActionResult>
    onQuestionCardAction?: (
      callback: ChannelTypes.QuestionCardCallback,
    ) => Promise<ChannelTypes.QuestionCardActionResult>
  }): Promise<void> {
    const account = input.accountConfig
    const accountHash = externalIdentityHash(input.accountId)
    const abort = new AbortController()
    // The mention name follows the reply identity: replies are posted as the
    // GitHub App (installation token), so the summon handle defaults to the
    // App slug resolved from the App identity. A configured override wins.
    let mention = account.mention?.trim() ?? ""
    if (!mention) {
      try {
        mention = await GitHubChannelAuth.getAppSlug(abort.signal)
      } catch (error) {
        log.warn("github app slug resolution failed; @mention summoning disabled", { error })
      }
    }
    const state: AccountState = {
      config: account,
      accountHash,
      abort,
      loops: [],
      threadFacts: new Map(),
      mention,
    }
    this.accounts.set(input.accountId, state)

    input.signal.addEventListener(
      "abort",
      () => {
        abort.abort()
      },
      { once: true },
    )

    const repositories = account.repositories ?? []
    if (repositories.length === 0) {
      log.warn("github channel account has no repositories", { accountHash })
    }

    // Sweep expired checkouts on connect so unused clones are reclaimed per
    // the account TTL (session history is preserved; clones are recreated on
    // the next thread trigger).
    const ttlHours = account.workspaceTtlHours ?? 24
    GithubChannelWorkspace.sweep({ accountId: input.accountId, workspaceTtlHours: ttlHours })
      .then((removed) => {
        if (removed > 0) log.info("swept expired github workspace checkouts", { accountHash, removed })
      })
      .catch((error) => log.warn("github workspace sweep failed", { accountHash, error }))

    for (const repository of repositories) {
      const loop = runRepositoryPollLoop({
        accountId: input.accountId,
        repository,
        intervalMs: account.pollingIntervalMs ?? 300_000,
        pageSize: 100,
        maxPages: 30,
        autoReview: account.autoReview ?? true,
        autoRespond: account.autoRespond ?? true,
        mention,
        signal: abort.signal,
        host: input.host,
      })
        .catch((error) => {
          log.error("github repository poll loop failed", { repository, error })
        })
        .finally(() => {
          state.loops = state.loops.filter((item) => item !== loop)
        })
      state.loops.push(loop)
    }

    log.info("github channel account connected", { accountHash, repositories: repositories.length })
  }

  async disconnect(input: { accountId: string }): Promise<void> {
    const state = this.accounts.get(input.accountId)
    if (!state) return
    this.accounts.delete(input.accountId)
    state.abort.abort()
    await Promise.allSettled(state.loops)
    GitHubChannelAuth.reset()
  }

  /**
   * Resolve the per-thread Scope: each GitHub issue/PR thread owns a
   * random-hash checkout directory under the configured workspace root, and
   * the Scope is bound to that directory so the agent runs inside it.
   */
  async resolveConversationScope(input: {
    accountId: string
    accountConfig: Config.ChannelGithubAccount
    message: ChannelTypes.MessageContext
  }): Promise<Scope | undefined> {
    const account = input.accountConfig
    const state = this.accounts.get(input.accountId)
    const parsed = parseChatId(input.message.chatId)
    if (!parsed) return undefined

    const factKey = `${parsed.repository}#${parsed.issueNumber}`
    let facts = state?.threadFacts.get(factKey)
    const { owner, repo } = splitRepository(parsed.repository)

    if (!facts) {
      const token = await this.resolveInstallationToken(owner, repo)
      // Distinguish PR threads from issue threads: the pulls endpoint 404s
      // for plain issues. When it is a PR, also capture the head branch and
      // head repository so a later fix delivery can push to that PR.
      let pullNumber: number | undefined
      let defaultBranch: string | undefined
      let headRef: string | undefined
      let headRepoFullName: string | undefined
      const pull = await GitHubChannelAuth.GitHubClient.send<{
        number?: unknown
        head?: { ref?: unknown; repo?: { full_name?: unknown } | null }
      }>(
        GitHubChannelAuth.GitHubClient.getPullRequest({
          owner,
          repo,
          pullNumber: parsed.issueNumber,
          installationToken: token,
        }),
      ).catch(() => undefined)
      if (pull && typeof pull.number === "number") {
        pullNumber = parsed.issueNumber
        const head = pull.head
        if (head && typeof head.ref === "string") headRef = head.ref
        if (head?.repo && typeof head.repo.full_name === "string") headRepoFullName = head.repo.full_name
      }
      const repository = await GitHubChannelAuth.GitHubClient.send<{ default_branch?: unknown }>(
        GitHubChannelAuth.GitHubClient.getRepository({ owner, repo, installationToken: token }),
      ).catch(() => undefined)
      defaultBranch = typeof repository?.default_branch === "string" ? repository.default_branch : undefined
      facts = { pullNumber, defaultBranch, headRef, headRepoFullName }
      state?.threadFacts.set(factKey, facts)
    }

    const { record, scope } = await GithubChannelWorkspace.ensure({
      accountId: input.accountId,
      workspaceDir: account.workspaceDir,
      workspaceTtlHours: account.workspaceTtlHours ?? 24,
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      pullNumber: facts.pullNumber,
      defaultBranch: facts.defaultBranch,
      token: await this.resolveInstallationToken(owner, repo),
    })
    log.info("github conversation scope resolved", {
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      scopeID: scope.id,
      directory: record.directory,
    })
    return scope
  }

  private async resolveInstallationToken(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    const appId = Number(process.env.SYNERGY_GITHUB_APP_ID)
    const privateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? ""
    const jwt = GitHubChannelAuth.generateJWT({ appId, privateKey })
    const installation = await GitHubChannelAuth.GitHubClient.send<{ id?: unknown }>(
      GitHubChannelAuth.GitHubClient.resolveInstallation({ owner, repo, jwt }),
      signal,
    )
    if (typeof installation?.id !== "number" || !Number.isInteger(installation.id) || installation.id <= 0) {
      throw new Error(`GitHub App installation for ${owner}/${repo} has no valid ID`)
    }
    return GitHubChannelAuth.getInstallationToken(installation.id, signal)
  }

  /**
   * Deliver a locally committed fix as a pull request. The agent commits on a
   * local branch in the thread checkout and calls the `github_deliver_fix`
   * tool; this method pushes the branch with an ephemeral installation token
   * (never exposed to the agent). When the session thread is a pull request,
   * the fix is pushed to that PR's head branch first (updating the PR in
   * place); when that is not possible (fork without App access, protected or
   * moved head branch), it falls back to opening a deduplicated PR against
   * the repository default branch.
   */
  async deliverFix(
    input: {
      sessionID: string
      branch: string
      title: string
      body: string
    },
    signal?: AbortSignal,
  ): Promise<{ pullRequestURL: string; pullNumber: number; headBranch: string }> {
    if (!/^[A-Za-z0-9_.\-/]+$/.test(input.branch) || input.branch.startsWith("/") || input.branch.includes("..")) {
      throw new Error(`Invalid branch name: ${input.branch}`)
    }
    const session = await SessionManager.getSession(input.sessionID)
    const channel = session?.endpoint?.channel
    if (session?.endpoint?.kind !== "channel" || channel?.type !== "github") {
      throw new Error("This session is not bound to a GitHub channel thread")
    }
    const accountId = channel.accountId ?? "default"
    const parsed = parseChatId(channel.chatId ?? "")
    if (!parsed) throw new Error(`Invalid GitHub chatId: ${channel.chatId}`)

    const record = await GithubChannelWorkspace.find({
      accountId,
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
    })
    if (!record) throw new Error(`No workspace checkout found for ${parsed.repository}#${parsed.issueNumber}`)

    // Resolve the base branch (repository default branch preferred).
    const { owner, repo } = splitRepository(parsed.repository)
    const token = await this.resolveInstallationToken(owner, repo, signal)
    const facts = this.accounts.get(accountId)?.threadFacts.get(`${parsed.repository}#${parsed.issueNumber}`)
    const baseBranch = facts?.defaultBranch ?? (await this.resolveDefaultBranch(owner, repo, token, signal)) ?? "main"

    // Resolve the supplied ref to its canonical local branch. This rejects
    // symbolic refs such as `HEAD` (which would push whatever branch is
    // checked out — potentially the default branch) before the base-branch
    // comparison, and verifies the branch exists.
    const canonical = await resolveCanonicalBranch(record.directory, input.branch)
    if (!canonical) throw new Error(`Local branch ${input.branch} does not exist`)
    const canonicalBranch = canonical.replace(/^refs\/heads\//, "")
    assertNotBaseBranch(canonicalBranch, baseBranch)

    const credential = buildCredentialCommand({ token, args: [] })

    // Require at least one commit beyond the comparison ref: for PR threads
    // the fetched PR head (so pushing the unchanged PR back is never reported
    // as a delivery), otherwise the repository base branch.
    const aheadRef = facts?.pullNumber ? `origin/pr-${facts.pullNumber}` : `origin/${baseBranch}`
    const ahead = await this.runGit(["git", "rev-list", "--count", canonicalBranch, `^${aheadRef}`], {
      cwd: record.directory,
      env: credential.env,
      signal,
    })
    const aheadCount = Number(ahead.stdout.trim())
    if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
      throw new Error(`Local branch ${canonicalBranch} has no commits ahead of ${aheadRef}`)
    }

    // When the thread is a pull request, prefer pushing the fix to the PR
    // head branch so the PR updates in place (Codex-style behavior).
    if (facts?.pullNumber && facts.headRef) {
      const updated = await this.tryPushToPullRequestHead(
        {
          repository: parsed.repository,
          pullNumber: facts.pullNumber,
          headRef: facts.headRef,
          headRepoFullName: facts.headRepoFullName,
          branch: canonicalBranch,
          directory: record.directory,
        },
        signal,
      )
      if (updated) {
        log.info("github fix pushed to existing pull request", {
          repository: parsed.repository,
          pullNumber: facts.pullNumber,
          headRef: facts.headRef,
        })
        return updated
      }
      log.info("github fix push to pull request head unavailable; falling back to a new PR", {
        repository: parsed.repository,
        pullNumber: facts.pullNumber,
      })
    }

    // Fallback: push the fix branch and open (or reuse) a PR against the base.
    const pushed = await this.runGit(["git", ...credential.args, "push", "--no-verify", "origin", canonicalBranch], {
      cwd: record.directory,
      env: credential.env,
      signal,
    })
    if (pushed.exitCode !== 0) {
      throw new Error(`Failed to push branch ${canonicalBranch}: ${pushed.stderr.slice(0, 500)}`)
    }

    // Deduplicate: reuse an existing open PR with the same head branch.
    const existing = await GitHubChannelAuth.GitHubClient.send<{ number?: unknown; html_url?: unknown }[]>(
      GitHubChannelAuth.GitHubClient.listPullRequests({
        owner,
        repo,
        state: "open",
        head: `${owner}:${canonicalBranch}`,
        installationToken: token,
      }),
      signal,
    )
    const open = existing?.find((item) => typeof item?.number === "number")
    if (open) {
      return {
        pullRequestURL:
          typeof open.html_url === "string"
            ? open.html_url
            : `https://github.com/${parsed.repository}/pull/${open.number}`,
        pullNumber: open.number as number,
        headBranch: canonicalBranch,
      }
    }

    const created = await GitHubChannelAuth.GitHubClient.send<{ number?: unknown; html_url?: unknown }>(
      GitHubChannelAuth.GitHubClient.createPullRequest({
        owner,
        repo,
        title: input.title,
        body: input.body,
        head: canonicalBranch,
        base: baseBranch,
        installationToken: token,
      }),
      signal,
    )
    if (typeof created?.number !== "number" || typeof created.html_url !== "string") {
      throw new Error(`GitHub PR creation returned an invalid response for ${input.branch}`)
    }
    return { pullRequestURL: created.html_url, pullNumber: created.number, headBranch: canonicalBranch }
  }

  /**
   * Attempt to update an existing pull request by pushing the fix branch to
   * its head branch. Same-repository PRs push directly; fork PRs push to the
   * fork only when the App has an installation there. Returns undefined when
   * the push cannot be performed (fork without App access, protected or
   * moved head branch), so the caller falls back to a new PR.
   */
  private async tryPushToPullRequestHead(
    input: {
      repository: string
      pullNumber: number
      headRef: string
      headRepoFullName: string | undefined
      branch: string
      directory: string
    },
    signal?: AbortSignal,
  ): Promise<{ pullRequestURL: string; pullNumber: number; headBranch: string } | undefined> {
    // Only push to the base repository when the head repository is positively
    // known to be the same repository. An unknown head repo (e.g. the source
    // fork disappeared) must fall back to a new PR rather than risk pushing a
    // same-named branch — potentially the default branch — into the base.
    if (input.headRepoFullName === undefined) return undefined
    const isFork = input.headRepoFullName !== input.repository
    let pushURL: string
    let pushToken: string
    if (!isFork) {
      const { owner, repo } = splitRepository(input.repository)
      pushURL = `https://github.com/${input.repository}.git`
      pushToken = await this.resolveInstallationToken(owner, repo)
    } else {
      const fork = splitRepository(input.headRepoFullName)
      try {
        pushURL = `https://github.com/${input.headRepoFullName}.git`
        pushToken = await this.resolveInstallationToken(fork.owner, fork.repo)
      } catch (error) {
        log.warn("fork PR push unavailable (no App installation on fork)", {
          repository: input.repository,
          headRepo: input.headRepoFullName,
          error,
        })
        return undefined
      }
    }

    const credential = buildCredentialCommand({ token: pushToken, args: [] })
    const result = await this.runGit(
      ["git", ...credential.args, "push", "--no-verify", pushURL, `${input.branch}:${input.headRef}`],
      { cwd: input.directory, env: credential.env, signal },
    )
    if (result.exitCode !== 0) {
      log.warn("push to pull request head failed; falling back to a new PR", {
        repository: input.repository,
        pullNumber: input.pullNumber,
        headRef: input.headRef,
        stderr: result.stderr.slice(0, 300),
      })
      return undefined
    }
    return {
      pullRequestURL: `https://github.com/${input.repository}/pull/${input.pullNumber}`,
      pullNumber: input.pullNumber,
      headBranch: input.headRef,
    }
  }

  private async runGit(
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined>; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
  }

  private async resolveDefaultBranch(
    owner: string,
    repo: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const repository = await GitHubChannelAuth.GitHubClient.send<{ default_branch?: unknown }>(
      GitHubChannelAuth.GitHubClient.getRepository({ owner, repo, installationToken: token }),
      signal,
    ).catch(() => undefined)
    return typeof repository?.default_branch === "string" ? repository.default_branch : undefined
  }

  async replyMessage(input: {
    accountId: string
    messageId: string
    chatId?: string
    chatType?: "dm" | "group"
    parts: ChannelTypes.OutboundPart[]
    scopeKey?: string
  }): Promise<ChannelTypes.SendResult> {
    const body = joinOutboundText(input.parts)
    if (!body) throw new Error("Cannot post an empty GitHub comment")
    if (!input.chatId) throw new Error("GitHub reply requires a chatId")
    const parsed = parseChatId(input.chatId)
    if (!parsed) throw new Error(`Invalid GitHub chatId: ${input.chatId}`)
    const { owner, repo } = splitRepository(parsed.repository)
    const token = await this.resolveInstallationToken(owner, repo)
    const comment = await GitHubChannelAuth.GitHubClient.send<{ id?: unknown; html_url?: unknown }>(
      GitHubChannelAuth.GitHubClient.createIssueComment({
        owner,
        repo,
        issueNumber: parsed.issueNumber,
        body,
        installationToken: token,
      }),
    )
    return { messageId: typeof comment?.id === "number" ? String(comment.id) : input.messageId }
  }

  async pushMessage(input: {
    accountId: string
    chatId: string
    parts: ChannelTypes.OutboundPart[]
  }): Promise<ChannelTypes.SendResult> {
    const body = joinOutboundText(input.parts)
    if (!body) throw new Error("Cannot post an empty GitHub comment")
    const parsed = parseChatId(input.chatId)
    if (!parsed) throw new Error(`Invalid GitHub chatId: ${input.chatId}`)
    const { owner, repo } = splitRepository(parsed.repository)
    const token = await this.resolveInstallationToken(owner, repo)
    const comment = await GitHubChannelAuth.GitHubClient.send<{ id?: unknown }>(
      GitHubChannelAuth.GitHubClient.createIssueComment({
        owner,
        repo,
        issueNumber: parsed.issueNumber,
        body,
        installationToken: token,
      }),
    )
    return { messageId: typeof comment?.id === "number" ? String(comment.id) : input.chatId }
  }

  async addReaction(input: {
    accountId: string
    messageId: string
    emoji: string
  }): Promise<{ reactionId: string } | void> {
    const content = normalizeReactionEmoji(input.emoji)
    if (!content) {
      log.warn("github reaction skipped (unsupported emoji)", { messageId: input.messageId, emoji: input.emoji })
      return undefined
    }
    const chatId = this.chatIdForMessage(input.accountId, input.messageId)
    if (!chatId) return undefined
    const parsed = parseChatId(chatId)
    if (!parsed) return undefined
    const { owner, repo } = splitRepository(parsed.repository)
    try {
      const token = await this.resolveInstallationToken(owner, repo)
      // Numeric message IDs are real comment IDs (comment reactions);
      // synthetic event message IDs target the issue/PR body.
      const commentId = Number(input.messageId)
      const reaction = await (Number.isInteger(commentId) && commentId > 0
        ? GitHubChannelAuth.GitHubClient.send<{ id?: unknown }>(
            GitHubChannelAuth.GitHubClient.createIssueCommentReaction({
              owner,
              repo,
              commentId,
              content,
              installationToken: token,
            }),
          )
        : GitHubChannelAuth.GitHubClient.send<{ id?: unknown }>(
            GitHubChannelAuth.GitHubClient.createIssueReaction({
              owner,
              repo,
              issueNumber: parsed.issueNumber,
              content,
              installationToken: token,
            }),
          ))
      return typeof reaction?.id === "number" ? { reactionId: String(reaction.id) } : undefined
    } catch (error) {
      log.warn("github reaction failed", { messageId: input.messageId, emoji: content, error })
      return undefined
    }
  }

  async removeReaction(input: { accountId: string; messageId: string; reactionId: string }): Promise<void> {
    const reactionId = Number(input.reactionId)
    if (!Number.isInteger(reactionId) || reactionId <= 0) return
    const chatId = this.chatIdForMessage(input.accountId, input.messageId)
    if (!chatId) return
    const parsed = parseChatId(chatId)
    if (!parsed) return
    const { owner, repo } = splitRepository(parsed.repository)
    try {
      const token = await this.resolveInstallationToken(owner, repo)
      const commentId = Number(input.messageId)
      if (Number.isInteger(commentId) && commentId > 0) {
        await GitHubChannelAuth.GitHubClient.send<unknown>(
          GitHubChannelAuth.GitHubClient.deleteIssueCommentReaction({
            owner,
            repo,
            commentId,
            reactionId,
            installationToken: token,
          }),
        )
      } else {
        await GitHubChannelAuth.GitHubClient.send<unknown>(
          GitHubChannelAuth.GitHubClient.deleteIssueReaction({
            owner,
            repo,
            issueNumber: parsed.issueNumber,
            reactionId,
            installationToken: token,
          }),
        )
      }
    } catch (error) {
      log.warn("github reaction removal failed", { messageId: input.messageId, reactionId, error })
    }
  }

  createStreamingSession(input: {
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    replyToMessageId?: string
    sessionID: string
    scopeKey?: string
  }): ChannelTypes.StreamingSession {
    return new NonStreamingSession()
  }

  /** Map a message ID back to its chatId via the poll-loop registry. */
  private chatIdForMessage(accountId: string, messageId: string): string | undefined {
    return lookupCommentChat(messageId) ?? lookupBodyChat(messageId)
  }
}
