import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { classifyGitHubObservation } from "./classifier"
import { evaluateGitHubDelivery, shouldTrackGitHubWorkflowConclusion } from "./gate"
import { projectGitHubDelivery } from "./projection"
import { launchGitHubProposal } from "./proposal"
import { GitHubStore } from "./store"
import {
  GitHubIntegrationConfig,
  type GitHubDelivery,
  type GitHubIntegrationConfig as IntegrationConfig,
} from "./types"

export namespace GitHubRuntime {
  const log = Log.create({ service: "github-shadow-runtime" })
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
      while (activeConfig?.enabled) {
        const delivery = await GitHubStore.claimNext(failedDeliveryGuids)
        if (!delivery) break
        const config = activeConfig
        try {
          await processDelivery(delivery, config)
        } catch (error) {
          log.warn("delivery processing failed", { deliveryGuid: delivery.deliveryGuid, error })
          failedDeliveryGuids.add(delivery.deliveryGuid)
          await GitHubStore.update(delivery.deliveryGuid, (draft) => {
            draft.status = "retryable_failure"
            draft.retryCount++
            draft.statusMetadata = { processing: "failed" }
          })
        }
      }
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

    await GitHubStore.update(delivery.deliveryGuid, (draft) => {
      draft.observation = observation
      draft.triggerDecision = decision.decision
      draft.status = decision.classifierNeeded || decision.proposalTriggered ? "processing" : terminalStatus
      draft.statusMetadata = { routing: decision.decision, reason: decision.reason }
    })

    if (decision.classifierNeeded) {
      const result = await classifyGitHubObservation(observation, config.modelBudgetNano)
      const classificationTriggersProposal = result.classification?.relevant && result.classification.category === "bug"
      const task =
        classificationTriggersProposal && config.proposalEnabled
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
        draft.status = classificationTriggersProposal ? "completed" : "ignored"
        draft.statusMetadata = {
          routing: classificationTriggersProposal ? "classified_bug" : "classified_ignored",
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
