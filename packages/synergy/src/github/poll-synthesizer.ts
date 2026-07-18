import { GitHubDelivery, GitHubPollState, type GitHubPollState as PollState } from "./types"
import { positiveInteger, record, type JsonRecord } from "./poll-utils"
type SynthesisResult = { state: PollState; deliveries: GitHubDelivery[] }

const MAX_TRACKED_CLOSED_PULL_REQUESTS = 5_000

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function senderLogin(value: JsonRecord, fallback: string) {
  return text(record(value.user).login) ?? text(record(value.sender).login) ?? fallback
}

function delivery(input: {
  repository: string
  installationId: number
  deliveryGuid: string
  eventType: "issues" | "pull_request" | "workflow_run"
  action: "opened" | "reopened" | "synchronize" | "completed"
  payloadKey: "issue" | "pull_request" | "workflow_run"
  payload: JsonRecord
  sender: string
  receivedAt: number
}) {
  return GitHubDelivery.parse({
    deliveryGuid: input.deliveryGuid,
    eventType: input.eventType,
    installationId: input.installationId,
    repositoryFullName: input.repository,
    senderLogin: input.sender,
    receivedAt: input.receivedAt,
    rawPayload: {
      action: input.action,
      repository: { full_name: input.repository },
      installation: { id: input.installationId },
      sender: { login: input.sender },
      [input.payloadKey]: input.payload,
    },
    rawHeaders: {
      "x-poll-event": input.eventType,
      "x-poll-delivery": input.deliveryGuid,
    },
    status: "received",
  })
}

function nextWatermark(current: number, values: unknown[]) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, timestamp(value) ?? maximum), current)
}

function prunePullRequests(state: PollState) {
  const open = Object.entries(state.seenPRs).filter(([, pullRequest]) => pullRequest.state === "open")
  const closed = Object.entries(state.seenPRs)
    .filter(([, pullRequest]) => pullRequest.state === "closed")
    .sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_TRACKED_CLOSED_PULL_REQUESTS)
  state.seenPRs = Object.fromEntries([...open, ...closed])
}

export namespace GitHubPollSynthesizer {
  export function initializeBaseline(repository: string, timestampMs = Date.now()): PollState {
    return GitHubPollState.parse({
      repository,
      baselineTimestampMs: timestampMs,
      lastUpdatedAt: timestampMs,
      lastWorkflowRunCreatedAt: timestampMs,
      seenPRs: {},
      seenWorkflowRunIds: {},
    })
  }

  export function processIssues(
    inputState: PollState,
    input: { repository: string; installationId: number; items: unknown[] },
  ): SynthesisResult {
    const state = structuredClone(GitHubPollState.parse(inputState))
    const deliveries: GitHubDelivery[] = []

    for (const value of input.items) {
      const issue = record(value)
      if (Object.keys(record(issue.pull_request)).length > 0) continue
      const number = positiveInteger(issue.number)
      const createdAt = timestamp(issue.created_at)
      const updatedAt = text(issue.updated_at)
      if (!number || createdAt === undefined || !updatedAt) continue

      if (createdAt >= state.baselineTimestampMs) {
        const deliveryGuid = `poll:${input.repository}:issue:${number}:${createdAt}`
        deliveries.push(
          delivery({
            repository: input.repository,
            installationId: input.installationId,
            deliveryGuid,
            eventType: "issues",
            action: "opened",
            payloadKey: "issue",
            payload: issue,
            sender: senderLogin(issue, "github"),
            receivedAt: createdAt,
          }),
        )
      }
    }

    state.lastUpdatedAt = nextWatermark(
      state.lastUpdatedAt,
      input.items.map((item) => record(item).updated_at),
    )
    return { state: GitHubPollState.parse(state), deliveries }
  }

  export function processPullRequests(
    inputState: PollState,
    input: { repository: string; installationId: number; pullRequests: unknown[] },
  ): SynthesisResult {
    const state = structuredClone(GitHubPollState.parse(inputState))
    const deliveries: GitHubDelivery[] = []

    for (const value of input.pullRequests) {
      const pullRequest = record(value)
      const number = positiveInteger(pullRequest.number)
      const createdAt = timestamp(pullRequest.created_at)
      const updatedAt = text(pullRequest.updated_at)
      const headSha = text(record(pullRequest.head).sha)
      const stateValue = pullRequest.state === "open" || pullRequest.state === "closed" ? pullRequest.state : undefined
      if (!number || createdAt === undefined || !updatedAt || !headSha || !stateValue) continue

      const key = String(number)
      const previous = state.seenPRs[key]
      let action: "opened" | "reopened" | "synchronize" | undefined
      if (!previous && stateValue === "open" && createdAt >= state.baselineTimestampMs) action = "opened"
      else if (previous?.state === "closed" && stateValue === "open" && previous.headSha === headSha)
        action = "reopened"
      else if (previous && previous.headSha !== headSha && stateValue === "open") action = "synchronize"

      if (action) {
        const qualifier = action === "opened" ? createdAt : (timestamp(updatedAt) ?? createdAt)
        const deliveryGuid = `poll:${input.repository}:pr:${number}:${action}:${headSha}:${qualifier}`
        deliveries.push(
          delivery({
            repository: input.repository,
            installationId: input.installationId,
            deliveryGuid,
            eventType: "pull_request",
            action,
            payloadKey: "pull_request",
            payload: pullRequest,
            sender: senderLogin(pullRequest, "github"),
            receivedAt: qualifier,
          }),
        )
      }

      state.seenPRs[key] = { number, headSha, state: stateValue, updatedAt }
    }

    state.lastUpdatedAt = nextWatermark(
      state.lastUpdatedAt,
      input.pullRequests.map((item) => record(item).updated_at),
    )
    prunePullRequests(state)
    return { state: GitHubPollState.parse(state), deliveries }
  }

  export function processWorkflowRuns(
    inputState: PollState,
    input: { repository: string; installationId: number; workflowRuns: unknown[] },
  ): SynthesisResult {
    const state = structuredClone(GitHubPollState.parse(inputState))
    const deliveries: GitHubDelivery[] = []

    for (const value of input.workflowRuns) {
      const workflowRun = record(value)
      const runId = positiveInteger(workflowRun.id)
      const updatedAt = text(workflowRun.updated_at)
      if (!runId || !updatedAt) continue

      const key = String(runId)
      const previous = state.seenWorkflowRunIds[key]
      const conclusion = text(workflowRun.conclusion)
      if (previous && !previous.conclusion && workflowRun.status === "completed" && conclusion) {
        const occurredAt = timestamp(updatedAt) ?? Date.now()
        const deliveryGuid = `poll:${input.repository}:workflow:${runId}:completed:${occurredAt}`
        deliveries.push(
          delivery({
            repository: input.repository,
            installationId: input.installationId,
            deliveryGuid,
            eventType: "workflow_run",
            action: "completed",
            payloadKey: "workflow_run",
            payload: workflowRun,
            sender:
              text(record(workflowRun.triggering_actor).login) ?? text(record(workflowRun.actor).login) ?? "github",
            receivedAt: occurredAt,
          }),
        )
      }

      if (workflowRun.status === "completed" || conclusion) {
        delete state.seenWorkflowRunIds[key]
      } else {
        state.seenWorkflowRunIds[key] = { runId, updatedAt }
      }
    }

    state.lastWorkflowRunCreatedAt = nextWatermark(
      state.lastWorkflowRunCreatedAt ?? state.baselineTimestampMs,
      input.workflowRuns.map((item) => record(item).created_at),
    )
    return { state: GitHubPollState.parse(state), deliveries }
  }
}
