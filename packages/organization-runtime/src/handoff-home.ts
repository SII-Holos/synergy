import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import type { RuntimeIdentity } from "./home"
import { readRuntimeRegistration } from "./registration"
import { MemberHomeError } from "./record"
import { OrganizationRuntimeError } from "./error"

export async function assertHandoffHome(identity: RuntimeIdentity, runtimeID: string, plan: Handoff.MachinePlan) {
  const fail = (): never => {
    throw new OrganizationRuntimeError({
      code: "HANDOFF_BLOCKED",
      message: "Handoff controller does not own this enrolled Runtime Home",
      outcome: "rejected",
      retryable: false,
    })
  }
  const registration = await readRuntimeRegistration(RuntimeContext.current().host.home, identity).catch((error) => {
    if (error instanceof MemberHomeError || error instanceof HomeOwnershipFile.Error) fail()
    throw error
  })
  if (
    !registration ||
    registration.state !== "active" ||
    registration.runtimeID !== runtimeID ||
    registration.runtimeID !== plan.runtimeID ||
    registration.orgID !== plan.orgID ||
    registration.deploymentIncarnation !== plan.deploymentIncarnation
  )
    fail()
}
