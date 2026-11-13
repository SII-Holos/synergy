import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { Persist } from "@/utils/persist"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { OrganizationNativeCleanupHandle } from "./handoff-native-cleanup-state"
import { OrganizationNativeDirectory } from "./handoff-directory-state"

export const OrganizationHandoffAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("prepare"), body: Handoff.CurrentPrepare }),
  z.strictObject({ kind: z.literal("accept"), body: Handoff.Accept }),
  z.strictObject({ kind: z.literal("permit"), body: Handoff.PermitRequest }),
  z.strictObject({ kind: z.literal("drive"), body: Handoff.Drive }),
  z.strictObject({ kind: z.literal("commit") }),
  z.strictObject({ kind: z.literal("cancel") }),
])
export type OrganizationHandoffAction = z.infer<typeof OrganizationHandoffAction>
const Cancellation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancel") }),
  z.strictObject({
    kind: z.literal("drive"),
    body: Handoff.Drive.safeExtend({ operation: z.literal("cancel-source") }),
  }),
])
export type OrganizationHandoffCancellation = z.infer<typeof Cancellation>
const Saved = z
  .strictObject({
    version: z.literal(1),
    projectID: z.string().min(1),
    sessionID: z.string().min(1),
    handoffID: z.string().min(1),
    pending: OrganizationHandoffAction.optional(),
    cancellation: Cancellation.optional(),
    cancellationNonce: z.uuid().optional(),
    nativeCleanup: OrganizationNativeCleanupHandle.optional(),
    nativeDirectory: OrganizationNativeDirectory.optional(),
  })
  .refine(
    (value) => value.pending?.kind !== "prepare" || value.pending.body.handoffID === value.handoffID,
    "Handoff recovery must retain its original preparation identity",
  )
  .refine(
    (value) =>
      !value.nativeCleanup ||
      (value.nativeCleanup.binding.handoffID === value.handoffID &&
        value.nativeCleanup.binding.sessionID === value.sessionID),
    "Native cleanup must retain its original conversation",
  )
  .refine(
    (value) => !value.nativeDirectory || value.nativeDirectory.plan.handoffID === value.handoffID,
    "Native directory labels must retain their original handoff",
  )
export type OrganizationHandoffSaved = z.infer<typeof Saved>

export function createOrganizationHandoffState(input: {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  owner: string
  projectID: string
  sessionID: string
}) {
  const { storage, owner, projectID, sessionID } = input
  const target = Persist.connection(owner, `organization-handoff:${projectID}:${sessionID}`)
  const key = `${target.storage}:${target.key}`
  function read() {
    const raw = storage.getItem(key)
    if (!raw) return
    const saved = Saved.parse(JSON.parse(raw))
    if (saved.projectID !== projectID || saved.sessionID !== sessionID)
      throw new Error("Handoff recovery has another owner")
    return saved
  }
  return {
    read,
    save(handoffID: string, pending?: OrganizationHandoffAction, directory?: OrganizationNativeDirectory) {
      const previous = read()
      const original = directory ? OrganizationNativeDirectory.parse(directory) : undefined
      if (
        (original &&
          (pending?.kind !== "prepare" ||
            original.plan.handoffID !== handoffID ||
            JSON.stringify(original.plan) !== JSON.stringify(pending.body) ||
            (previous?.nativeDirectory && JSON.stringify(original) !== JSON.stringify(previous.nativeDirectory)))) ||
        (previous?.cancellation && previous.handoffID !== handoffID) ||
        (previous?.pending &&
          (previous.handoffID !== handoffID || JSON.stringify(previous.pending) !== JSON.stringify(pending)))
      )
        throw new Error("Inspect the original handoff operation before replacing it")
      const saved = Saved.parse({
        version: 1,
        projectID,
        sessionID,
        handoffID,
        pending,
        cancellation: previous?.cancellation,
        cancellationNonce: previous?.cancellationNonce,
        nativeCleanup: previous?.handoffID === handoffID ? previous.nativeCleanup : undefined,
        nativeDirectory: previous?.handoffID === handoffID ? (previous.nativeDirectory ?? original) : original,
      })
      storage.setItem(key, JSON.stringify(saved))
      return saved
    },
    confirmed(handoffID: string) {
      const previous = read()
      if (previous?.handoffID !== handoffID) throw new Error("Handoff recovery has another request")
      const saved = Saved.parse({ ...previous, pending: undefined })
      storage.setItem(key, JSON.stringify(saved))
      return saved
    },
    cancel(handoffID: string, action: OrganizationHandoffCancellation, retry?: string) {
      const previous = read()
      if (previous?.handoffID !== handoffID) throw new Error("Inspect the original cancellation before replacing it")
      if (previous.cancellation) {
        if (
          action.kind === "drive" &&
          retry &&
          previous.cancellationNonce === retry &&
          JSON.stringify(previous.cancellation) === JSON.stringify(action)
        )
          return { accepted: true as const, retained: true as const, nonce: retry, saved: previous }
        return { accepted: false as const, retained: true as const, saved: previous }
      }
      if (retry) return { accepted: false as const, retained: false as const, saved: previous }
      const nonce = generateSecureUUID()
      const saved = Saved.parse({ ...previous, cancellation: Cancellation.parse(action), cancellationNonce: nonce })
      storage.setItem(key, JSON.stringify(saved))
      return { accepted: true as const, retained: false as const, nonce, saved }
    },
    cancelUnsent(handoffID: string, nonce: string) {
      const previous = read()
      if (
        previous?.handoffID !== handoffID ||
        previous.cancellationNonce !== nonce ||
        previous.cancellation?.kind !== "cancel"
      )
        return previous
      const saved = Saved.parse({ ...previous, cancellation: undefined, cancellationNonce: undefined })
      storage.setItem(key, JSON.stringify(saved))
      return saved
    },
    cancelConfirmed(handoffID: string) {
      const previous = read()
      if (previous?.handoffID !== handoffID) throw new Error("Handoff recovery has another request")
      const saved = Saved.parse({ ...previous, cancellation: undefined, cancellationNonce: undefined })
      storage.setItem(key, JSON.stringify(saved))
      return saved
    },
    rememberCleanup(handle: z.infer<typeof OrganizationNativeCleanupHandle>) {
      const original = OrganizationNativeCleanupHandle.parse(handle)
      const handoffID = original.binding.handoffID
      const previous = read()
      if (previous && previous.handoffID !== handoffID) throw new Error("Native cleanup has another retained handoff")
      if (previous?.nativeCleanup) {
        const saved = previous.nativeCleanup
        if (
          JSON.stringify(saved.binding) !== JSON.stringify(original.binding) ||
          saved.manifestHash !== original.manifestHash ||
          saved.runtime.publicKey !== original.runtime.publicKey ||
          saved.runtime.accountID !== original.runtime.accountID
        )
          throw new Error("Native cleanup changed its original destination")
        return previous
      }
      const saved = Saved.parse({ version: 1, projectID, sessionID, handoffID, ...previous, nativeCleanup: original })
      storage.setItem(key, JSON.stringify(saved))
      return saved
    },
    clear(handoffID: string) {
      if (read()?.handoffID === handoffID) storage.removeItem(key)
    },
  }
}

export function organizationHandoffOutcomeKnown(action: OrganizationHandoffAction, view: Handoff.View) {
  if (action.kind === "prepare")
    return (
      action.body.handoffID === view.handoffID &&
      (!action.body.environmentMapping ||
        JSON.stringify(action.body.environmentMapping) === JSON.stringify(view.environmentMapping))
    )
  if (
    view.phase === "cancelled" &&
    view.workspaceMapping.kind === "organization-native" &&
    action.kind === "drive" &&
    action.body.operation.endsWith("-target")
  )
    return false
  if (["completed", "cancelled", "retired"].includes(view.phase)) return true
  if (action.kind === "accept") {
    if (
      !view.targetAccepted ||
      action.body.mappingPlanRevision !== view.mappingPlanRevision ||
      ("mappingHash" in action.body && action.body.mappingHash !== view.mappingHash)
    )
      return false
    if (!("workspaceDifference" in action.body)) return true
    return (
      view.workspaceDifferenceAccepted === true &&
      !!view.workspaceDifference &&
      JSON.stringify(action.body.workspaceDifference) ===
        JSON.stringify(Handoff.DifferenceConsent.strip().parse(view.workspaceDifference))
    )
  }
  if (action.kind === "cancel")
    return view.cancelRequested || ["surrendered", "committed", "activation_permitted"].includes(view.phase)
  if (action.kind === "drive" && action.body.operation === "cancel-source")
    return ["surrendered", "committed", "activation_permitted"].includes(view.phase)
  if (action.kind === "commit") return ["committed", "activation_permitted"].includes(view.phase)
  if (action.kind === "permit")
    return action.body.purpose === "handoff-activation"
      ? view.phase === "activation_permitted"
      : ["surrendered", "committed", "activation_permitted"].includes(view.phase)
  return false
}

export function organizationHandoffMachineKnown(action: OrganizationHandoffAction, result: Handoff.MachineResult) {
  if (action.kind !== "drive" || result.state !== "complete") return false
  const stages: Partial<Record<Handoff.Drive["operation"], Handoff.MachineResult["stage"]>> = {
    "prepare-source": "source-frozen",
    "prepare-target": "target-prepared",
    "preview-target": "target-difference",
    "surrender-source": "source-surrendered",
    "cancel-source": "source-cancelled",
    "activate-target": "target-activated",
    "retire-target": "target-never-activate",
  }
  return stages[action.body.operation] === result.stage
}
