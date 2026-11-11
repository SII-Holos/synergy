import { z } from "zod"
import { OrganizationKnowledgeProtocol as Knowledge } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Persist } from "@/utils/persist"

const Pending = Knowledge.BeginSelectionUpdate.extend({
  change: Knowledge.SelectionChange,
  updateID: Knowledge.SelectionUpdate.shape.updateID.optional(),
  sequence: z.number().int().nonnegative().optional(),
  phase: z.enum(["begin", "patch", "commit"]).default("begin"),
})
export function createKnowledgeUpdate(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, connection: string, owner: string) {
  const entry = Persist.connection(connection, `organization-knowledge-update:${owner}`)
  const key = `${entry.storage}:${entry.key}`
  function pending() {
    const raw = storage.getItem(key)
    return raw ? Pending.parse(JSON.parse(raw)) : undefined
  }
  function save(value: z.infer<typeof Pending>) {
    storage.setItem(key, JSON.stringify(Pending.parse(value)))
  }
  return {
    pending,
    begin(input: z.input<typeof Pending>) {
      if (pending()) throw new Error("Check the pending knowledge change before submitting another")
      save(Pending.parse(input))
    },
    async execute(api: OrganizationClient, signal: AbortSignal) {
      let current = pending()
      if (!current) throw new Error("No knowledge change is pending")
      const options = { throwOnError: true, signal } as const
      signal.throwIfAborted()
      let update = current.updateID
        ? (await api.orgKnowledge.selectionUpdate({ updateID: current.updateID }, options)).data
        : (await api.orgKnowledge.beginSelectionUpdate({
            requestID: current.requestID, target: current.target, expectedRevision: current.expectedRevision,
          }, options)).data
      signal.throwIfAborted()
      if (JSON.stringify(update.target) !== JSON.stringify(current.target) || update.baseRevision !== current.expectedRevision)
        throw new Error("Knowledge update belongs to another selection")
      if (update.state !== "committed") {
        if (current.phase === "begin") {
          current = { ...current, updateID: update.updateID, sequence: update.nextSequence, phase: "patch" }
          save(current)
        }
        if (current.phase === "patch") {
          update = (await api.orgKnowledge.patchSelectionUpdate({
            updateID: update.updateID, sequence: current.sequence!, changes: [current.change],
          }, options)).data
          signal.throwIfAborted()
          current = { ...current, sequence: update.nextSequence, phase: "commit" }
          save(current)
        }
      }
      const summary = update.state === "committed" ? update.committed
        : (await api.orgKnowledge.commitSelectionUpdate({ updateID: update.updateID, expectedSequence: current.sequence! }, options)).data
      signal.throwIfAborted()
      if (!summary) throw new Error("Committed knowledge update has no summary")
      storage.removeItem(key)
      return summary
    },
  }
}
