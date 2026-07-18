import { githubPayloadRecord } from "./payload"
import { GitHubObservation, type GitHubDelivery } from "./types"

function text(value: unknown, max: number) {
  return typeof value === "string" && value ? value.slice(0, max) : undefined
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

export function projectGitHubDelivery(delivery: GitHubDelivery) {
  const payload = githubPayloadRecord(delivery.rawPayload)
  const action = text(payload.action, 100)
  const issue = githubPayloadRecord(payload.issue)
  const pullRequest = githubPayloadRecord(payload.pull_request)
  const pullHead = githubPayloadRecord(pullRequest.head)
  const pullBase = githubPayloadRecord(pullRequest.base)
  const repository = githubPayloadRecord(payload.repository)
  const installation = githubPayloadRecord(payload.installation)
  const workflowRun = githubPayloadRecord(payload.workflow_run)
  const eventType = action ? `${delivery.eventType}.${action}` : delivery.eventType

  return GitHubObservation.parse({
    eventType,
    action,
    repository: delivery.repositoryFullName,
    sender: delivery.senderLogin || undefined,
    title: text(issue.title ?? pullRequest.title, 500),
    body: text(issue.body ?? pullRequest.body, 8_000),
    url: text(issue.html_url ?? pullRequest.html_url ?? workflowRun.html_url, 2_000),
    issueNumber: positiveInteger(issue.number),
    pullRequestNumber: positiveInteger(pullRequest.number),
    headSha: text(pullHead.sha, 500),
    headRef: text(pullHead.ref, 500),
    baseRef: text(pullBase.ref, 500),
    defaultBranch: text(repository.default_branch, 500),
    installationId: delivery.installationId ?? positiveInteger(installation.id),
    workflowName: text(workflowRun.name, 500),
    conclusion: text(workflowRun.conclusion, 100),
  })
}
