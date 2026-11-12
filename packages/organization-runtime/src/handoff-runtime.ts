import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import type { Session } from "@ericsanchezok/synergy-harness/session"
import { OrganizationHandoffSource as Source } from "./handoff-source"
import { OrganizationHandoffTarget as Target } from "./handoff-target"
import { OrganizationRuntimeError } from "./error"
import { RuntimeIdentity } from "./home"
import type { MemberConnectionOptions } from "./connection"
import { createHandoffInspection } from "./handoff-inspection"

export function createRuntimeHandoff(input: { identity: RuntimeIdentity; runtimeID: string }) {
  const identity = RuntimeIdentity.parse(input.identity)
  const source = Source.create({ identity, runtimeID: input.runtimeID })
  const target = Target.create({ identity, runtimeID: input.runtimeID })
  const assertOwner = WorkspaceContent.captureOwner()
  const dispatch: NonNullable<MemberConnectionOptions["handoff"]> = async (
    authorization,
    connection,
    signal,
    resources,
  ) => {
    assertOwner()
    const plan = Handoff.SignedMachinePlan.parse(authorization).plan
    const current = Runtime.Connected.parse(connection)
    const value = {
      authorization,
      connection: current,
      signal,
      resources,
      async mapping(session: Readonly<Session.Info>) {
        assertOwner()
        signal.throwIfAborted()
        const environment = session.environmentID
          ? await Environment.select({ scopeID: session.scope.id, ownerID: `handoff:${plan.handoffID}:${session.id}` })
          : undefined
        assertOwner()
        signal.throwIfAborted()
        return { workspaceIDs: {}, environmentID: environment?.id ?? null }
      },
    }
    if (plan.operation === "inspect-source") return source.inspect(value)
    if (plan.operation === "inspect-target") return target.inspect(value)
    if (plan.operation === "object")
      return Handoff.MachineExecution.parse({
        handoffID: plan.handoffID,
        requestID: plan.requestID,
        runtimeID: plan.runtimeID,
        operation: plan.operation,
        state: "complete",
        stage: "source-frozen",
        revision: plan.manifestHash,
        requirements: [],
        facts: [],
        object: await source.range(value),
      })
    const fact =
      plan.operation === "prepare-source"
        ? await source.prepare(value)
        : plan.operation === "cancel-source"
          ? await source.cancel(value)
          : plan.operation === "surrender-source"
            ? await source.surrender(value)
            : plan.operation === "prepare-target"
              ? await target.prepare(value)
              : plan.operation === "preview-target"
                ? await target.preview(value)
                : plan.operation === "activate-target"
                  ? await target.activate(value)
                  : plan.operation === "retire-target"
                    ? await target.retire(value)
                    : undefined
    assertOwner()
    if (!fact)
      throw new OrganizationRuntimeError({
        code: "HANDOFF_BLOCKED",
        message: "This Runtime does not implement the selected handoff operation",
        outcome: "not_dispatched",
        retryable: false,
      })
    return Handoff.MachineExecution.parse({
      handoffID: plan.handoffID,
      requestID: plan.requestID,
      runtimeID: plan.runtimeID,
      operation: plan.operation,
      state: "complete",
      stage: fact.purpose,
      revision: await Handoff.proofHash(fact),
      requirements: [],
      facts: [fact],
      ...(fact.purpose === "target-difference" ? { workspaceDifference: fact.difference } : {}),
    })
  }
  return {
    dispatch,
    inspection: createHandoffInspection({ identity, runtimeID: input.runtimeID }),
    close: source.close,
  }
}
