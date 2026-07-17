import { githubPayloadRecord } from "./payload"
import {
  GitHubIntegrationConfig,
  GitHubTriggerDecision,
  type GitHubDelivery,
  type GitHubTriggerDecision as TriggerDecision,
} from "./types"

const ISSUE_SIGNAL =
  /\b(bug|crash|crashes|crashed|error|exception|broken|failure|fails|failed|regression|reproducible|reproduce)\b/i

function eventKey(delivery: GitHubDelivery) {
  const action = githubPayloadRecord(delivery.rawPayload).action
  return typeof action === "string" && action ? `${delivery.eventType}.${action}` : delivery.eventType
}

function senderIsBot(delivery: GitHubDelivery) {
  return /\[bot\]$/i.test(delivery.senderLogin)
}

function repositoryIsWatched(delivery: GitHubDelivery, config: GitHubIntegrationConfig) {
  return (
    !config.watchedRepositories?.length ||
    config.watchedRepositories.some(
      (repository) => repository.toLowerCase() === delivery.repositoryFullName.toLowerCase(),
    )
  )
}

function eventIsConfigured(delivery: GitHubDelivery, config: GitHubIntegrationConfig) {
  const normalizedEvent = eventKey(delivery)
  const configured = [...config.eventTypes, ...(config.reviewWorkflow.enabled ? config.reviewWorkflow.eventTypes : [])]
  return configured.some((event) => event.toLowerCase() === normalizedEvent.toLowerCase())
}

export function shouldTrackGitHubWorkflowConclusion(delivery: GitHubDelivery, inputConfig: GitHubIntegrationConfig) {
  const config = GitHubIntegrationConfig.parse(inputConfig)
  return (
    !senderIsBot(delivery) &&
    repositoryIsWatched(delivery, config) &&
    eventIsConfigured(delivery, config) &&
    eventKey(delivery).toLowerCase() === "workflow_run.completed"
  )
}

type DecisionInput = Omit<TriggerDecision, "deliveryGuid" | "eventType" | "fixTriggered" | "reviewTriggered"> &
  Partial<Pick<TriggerDecision, "fixTriggered" | "reviewTriggered">>

function decision(delivery: GitHubDelivery, value: DecisionInput): TriggerDecision {
  return GitHubTriggerDecision.parse({
    deliveryGuid: delivery.deliveryGuid,
    eventType: eventKey(delivery),
    ...value,
  })
}

export function evaluateGitHubDelivery(
  delivery: GitHubDelivery,
  inputConfig: GitHubIntegrationConfig,
  priorCiFailures: number,
): TriggerDecision {
  const config = GitHubIntegrationConfig.parse(inputConfig)
  const normalizedEvent = eventKey(delivery)
  const isReviewEvent = config.reviewWorkflow.enabled && config.reviewWorkflow.eventTypes.includes(normalizedEvent)

  if (senderIsBot(delivery) && !isReviewEvent) {
    return decision(delivery, {
      decision: "ignored_bot",
      reason: `Sender ${delivery.senderLogin} is a bot`,
      classifierNeeded: false,
      proposalTriggered: false,
    })
  }

  if (!repositoryIsWatched(delivery, config)) {
    return decision(delivery, {
      decision: "ignored_type",
      reason: `Repository ${delivery.repositoryFullName} is not watched`,
      classifierNeeded: false,
      proposalTriggered: false,
    })
  }

  if (!eventIsConfigured(delivery, config)) {
    return decision(delivery, {
      decision: "ignored_type",
      reason: `Event ${normalizedEvent} is not configured`,
      classifierNeeded: false,
      proposalTriggered: false,
    })
  }

  if (isReviewEvent) {
    const mapped = !!config.reviewWorkflow.repositoryMapping[delivery.repositoryFullName]
    return decision(delivery, {
      decision: mapped ? "gated_pr" : "ignored_type",
      reason: mapped
        ? `Pull request event ${normalizedEvent} requires review and tests`
        : `Repository ${delivery.repositoryFullName} is unmapped for review workflow`,
      classifierNeeded: false,
      proposalTriggered: false,
      reviewTriggered: mapped,
    })
  }

  const payload = githubPayloadRecord(delivery.rawPayload)
  if (normalizedEvent === "issues.opened") {
    const issue = githubPayloadRecord(payload.issue)
    const title = typeof issue.title === "string" ? issue.title : ""
    const body = typeof issue.body === "string" ? issue.body : ""
    if (ISSUE_SIGNAL.test(`${title}\n${body}`)) {
      const mapped = !!config.fixWorkflow.repositoryMapping[delivery.repositoryFullName]
      return decision(delivery, {
        decision: "gated_issue",
        reason:
          config.fixWorkflow.enabled && !mapped
            ? `Repository ${delivery.repositoryFullName} is unmapped for fix workflow`
            : "Issue contains a deterministic bug or failure signal",
        classifierNeeded: false,
        proposalTriggered: config.proposalEnabled && !config.fixWorkflow.enabled,
        fixTriggered: config.fixWorkflow.enabled && mapped,
      })
    }
    return decision(delivery, {
      decision: "ambiguous_issue",
      reason: "Issue does not contain a deterministic bug or failure signal",
      classifierNeeded: config.classifierEnabled,
      proposalTriggered: false,
    })
  }

  if (normalizedEvent === "workflow_run.completed") {
    const workflowRun = githubPayloadRecord(payload.workflow_run)
    if (workflowRun.conclusion === "failure" && priorCiFailures + 1 >= config.ciFailureThreshold) {
      return decision(delivery, {
        decision: "gated_ci",
        reason: `Workflow reached ${priorCiFailures + 1} consecutive failures`,
        classifierNeeded: false,
        proposalTriggered: config.proposalEnabled,
      })
    }
    return decision(delivery, {
      decision: "ignored_type",
      reason:
        workflowRun.conclusion === "failure"
          ? `Workflow failure count ${priorCiFailures + 1} is below threshold ${config.ciFailureThreshold}`
          : `Workflow conclusion ${String(workflowRun.conclusion ?? "unknown")} does not trigger a proposal`,
      classifierNeeded: false,
      proposalTriggered: false,
    })
  }

  return decision(delivery, {
    decision: "ignored_type",
    reason: `Event ${normalizedEvent} has no GitHub handler`,
    classifierNeeded: false,
    proposalTriggered: false,
  })
}
