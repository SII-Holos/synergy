import { Config } from "@/config/config"
import { StoragePath } from "@/storage/path"
import { SessionRetry } from "@/session/retry"
import { Log } from "@/util/log"
import { GitHubApiError, GitHubAppAuth, type RequestDescriptor } from "./app-auth"
import { GitHubPollStore } from "./poll-store"
import { GitHubPollSynthesizer } from "./poll-synthesizer"
import { GitHubRuntime } from "./runtime"
import { GitHubStore } from "./store"
import { positiveInteger, record } from "./poll-utils"
import {
  GitHubIntegrationConfig,
  type GitHubDelivery,
  type GitHubIntegrationConfig as IntegrationConfig,
  type GitHubPollState,
} from "./types"

type RepositoryParts = { owner: string; repo: string }
type PollPage<T> = { data: T; headers: Headers }
type WorkflowRunsResponse = { workflow_runs?: unknown }

function splitRepository(repository: string): RepositoryParts {
  const [owner, repo, ...extra] = repository.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error(`Invalid GitHub repository name: ${repository}`)
  return { owner, repo }
}

function nextPageUrl(headers: Headers) {
  const link = headers.get("link")
  if (!link) return
  for (const entry of link.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/)
    if (match?.[2].split(/\s+/).includes("next")) return match[1]
  }
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

export namespace GitHubPollRuntime {
  const log = Log.create({ service: "github-poll-runtime" })
  let activeConfig: IntegrationConfig | undefined
  let pollController: AbortController | undefined
  let worker: Promise<void> | undefined

  export function createPollController() {
    return new AbortController()
  }

  export function abortPollController(controller: AbortController) {
    controller.abort()
  }

  export function resolvePollRepositories(input: IntegrationConfig) {
    const config = GitHubIntegrationConfig.parse(input)
    const repositories = new Set(config.watchedRepositories ?? [])
    if (config.fixWorkflow.enabled) {
      for (const repository of Object.keys(config.fixWorkflow.repositoryMapping)) repositories.add(repository)
    }
    if (config.reviewWorkflow.enabled) {
      for (const repository of Object.keys(config.reviewWorkflow.repositoryMapping)) repositories.add(repository)
    }
    return [...repositories]
  }

  export function isPolling() {
    return Boolean(activeConfig && pollController && !pollController.signal.aborted)
  }

  export function pollStatePath(repository: string) {
    return StoragePath.githubPollState(repository)
  }

  export function runtimeStatePath() {
    return StoragePath.githubRuntimeState()
  }

  export async function start(input?: IntegrationConfig) {
    if (worker || pollController) await stop()
    const configured = input ?? (await Config.globalResolved()).github ?? {}
    const config = GitHubIntegrationConfig.parse(configured)
    const repositories = resolvePollRepositories(config)
    if (!config.enabled || !config.polling.enabled || repositories.length === 0) return

    const controller = createPollController()
    activeConfig = config
    pollController = controller
    worker = Promise.all(repositories.map((repository) => runRepositoryLoop(repository, config, controller.signal)))
      .then(() => undefined)
      .finally(() => {
        if (pollController !== controller) return
        activeConfig = undefined
        pollController = undefined
        worker = undefined
      })
  }

  export async function stop() {
    const current = worker
    const controller = pollController
    activeConfig = undefined
    pollController = undefined
    if (controller) abortPollController(controller)
    await current
    if (worker === current) worker = undefined
  }

  export async function reload(input?: IntegrationConfig) {
    await stop()
    await start(input)
  }

  export async function reset() {
    await stop()
  }

  async function runRepositoryLoop(repository: string, config: IntegrationConfig, signal: AbortSignal) {
    while (!signal.aborted) {
      let delayMs = config.polling.intervalMs
      try {
        await pollRepository(repository, config, signal)
      } catch (error) {
        if (isAbort(error, signal)) return
        if (error instanceof GitHubApiError && (error.status === 403 || error.status === 429)) {
          delayMs = Math.max(config.polling.intervalMs, error.retryAfterMs ?? 0)
        }
        log.warn("repository poll failed", { repository, delayMs, error })
      }

      try {
        await SessionRetry.sleep(delayMs, signal)
      } catch (error) {
        if (isAbort(error, signal)) return
        throw error
      }
    }
  }

  async function pollRepository(repository: string, config: IntegrationConfig, signal: AbortSignal) {
    let state = await GitHubPollStore.read(repository)
    if (!state) {
      state = GitHubPollSynthesizer.initializeBaseline(repository)
      await GitHubPollStore.write(repository, state)
    }

    const { owner, repo } = splitRepository(repository)
    const appId = Number(process.env.SYNERGY_GITHUB_APP_ID)
    const privateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? ""
    const jwt = GitHubAppAuth.generateJWT({ appId, privateKey })
    const installation = await GitHubAppAuth.GitHubClient.send<unknown>(
      GitHubAppAuth.GitHubClient.resolveInstallation({ owner, repo, jwt }),
      signal,
    )
    const installationId = positiveInteger(record(installation).id)
    if (!installationId) throw new Error(`GitHub App installation for ${repository} has no valid ID`)
    const installationToken = await GitHubAppAuth.getInstallationToken(installationId, signal)
    const since = new Date(Math.max(0, state.lastUpdatedAt - config.polling.overlapWindowMs)).toISOString()

    const issueItems = await fetchPages({
      descriptor: GitHubAppAuth.GitHubClient.listRepositoryIssues({
        owner,
        repo,
        since,
        pageSize: config.polling.pageSize,
        installationToken,
      }),
      installationToken,
      maxPages: config.polling.maxPages,
      intervalMs: config.polling.intervalMs,
      signal,
      extract: (data) => (Array.isArray(data) ? data : []),
    })
    const issueResult = GitHubPollSynthesizer.processIssues(state, {
      repository,
      installationId,
      items: issueItems,
    })
    state = issueResult.state

    const pullNumbers = new Set(
      issueItems.flatMap((item) => {
        const itemRecord = record(item)
        return Object.keys(record(itemRecord.pull_request)).length > 0 && positiveInteger(itemRecord.number)
          ? [positiveInteger(itemRecord.number)!]
          : []
      }),
    )
    const pullRequests = await mapConcurrent([...pullNumbers], 8, (pullNumber) =>
      GitHubAppAuth.GitHubClient.send<unknown>(
        GitHubAppAuth.GitHubClient.getPullRequest({ owner, repo, pullNumber, installationToken }),
        signal,
      ),
    )
    const pullRequestResult = GitHubPollSynthesizer.processPullRequests(state, {
      repository,
      installationId,
      pullRequests,
    })
    state = pullRequestResult.state

    const workflowRuns = await fetchWorkflowRuns({
      owner,
      repo,
      state,
      installationToken,
      maxPages: config.polling.maxPages,
      pageSize: config.polling.pageSize,
      overlapWindowMs: config.polling.overlapWindowMs,
      intervalMs: config.polling.intervalMs,
      signal,
    })
    const workflowResult = GitHubPollSynthesizer.processWorkflowRuns(state, {
      repository,
      installationId,
      workflowRuns,
    })
    state = workflowResult.state

    await acceptDeliveries([...issueResult.deliveries, ...pullRequestResult.deliveries, ...workflowResult.deliveries])
    await GitHubPollStore.write(repository, state)
  }

  async function fetchWorkflowRuns(input: {
    owner: string
    repo: string
    state: GitHubPollState
    installationToken: string
    maxPages: number
    pageSize: number
    overlapWindowMs: number
    intervalMs: number
    signal: AbortSignal
  }) {
    const since = new Date(
      Math.max(0, (input.state.lastWorkflowRunCreatedAt ?? input.state.baselineTimestampMs) - input.overlapWindowMs),
    ).toISOString()
    const recentRuns = await fetchPages({
      descriptor: GitHubAppAuth.GitHubClient.listWorkflowRuns({
        owner: input.owner,
        repo: input.repo,
        since,
        pageSize: input.pageSize,
        installationToken: input.installationToken,
      }),
      installationToken: input.installationToken,
      maxPages: input.maxPages,
      intervalMs: input.intervalMs,
      signal: input.signal,
      extract: (data) => {
        const runs = (data as WorkflowRunsResponse | undefined)?.workflow_runs
        return Array.isArray(runs) ? runs : []
      },
    })
    const recentIds = new Set(recentRuns.flatMap((run) => positiveInteger(record(run).id) ?? []))
    const pendingIds = Object.values(input.state.seenWorkflowRunIds)
      .filter((run) => !run.conclusion && !recentIds.has(run.runId))
      .map((run) => run.runId)
    recentRuns.push(
      ...(await mapConcurrent(pendingIds, 8, (runId) =>
        GitHubAppAuth.GitHubClient.send<unknown>(
          GitHubAppAuth.GitHubClient.getWorkflowRun({
            owner: input.owner,
            repo: input.repo,
            runId,
            installationToken: input.installationToken,
          }),
          input.signal,
        ),
      )),
    )
    return recentRuns
  }

  async function fetchPages(input: {
    descriptor: RequestDescriptor
    installationToken: string
    maxPages: number
    intervalMs: number
    signal: AbortSignal
    extract: (data: unknown) => unknown[]
  }) {
    const items: unknown[] = []
    let descriptor: RequestDescriptor | undefined = input.descriptor
    for (let page = 1; descriptor; page++) {
      const response: PollPage<unknown> = await GitHubAppAuth.GitHubClient.sendPage(descriptor, input.signal)
      items.push(...input.extract(response.data))
      const next = nextPageUrl(response.headers)
      if (!next) break
      if (page >= input.maxPages) throw new Error(`GitHub polling exceeded the configured ${input.maxPages} page limit`)
      const remainingHeader = response.headers.get("x-ratelimit-remaining")
      if (remainingHeader !== null && Number(remainingHeader) <= 5) {
        await SessionRetry.sleep(input.intervalMs, input.signal)
      }
      descriptor = GitHubAppAuth.GitHubClient.followPagination({
        url: next,
        installationToken: input.installationToken,
      })
    }
    return items
  }

  async function acceptDeliveries(deliveries: GitHubDelivery[]) {
    let accepted = false
    for (const delivery of deliveries) {
      const result = await GitHubStore.accept(delivery)
      if (!result.duplicate) accepted = true
    }
    if (accepted) GitHubRuntime.notify()
  }
}
