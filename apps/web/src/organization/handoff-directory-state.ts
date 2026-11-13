import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { organizationNativeHandoffMapping } from "./handoff-native-state"

export const OrganizationNativeDirectory = z.strictObject({
  plan: Handoff.CurrentPrepare.refine((plan) => plan.workspaceMapping.kind === "organization-native"),
  label: z.string().min(1).max(255),
})
export type OrganizationNativeDirectory = z.infer<typeof OrganizationNativeDirectory>

export function organizationDirectoryFromOptions(input: {
  plan: z.infer<typeof Handoff.CurrentPrepare>
  options: Handoff.Options
  sessionID: string
  projectID: string
}) {
  const { plan, options } = input
  if (
    plan.workspaceMapping.kind !== "organization-native" ||
    !options.native ||
    options.sessionID !== input.sessionID ||
    options.projectID !== input.projectID ||
    options.targetRuntimeID !== plan.targetRuntimeID ||
    options.bindingEpoch !== plan.expectedBindingEpoch ||
    options.controlRevision !== plan.expectedControlRevision ||
    JSON.stringify(organizationNativeHandoffMapping(options, plan.workspaceMapping.moveID)) !==
      JSON.stringify(plan.workspaceMapping)
  )
    return
  return OrganizationNativeDirectory.parse({ plan, label: options.native.label })
}

export function organizationDirectoryFromInspection(view: Handoff.View, requestID: string, value: unknown) {
  const inspection = Handoff.NativeTargetSelection.parse(value)
  const target = view.workspaceMapping.kind === "organization-native" ? view.workspaceMapping.target : undefined
  if (
    !target ||
    inspection.requestID !== requestID ||
    inspection.handoffID !== view.handoffID ||
    inspection.targetRuntimeID !== view.targetRuntimeID ||
    inspection.mappingPlanRevision !== view.mappingPlanRevision ||
    inspection.mappingHash !== view.mappingHash ||
    inspection.native.reference.workspaceID !== target.workspaceID ||
    inspection.native.reference.generation !== target.generation ||
    inspection.native.reference.revision !== target.expectedRevision ||
    inspection.native.projectRevision !== target.projectRevision
  )
    throw new Error("Directory inspection returned another original selection")
  return inspection
}

export function organizationDirectoryLabel(
  value: OrganizationNativeDirectory | undefined,
  view: Handoff.View,
  inspection?: Handoff.NativeTargetSelection,
) {
  if (inspection) {
    try {
      return organizationDirectoryFromInspection(view, inspection.requestID, inspection).native.label
    } catch {
      return
    }
  }
  if (
    !value ||
    value.plan.handoffID !== view.handoffID ||
    value.plan.targetRuntimeID !== view.targetRuntimeID ||
    value.plan.expectedBindingEpoch !== view.fromEpoch ||
    value.plan.mappingPlanRevision !== view.mappingPlanRevision ||
    view.workspaceMapping.kind !== "organization-native" ||
    JSON.stringify(value.plan.workspaceMapping) !== JSON.stringify(view.workspaceMapping)
  )
    return
  return value.label
}
