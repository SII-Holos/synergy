import { Config } from "@/config/config"
import { GitHubAppAuth } from "./app-auth"
import { Log } from "@/util/log"
import { classifyGitHubObservation } from "./classifier"
import { evaluateGitHubDelivery, shouldTrackGitHubWorkflowConclusion } from "./gate"
import { projectGitHubDelivery } from "./projection"
import { launchGitHubProposal } from "./proposal"
import { GitHubStore } from "./store"
import { GitHubWorkflowOrchestrator } from "./workflow-orchestrator"
import {
  GitHubIntegrationConfig,
  type GitHubDelivery,
  type GitHubIntegrationConfig as IntegrationConfig,
} from "./types"

export namespace GitHubRuntime {
  const log = Log.create({ service: "github-runtime" })
  const DELIVERY_CONCURRENCY = 4
  let activeConfig: IntegrationConfig | undefined
  let worker: Promise<void> | undefined
  let wakeRequested = false

  export async function start(input?: IntegrationConfig) {
    const configured = input ?? (await Config.globalResolved()).github ?? {}
    activeConfig = GitHubIntegrationConfig.parse(configured)
    if (!activeConfig.enabled) return
    await GitHubStore.recoverInFlight()
    notify()
  }

  export function notify() {
    if (!activeConfig?.enabled) return
    wakeRequested = true
    if (worker) return
    worker = runWorker().finally(() => {
      worker = undefined
      if (wakeRequested && activeConfig?.enabled) notify()
    })
  }

  export async function stop() {
    activeConfig = undefined
    wakeRequested = false
    await worker
    worker = undefined
    GitHubAppAuth.reset()
  }
  export async function reload(input?: IntegrationConfig) {
    await stop()
    await start(input)
  }

  export async function reset() {
    await stop()
  }

  async function runWorker() {
    const failedDeliveryGuids = new Set<string>()
    while (activeConfig?.enabled && wakeRequested) {
      wakeRequested = false
      const running = new Set<Promise<void>>()
      while (activeConfig?.enabled || running.size > 0) {
        while (activeConfig?.enabled && running.size < DELIVERY_CONCURRENCY) {
          const delivery = await GitHubStore.claimNext(failedDeliveryGuids)
          if (!delivery) break
          const config = activeConfig
          let task!: Promise<void>
          task = processClaimedDelivery(delivery, config, failedDeliveryGuids).finally(() => running.delete(task))
          running.add(task)
        }
        if (running.size === 0) break
        await Promise.race(running)
      }
    }
  }

  async function processClaimedDelivery(
    delivery: GitHubDelivery,
    config: IntegrationConfig,
    failedDeliveryGuids: Set<string>,
  ) {
    try {
      await processDelivery(delivery, config)
    } catch (error) {
      log.warn("delivery processing failed", { deliveryGuid: delivery.deliveryGuid, error })
      failedDeliveryGuids.add(delivery.deliveryGuid)
      await GitHubStore.update(delivery.deliveryGuid, (draft) => {
        const nextRetryCount = draft.retryCount + 1
        const maxRetries =
          draft.status === "processing_fix"
            ? config.fixWorkflow.maxRetries
            : draft.status === "processing_review"
              ? config.reviewWorkflow.maxRetries
              : Math.max(config.fixWorkflow.maxRetries, config.reviewWorkflow.maxRetries)
        draft.status = nextRetryCount > maxRetries ? "permanent_failure" : "retryable_failure"
        draft.retryCount = nextRetryCount
        draft.statusMetadata = { ...(draft.statusMetadata ?? {}), processing: "failed" }
      })
    }
  }

  export async function processDelivery(delivery: GitHubDelivery, inputConfig: IntegrationConfig) {
    const config = GitHubIntegrationConfig.parse(inputConfig)
    const observation = projectGitHubDelivery(delivery)
    let priorCiFailures = 0

    if (shouldTrackGitHubWorkflowConclusion(delivery, config) && observation.workflowName) {
      const failures = await GitHubStore.registerWorkflowConclusion({
        repository: delivery.repositoryFullName,
        workflowName: observation.workflowName,
        conclusion: observation.conclusion,
        occurredAt: delivery.receivedAt,
        windowHours: config.ciFailureWindowHours,
      })
      priorCiFailures = failures.priorFailures
    }

    const decision = evaluateGitHubDelivery(delivery, config, priorCiFailures)
    const terminalStatus =
      decision.decision === "gated_issue" || decision.decision === "gated_ci" ? "completed" : "ignored"
    const processingStatus = decision.fixTriggered
      ? "processing_fix"
      : decision.reviewTriggered
        ? "processing_review"
        : decision.classifierNeeded || decision.proposalTriggered
          ? "processing"
          : terminalStatus

    await GitHubStore.update(delivery.deliveryGuid, (draft) => {
      draft.observation = observation
      draft.triggerDecision = decision.decision
      draft.status = processingStatus
      draft.statusMetadata = { ...(draft.statusMetadata ?? {}), routing: decision.decision, reason: decision.reason }
    })

    const routedDelivery = { ...delivery, observation }
    if (decision.fixTriggered) {
      await GitHubWorkflowOrchestrator.processFixDelivery(routedDelivery, config)
      return
    }
    if (decision.reviewTriggered) {
      await GitHubWorkflowOrchestrator.processReviewDelivery(routedDelivery, config)
      return
    }

    if (decision.classifierNeeded) {
      const result = await classifyGitHubObservation(observation, config.modelBudgetNano)
      const classificationTriggersAction = result.classification?.relevant && result.classification.category === "bug"
      if (classificationTriggersAction && config.fixWorkflow.enabled) {
        await GitHubStore.update(delivery.deliveryGuid, (draft) => {
          draft.triggerDecision = "try_classify"
          draft.classification = result.classification
          draft.status = "processing_fix"
          draft.statusMetadata = {
            ...(draft.statusMetadata ?? {}),
            routing: "classified_bug_fix",
            ...(result.skippedReason ? { classifier: result.skippedReason } : {}),
          }
        })
        await GitHubWorkflowOrchestrator.processFixDelivery(routedDelivery, config)
        return
      }
      const task =
        classificationTriggersAction && config.proposalEnabled
          ? await launchGitHubProposal({
              deliveryGuid: delivery.deliveryGuid,
              eventType: observation.eventType,
              observation,
              budget: config.modelBudgetProposal,
            })
          : undefined
      await GitHubStore.update(delivery.deliveryGuid, (draft) => {
        draft.triggerDecision = "try_classify"
        draft.classification = result.classification
        draft.proposalTaskId = task?.id
        draft.status = classificationTriggersAction ? "completed" : "ignored"
        draft.statusMetadata = {
          ...(draft.statusMetadata ?? {}),
          routing: classificationTriggersAction ? "classified_bug" : "classified_ignored",
          ...(result.skippedReason ? { classifier: result.skippedReason } : {}),
        }
      })
      return
    }

    if (decision.proposalTriggered) {
      const task = await launchGitHubProposal({
        deliveryGuid: delivery.deliveryGuid,
        eventType: observation.eventType,
        observation,
        budget: config.modelBudgetProposal,
      })
      await GitHubStore.update(delivery.deliveryGuid, (draft) => {
        draft.proposalTaskId = task.id
        draft.status = "completed"
      })
    }
  }
}
