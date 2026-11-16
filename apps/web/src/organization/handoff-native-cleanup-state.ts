import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"

export const OrganizationNativeCleanupHandle = z
  .strictObject({
    binding: Handoff.Binding,
    manifestHash: Handoff.Hash,
    runtime: Runtime.MemberRegistrationRecord,
  })
  .refine(
    (value) =>
      value.runtime.runtimeID === value.binding.targetRuntimeID &&
      value.runtime.orgID === value.binding.orgID &&
      value.runtime.deploymentIncarnation === value.binding.deploymentIncarnation,
    "Native cleanup must retain its original destination identity",
  )
export type OrganizationNativeCleanupHandle = z.infer<typeof OrganizationNativeCleanupHandle>

export function organizationNativeCleanupHandle(view: Handoff.View, runtime: Runtime.Registration) {
  if (
    view.phase !== "cancelled" ||
    !Handoff.isNativeTargetMapping(view.workspaceMapping) ||
    !view.manifestHash ||
    runtime.runtimeKind !== "member"
  )
    return
  return OrganizationNativeCleanupHandle.parse({
    binding: Handoff.Binding.strip().parse(view),
    manifestHash: view.manifestHash,
    runtime,
  })
}

export function organizationNativeCleanupResult(
  handle: OrganizationNativeCleanupHandle,
  requestID: string,
  value: unknown,
) {
  const result = Handoff.MachineResult.parse(value)
  if (
    result.handoffID !== handle.binding.handoffID ||
    result.runtimeID !== handle.runtime.runtimeID ||
    result.requestID !== requestID ||
    result.operation !== "inspect-target" ||
    result.requirements.length ||
    result.object ||
    result.workspaceDifference ||
    result.differencePage
  )
    throw new Error("The cleanup inspection returned another operation or private content")
  for (const fact of result.facts) {
    if (
      !["target-never-activate", "target-preview-released"].includes(fact.proof.purpose) ||
      fact.proof.manifestHash !== handle.manifestHash ||
      JSON.stringify(Handoff.Binding.strip().parse(fact.proof)) !== JSON.stringify(handle.binding)
    )
      throw new Error("The cleanup inspection returned another original binding")
  }
  const complete =
    result.state === "complete" &&
    ["target-never-activate", "target-preview-released"].includes(result.stage) &&
    result.facts.some((fact) => fact.proof.purpose === result.stage)
  if (result.state === "complete" && !complete) throw new Error("Cleanup completion requires its original target fact")
  return { result, complete }
}
