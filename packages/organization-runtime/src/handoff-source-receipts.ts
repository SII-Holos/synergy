import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import {
  SessionTransferSource as NativeSource,
  SessionTransferCore as Core,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationRuntimeError } from "./error"
import { OrganizationCommandRecords } from "./command-records"
import { OrganizationIntakePath } from "./storage/path"

type Observation =
  | { stage: "source-cancelled"; fact: Handoff.Proof }
  | {
      stage: "source-surrendered"
      fact: Handoff.Proof | undefined
      authorization: Handoff.SignedPermit | undefined
    }
type Binding = z.infer<typeof Handoff.Binding>
const fields = Object.keys(Handoff.Binding.shape) as (keyof Binding)[]
function fail(message: string): never {
  throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "not_dispatched", retryable: false })
}

export namespace OrganizationHandoffSourceReceipts {
  export const key = (
    binding: Binding,
    kind: "frozen" | "surrender-permit" | "resource-closure" | "resource-receipts",
  ) => ["organization_handoff_source", binding.orgID, binding.deploymentIncarnation, binding.handoffID, kind]

  export async function inspect(
    value: Binding,
    input: { scopeID?: string; signal?: AbortSignal } = {},
  ): Promise<Observation | undefined> {
    const binding = Handoff.Binding.strip().parse(value)
    const scopeID = input.scopeID,
      assert = WorkspaceContent.captureOwner(input.signal)
    assert()
    return Storage.snapshot(async () => {
      const retained = await NativeSource.retainedReceipt({
        handoffID: binding.handoffID,
        sessionID: binding.sessionID,
      })
      assert()
      if (!retained) return
      const native = retained.receipt.binding
      if (
        native.sourceID !== binding.sourceRuntimeID ||
        native.targetID !== binding.targetRuntimeID ||
        native.fromEpoch !== binding.fromEpoch ||
        native.toEpoch !== binding.toEpoch ||
        (scopeID !== undefined && native.scopeID !== scopeID)
      )
        fail("Source receipt has another original native binding")
      const [{ raw, info }, [stateValue]] = await Promise.all([
        Core.storedInfo({ scopeID: native.scopeID, sessionID: binding.sessionID }),
        Storage.readMany([OrganizationIntakePath.state(binding.orgID, binding.sessionID)]),
      ])
      const organization = OrganizationProtocol.SessionBinding.parse(raw.organization)
      const state = OrganizationCommandRecords.State.parse(stateValue)
      assert()
      if (
        info.parentID !== undefined ||
        info.scope.type !== "project" ||
        organization.orgID !== binding.orgID ||
        organization.projectID !== native.scopeID ||
        state.orgID !== binding.orgID ||
        state.sessionID !== binding.sessionID ||
        state.projectID !== native.scopeID
      )
        fail("Source receipt has another canonical organization or native Scope")
      if (retained.kind === "cancelled")
        return {
          stage: "source-cancelled",
          fact: Handoff.Proof.parse({
            ...binding,
            purpose: "source-cancelled",
            manifestHash: retained.receipt.manifestHash,
            gateCancelled: true,
            paused: true,
          }),
        }
      const [permitValue] = await Storage.readMany([key(binding, "surrender-permit")])
      assert()
      if (permitValue === undefined) return { stage: "source-surrendered", fact: undefined, authorization: undefined }
      const authorization = Handoff.SignedPermit.parse(permitValue),
        { permit } = authorization
      if (
        permit.purpose !== "handoff-surrender" ||
        !fields.every((field) => permit[field] === binding[field]) ||
        permit.manifestHash !== retained.receipt.manifestHash ||
        permit.preparedHash !== retained.receipt.preparedHash ||
        (permit.sourceBinding &&
          (permit.sourceBinding.orgID !== binding.orgID ||
            permit.sourceBinding.projectID !== native.scopeID ||
            permit.sourceBinding.driverRuntimeID !== native.sourceID ||
            permit.sourceBinding.bindingEpoch !== native.fromEpoch ||
            permit.sourceBinding.creatorID !== organization.creatorID))
      )
        fail("Source surrender receipt has another original authority")
      return {
        stage: "source-surrendered",
        authorization,
        fact: Handoff.Proof.parse({
          ...binding,
          purpose: "source-surrendered",
          manifestHash: retained.receipt.manifestHash,
          preparedHash: retained.receipt.preparedHash,
          permitID: permit.permitID,
          gatePersisted: true,
        }),
      }
    })
  }
}
