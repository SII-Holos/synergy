import { StoragePath } from "@/storage/path"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { GitHubDelivery, type GitHubDelivery as Delivery } from "./types"

type CiFailureState = {
  repository: string
  workflowName: string
  failures: number[]
}

export namespace GitHubStore {
  function deliveryLock(deliveryGuid: string) {
    return `github:delivery:${deliveryGuid}`
  }

  export async function accept(input: Delivery): Promise<{ duplicate: boolean; delivery: Delivery }> {
    const delivery = GitHubDelivery.parse(input)
    using _ = await Lock.write(deliveryLock(delivery.deliveryGuid))
    const existing = await get(delivery.deliveryGuid)
    if (existing) return { duplicate: true, delivery: existing }
    await Storage.write(StoragePath.githubDelivery(delivery.deliveryGuid), delivery)
    return { duplicate: false, delivery }
  }

  export async function get(deliveryGuid: string): Promise<Delivery | undefined> {
    const value = await Storage.read<unknown>(StoragePath.githubDelivery(deliveryGuid)).catch(() => undefined)
    if (value === undefined) return undefined
    const parsed = GitHubDelivery.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  export async function update(deliveryGuid: string, mutate: (draft: Delivery) => void): Promise<Delivery | undefined> {
    using _ = await Lock.write(deliveryLock(deliveryGuid))
    const current = await get(deliveryGuid)
    if (!current) return undefined
    const draft = structuredClone(current)
    mutate(draft)
    const next = GitHubDelivery.parse(draft)
    await Storage.write(StoragePath.githubDelivery(deliveryGuid), next)
    return next
  }

  export async function remove(deliveryGuid: string) {
    using _ = await Lock.write(deliveryLock(deliveryGuid))
    await Storage.remove(StoragePath.githubDelivery(deliveryGuid))
  }

  export async function list(): Promise<Delivery[]> {
    const root = StoragePath.githubDeliveriesRoot()
    const keys = await Storage.scan(root)
    const records = await Storage.readMany<unknown>(keys.map((key) => [...root, key]))
    return records.flatMap((record) => {
      const parsed = GitHubDelivery.safeParse(record)
      return parsed.success ? [parsed.data] : []
    })
  }

  export async function claimNext(excludedDeliveryGuids?: ReadonlySet<string>): Promise<Delivery | undefined> {
    using _ = await Lock.write("github:delivery:claim")
    const pending = (await list())
      .filter(
        (item) =>
          (item.status === "received" || item.status === "retryable_failure") &&
          !excludedDeliveryGuids?.has(item.deliveryGuid),
      )
      .sort((a, b) => a.receivedAt - b.receivedAt || a.deliveryGuid.localeCompare(b.deliveryGuid))
    const next = pending[0]
    if (!next) return undefined
    const claimed = { ...next, status: "processing" as const }
    await Storage.write(StoragePath.githubDelivery(next.deliveryGuid), GitHubDelivery.parse(claimed))
    return claimed
  }

  export async function recoverInFlight(): Promise<number> {
    const processing = (await list()).filter((item) => item.status === "processing")
    await Promise.all(
      processing.map((item) =>
        update(item.deliveryGuid, (draft) => {
          draft.status = "retryable_failure"
          draft.retryCount++
          draft.statusMetadata = { ...(draft.statusMetadata ?? {}), recovery: "server_restart" }
        }),
      ),
    )
    return processing.length
  }

  export async function registerWorkflowConclusion(input: {
    repository: string
    workflowName: string
    conclusion: string | undefined
    occurredAt: number
    windowHours: number
  }): Promise<{ priorFailures: number; currentFailures: number }> {
    const key = StoragePath.githubCiState(input.repository, input.workflowName)
    const lock = `github:ci:${input.repository}:${input.workflowName}`
    using _ = await Lock.write(lock)
    const current = await Storage.read<CiFailureState>(key).catch(() => ({
      repository: input.repository,
      workflowName: input.workflowName,
      failures: [],
    }))
    const cutoff = input.occurredAt - input.windowHours * 60 * 60 * 1_000
    const failures = current.failures.filter((timestamp) => timestamp >= cutoff && timestamp <= input.occurredAt)
    const priorFailures = failures.length
    const nextFailures = input.conclusion === "failure" ? [...failures, input.occurredAt] : []
    await Storage.write(key, { ...current, failures: nextFailures })
    return { priorFailures, currentFailures: nextFailures.length }
  }

  export async function readRuntimeState<T>(): Promise<T | undefined> {
    return Storage.read<T>(StoragePath.githubRuntimeState()).catch(() => undefined)
  }

  export async function writeRuntimeState<T>(state: T) {
    await Storage.write(StoragePath.githubRuntimeState(), state)
  }
}
