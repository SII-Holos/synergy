import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffRecovery as Recovery,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationNativeCleanupHandle } from "./handoff-native-cleanup-state"

type Owner = { orgID: string; deploymentIncarnation: string; accountID: string }
export function organizationOwnDevices(owner: Owner, value: unknown) {
  const page = Runtime.RegistrationPage.parse(value)
  if (
    page.items.some(
      (runtime) => runtime.orgID !== owner.orgID || runtime.deploymentIncarnation !== owner.deploymentIncarnation,
    )
  )
    throw new Error("Device registration page has another owner")
  return {
    items: page.items.filter(
      (runtime): runtime is Runtime.MemberRegistrationRecord =>
        runtime.runtimeKind === "member" && runtime.accountID === owner.accountID,
    ),
    cursor: page.cursor,
  }
}

export type OrganizationDeviceCleanupEntry = {
  descriptor: z.infer<typeof Recovery.Descriptor>
  handle: OrganizationNativeCleanupHandle
}
export function organizationDeviceCleanupPage(owner: Owner, runtime: Runtime.MemberRegistrationRecord, value: unknown) {
  const page = Recovery.Page.parse(value)
  if (
    runtime.orgID !== owner.orgID ||
    runtime.deploymentIncarnation !== owner.deploymentIncarnation ||
    runtime.accountID !== owner.accountID ||
    runtime.state !== "active" ||
    page.items.some(
      (item) =>
        item.orgID !== owner.orgID ||
        item.deploymentIncarnation !== owner.deploymentIncarnation ||
        item.targetRuntimeID !== runtime.runtimeID,
    )
  )
    throw new Error("Cleanup page has another active Runtime owner")
  return {
    items: page.items.map((descriptor): OrganizationDeviceCleanupEntry => ({
      descriptor,
      handle: OrganizationNativeCleanupHandle.parse({
        binding: Handoff.Binding.strip().parse(descriptor),
        manifestHash: descriptor.manifestHash,
        runtime,
      }),
    })),
    cursor: page.cursor,
  }
}
