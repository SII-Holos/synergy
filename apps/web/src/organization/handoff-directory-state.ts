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

export function organizationDirectoryLabel(value: OrganizationNativeDirectory | undefined, view: Handoff.View) {
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
