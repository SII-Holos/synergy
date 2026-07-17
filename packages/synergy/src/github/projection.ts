import { githubPayloadRecord } from "./payload"
import { GitHubObservation, type GitHubDelivery } from "./types"

function text(value: unknown, max: number) {
  return typeof value === "string" && value ? value.slice(0, max) : undefined
}

export function projectGitHubDelivery(delivery: GitHubDelivery) {
  const payload = githubPayloadRecord(delivery.rawPayload)
  const action = text(payload.action, 100)
  const issue = githubPayloadRecord(payload.issue)
  const workflowRun = githubPayloadRecord(payload.workflow_run)
  const eventType = action ? `${delivery.eventType}.${action}` : delivery.eventType

  return GitHubObservation.parse({
    eventType,
    action,
    repository: delivery.repositoryFullName,
    sender: delivery.senderLogin || undefined,
    title: text(issue.title, 500),
    body: text(issue.body, 8_000),
    url: text(issue.html_url ?? workflowRun.html_url, 2_000),
    workflowName: text(workflowRun.name, 500),
    conclusion: text(workflowRun.conclusion, 100),
  })
}
