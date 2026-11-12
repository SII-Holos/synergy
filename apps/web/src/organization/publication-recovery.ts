import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationArtifactProtocol as Artifact,
  OrganizationKnowledgeProtocol as Knowledge,
} from "@ericsanchezok/synergy-organization-protocol"
import type { createOrganizationPublicationStore } from "./publication-store"
import { PublicationRecord } from "./publication-record"

type Store = ReturnType<typeof createOrganizationPublicationStore>
export async function inspectPublication(
  api: OrganizationClient,
  store: Store,
  value: PublicationRecord,
  signal: AbortSignal,
) {
  const record = PublicationRecord.parse(value)
  signal.throwIfAborted()
  const stored = await store.get(record.request.requestID)
  signal.throwIfAborted()
  if (!stored || stored.requestHash !== record.requestHash)
    throw new Error("The original publication metadata has changed")
  const options = { throwOnError: true, signal } as const
  if (record.purpose === "knowledge") {
    const result = Knowledge.PublicationReceipt.parse(
      (await api.orgKnowledge.publicationReceipt(record.request, options)).data,
    )
    signal.throwIfAborted()
    if (result.state === "published") await store.confirm(record, result.release)
    return result
  }
  const result = Artifact.PublicationReceipt.parse(
    (await api.orgArtifacts.publicationReceipt(record.request, options)).data,
  )
  signal.throwIfAborted()
  if (result.state === "published") await store.confirm(record, result.version)
  return result
}
export async function submitPublication(
  api: OrganizationClient,
  store: Store,
  value: PublicationRecord,
  signal: AbortSignal,
) {
  let record = PublicationRecord.parse(value)
  signal.throwIfAborted()
  const stored = await store.get(record.request.requestID)
  signal.throwIfAborted()
  if (!stored || stored.requestHash !== record.requestHash)
    throw new Error("The original publication metadata has changed")
  record = stored
  if (record.state !== "prepared") {
    const result = await inspectPublication(api, store, record, signal)
    if (result.state === "published") return
  }
  record = await store.attempt(record)
  signal.throwIfAborted()
  try {
    const options = { throwOnError: true, signal } as const
    const result =
      record.purpose === "knowledge"
        ? (await api.orgKnowledge.publish(record.request, options)).data
        : (await api.orgArtifacts.publish(record.request, options)).data
    signal.throwIfAborted()
    await store.confirm(record, result)
  } catch (error) {
    const notDispatched =
      !!error && typeof error === "object" && "outcome" in error && error.outcome === "not_dispatched"
    if (!signal.aborted) await store.failed(record, notDispatched).catch(() => undefined)
    throw error
  }
}
