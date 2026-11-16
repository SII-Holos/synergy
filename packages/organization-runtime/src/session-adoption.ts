import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { OrganizationRuntimeError } from "./error"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import type { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export namespace OrganizationSessionAdoption {
  const authority = RuntimeContext.createAsyncContext<{ runtime: RuntimeContext.Instance; permit: Handoff.Permit }>()
  function denied(message: string): never {
    throw new OrganizationRuntimeError({ code: "PERMISSION_DENIED", message, outcome: "rejected", retryable: false })
  }
  export async function run<T>(
    authorization: Handoff.SignedPermit,
    connection: z.infer<typeof Runtime.Connected>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { permit, signature } = Handoff.SignedPermit.parse(authorization)
    const identity = connection.signingIdentity
    if (
      permit.purpose !== "handoff-activation" ||
      !permit.sourceBinding ||
      permit.targetRuntimeID !== connection.runtimeID ||
      permit.orgID !== connection.orgID ||
      permit.deploymentIncarnation !== connection.deploymentIncarnation ||
      permit.keyID !== identity.keyID ||
      identity.orgID !== permit.orgID ||
      identity.deploymentIncarnation !== permit.deploymentIncarnation ||
      !(await Handoff.verifyPermit(permit, signature, identity.publicKey))
    )
      throw new OrganizationRuntimeError({
        code: "PERMISSION_DENIED",
        message: "Session adoption requires the exact destination activation permit",
        outcome: "rejected",
        retryable: false,
      })
    if (
      permit.sourceBinding.orgID !== permit.orgID ||
      permit.sourceBinding.driverRuntimeID !== permit.sourceRuntimeID ||
      permit.sourceBinding.bindingEpoch !== permit.fromEpoch
    )
      denied("Session adoption permit has inconsistent source ownership")
    return authority.run({ runtime: RuntimeContext.current(), permit }, fn)
  }

  export async function binding(input: SessionSchemaRegistry.TransferMutation) {
    const active = authority.getStore()
    if (!active || active.runtime !== RuntimeContext.current())
      denied("Session adoption requires a verified organization activation authority")
    const { permit } = active
    const epoch = Epochs.assertActivation({ sessionID: input.sessionID, handoffID: input.handoffID })
    const reserved = await Epochs.targetPreparation({ sessionID: input.sessionID, handoffID: input.handoffID })
    const source = OrganizationProtocol.SessionBinding.parse(input.source.organization)
    const expected = permit.sourceBinding
    if (
      !expected ||
      JSON.stringify(source) !== JSON.stringify(expected) ||
      permit.handoffID !== input.handoffID ||
      permit.sessionID !== input.rootSessionID ||
      (epoch.rootSessionID ?? epoch.sessionID) !== input.rootSessionID ||
      epoch.scopeID !== source.projectID ||
      epoch.sourceID !== permit.sourceRuntimeID ||
      epoch.targetID !== permit.targetRuntimeID ||
      epoch.fromEpoch !== permit.fromEpoch ||
      epoch.toEpoch !== permit.toEpoch ||
      reserved.manifestHash !== permit.manifestHash
    )
      denied("Session adoption does not match the signed source, manifest and canonical destination epoch")
    if (
      input.source.id !== input.sessionID ||
      !z.object({ type: z.literal("project"), id: z.literal(source.projectID) }).safeParse(input.source.scope).success
    )
      denied("Session adoption changed its canonical identity or project Scope")
    const target = OrganizationProtocol.SessionBinding.parse({
      ...source,
      driverRuntimeID: permit.targetRuntimeID,
      bindingEpoch: permit.toEpoch,
    })
    if (
      input.parent &&
      JSON.stringify(OrganizationProtocol.SessionBinding.parse(input.parent.organization)) !== JSON.stringify(target)
    )
      denied("Session adoption must retain its activated parent's ownership")
    if (input.previous) {
      const previous = OrganizationProtocol.SessionBinding.parse(input.previous.organization)
      if (
        input.previous.id !== input.source.id ||
        input.previous.parentID !== input.source.parentID ||
        previous.orgID !== source.orgID ||
        previous.projectID !== source.projectID ||
        previous.creatorID !== source.creatorID ||
        previous.driverRuntimeID !== target.driverRuntimeID ||
        previous.bindingEpoch >= permit.fromEpoch
      )
        denied("Session adoption cannot replace unrelated native ownership")
    }
    return target
  }
}
