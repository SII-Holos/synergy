import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationKnowledgeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationKnowledge } from "../../../organization/src/knowledge"
import { OrganizationPublications } from "../../../organization/src/publications"
import type { completedHostedTask } from "./hosted-task"

type Rows = Map<string, unknown>
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export async function captureKnowledgeHistory(selected: Parameters<typeof completedHostedTask>[0]) {
  return selected.service.service.maintenance.run(() =>
    Storage.snapshot(async () => {
      const rows: Rows = new Map()
      for (const prefix of [["organization"], ["organization-knowledge"], ["organization-publications"]])
        for await (const row of Storage.records({ prefix, limit: 128 }))
          rows.set(JSON.stringify(row.key), structuredClone(row.value))
      return rows
    }),
  )
}

export async function verifyFailedKnowledgeHistory(input: {
  selected: Parameters<typeof completedHostedTask>[0]
  sessionID: string
  reference: Protocol.Reference
  originalUpdateID: string
  desired: Protocol.SelectionSummary
  beforeUpdate: Rows
}) {
  const { selected, sessionID, reference } = input
  const statusKey = ["organization-knowledge", "activation-status", sessionID]
  const snapshot = () => captureKnowledgeHistory(selected)
  function source(rows: Rows) {
    const groups = new Map<string, string>()
    const accepted = new Set<string>()
    const reader: OrganizationPublications.HistoricalSource = {
      read(schema, key) {
        return schema.parse(structuredClone(rows.get(JSON.stringify(key))))
      },
      *entries(prefix) {
        for (const [encoded, value] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
          const key: string[] = JSON.parse(encoded)
          if (prefix.every((part, index) => key[index] === part)) yield { key, value: structuredClone(value) }
        }
      },
      accept(key) {
        const encoded = JSON.stringify(key)
        if (!rows.has(encoded)) throw new Error("Historical Knowledge accepted a missing original row")
        accepted.add(encoded)
      },
      first(key, value) {
        const encoded = JSON.stringify(key),
          digest = hash(value),
          previous = groups.get(encoded)
        if (previous !== undefined && previous !== digest) throw new Error("Changed original Knowledge history group")
        if (previous !== undefined) return false
        groups.set(encoded, digest)
        return true
      },
      async binary(key, maximum) {
        const bytes = await selected.service.service.maintenance.run(() => Storage.readBinary(key))
        if (bytes.byteLength > maximum) throw new Error("The original Knowledge chunk exceeds its declared bound")
        return bytes
      },
    }
    return { reader, accepted }
  }
  async function history(rows: Rows, original = source(rows)) {
    OrganizationPublications.historicalRequests(original.reader)
    await OrganizationKnowledge.history(original.reader)
    expect(original.accepted.has(JSON.stringify(statusKey))).toBe(true)
  }
  const beforeUpdate = structuredClone(input.beforeUpdate)
  expect(
    [...beforeUpdate.keys()].some((encoded) => {
      const key: string[] = JSON.parse(encoded)
      return key[0] === "organization-knowledge" && ["items", "updates", "update-requests"].includes(key[1]!)
    }),
  ).toBe(false)
  const originalEmpty = beforeUpdate.get(JSON.stringify(statusKey))
  if (!originalEmpty || typeof originalEmpty !== "object" || !("activated" in originalEmpty))
    throw new Error("The original pre-update task has no genuine empty activation")
  const empty = Protocol.SelectionSummary.parse(originalEmpty.activated)
  expect(empty.releaseCount).toBe(0)
  const invalidHash = empty.manifestHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)
  beforeUpdate.set(JSON.stringify(statusKey), { ...originalEmpty, failedManifestHash: invalidHash })
  const repeated = source(beforeUpdate)
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await history(beforeUpdate, repeated).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )
    if (outcome.kind !== "rejected") throw new Error("A rejected failed manifest became known on the same reader")
    expect(outcome.error).toMatchObject({
      data: {
        code: "PROTOCOL_MISMATCH",
        message: "Historical knowledge failed activation has no original completed desired selection",
      },
    })
  }
  const original = await snapshot()
  await history(original)
  const status = original.get(JSON.stringify(statusKey))
  if (!status || typeof status !== "object" || !("activated" in status))
    throw new Error("The actual failed Knowledge writer has no original activation")
  const activated = Protocol.SelectionSummary.parse(status.activated)
  const unknownHash = ["0", "1", "2"]
    .map((value) => value.repeat(64))
    .find((value) => value !== activated.manifestHash && value !== input.desired.manifestHash)
  if (!unknownHash) throw new Error("The original fixture has no distinct corruption hash")
  async function rejects(rows: Rows) {
    const outcome = await history(rows).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )
    if (outcome.kind !== "rejected") throw new Error("Historical Knowledge accepted incomplete original evidence")
    expect(outcome.error).toBeDefined()
  }
  for (const changed of [
    { ...status, activated: undefined },
    { ...status, failedManifestHash: "not-an-original-manifest" },
    { ...status, failedManifestHash: unknownHash },
    { ...status, activated: { ...activated, revision: activated.revision + 1 } },
  ]) {
    const rows = structuredClone(original)
    rows.set(JSON.stringify(statusKey), changed)
    await rejects(rows)
  }
  const missingActivated = structuredClone(original)
  missingActivated.delete(JSON.stringify(["organization-knowledge", "activated", sessionID, activated.manifestHash]))
  await rejects(missingActivated)
  const options = { headers: selected.service.headers, throwOnError: true as const }
  async function select(expectedRevision: number, requestID: string, restore: boolean) {
    const update = (
      await selected.service.client.orgKnowledge.beginSelectionUpdate(
        {
          requestID,
          target: { kind: "session", sessionID },
          expectedRevision,
        },
        options,
      )
    ).data
    await selected.service.client.orgKnowledge.patchSelectionUpdate(
      {
        updateID: update.updateID,
        sequence: 0,
        changes: [restore ? { itemID: reference.itemID, reference } : { itemID: reference.itemID }],
      },
      options,
    )
    return (
      await selected.service.client.orgKnowledge.commitSelectionUpdate(
        {
          updateID: update.updateID,
          expectedSequence: 1,
        },
        options,
      )
    ).data
  }
  const later = await select(input.desired.revision, "later-desired-after-original-failure", false)
  let desired: Protocol.SelectionSummary
  try {
    expect(later.manifestHash).not.toBe(input.desired.manifestHash)
    const stale = await snapshot()
    expect(hash(stale.get(JSON.stringify(statusKey)))).toBe(hash(status))
    await history(stale)
    const missingOriginal = structuredClone(stale)
    for (const encoded of missingOriginal.keys()) {
      const key: string[] = JSON.parse(encoded)
      if (key[0] !== "organization-knowledge") continue
      const value = missingOriginal.get(encoded)
      if (
        (key[1] === "updates" && key[4] === input.originalUpdateID) ||
        (key[1] === "manifests" && key[3] === input.originalUpdateID) ||
        (key[1] === "update-requests" &&
          value !== null &&
          typeof value === "object" &&
          "updateID" in value &&
          value.updateID === input.originalUpdateID)
      )
        missingOriginal.delete(encoded)
    }
    await rejects(missingOriginal)
  } finally {
    desired = await select(later.revision, "restore-original-desired-without-retrying-activation", true)
  }
  const failed = (await selected.service.client.orgKnowledge.status({ sessionID }, options)).data
  expect(failed).toMatchObject({ state: "failed", error: "update_failed", desired })
  const final = await snapshot()
  expect(hash(final.get(JSON.stringify(statusKey)))).toBe(hash(status))
  await history(final)
  return { desired, failed }
}
