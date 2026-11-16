import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationHandoffWorkspaceDrain {
  function directory(workspace: Readonly<WorkspaceCatalog.Info>) {
    return (
      workspace.lifecycle === "active" &&
      workspace.binding.state === "bound" &&
      workspace.backend?.provider === "directory" &&
      !!workspace.binding.path &&
      !!workspace.binding.physicalID &&
      workspace.sharedWritableWorkspaceIDs.length === 0
    )
  }
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "unknown", retryable: false })
  }
  export async function inspectNative(
    session: Readonly<Session.Info>,
    workspace: Readonly<WorkspaceCatalog.Info>,
    assert: () => void,
  ) {
    assert()
    if (!directory(workspace)) return false
    const mount = workspace.activeMount
    if (!mount) return true
    if (
      mount.state !== "active" ||
      mount.path !== workspace.binding.path ||
      mount.target.environmentID !== session.environmentID
    )
      return false
    const environment = await Environment.assertTarget(mount.target, session.scope.id)
    assert()
    if (EnvironmentProviders.get(environment.provider).ownership !== "borrowed") return false
    try {
      await EnvironmentExecution.assertSessionDrained(
        session.scope.id,
        session.id,
        session.environmentID,
        session.workspaceID,
      )
      assert()
      const uses = await Environment.uses(environment.id)
      assert()
      return uses.length === 0
    } catch (error) {
      assert()
      if (error instanceof Environment.Busy) return false
      throw error
    }
  }
  export async function prepare(
    plan: Readonly<Handoff.MachinePlan>,
    context: Readonly<Owners.SourceContext>,
    assert: () => void,
    verify: () => Promise<void>,
  ) {
    assert()
    if (!context.session.workspaceID) return
    const root = await Session.get(plan.sessionID)
    assert()
    if (context.session.workspaceID !== root.workspaceID) return
    const workspace = await WorkspaceCatalog.get(context.session.workspaceID, context.session.scope.id)
    assert()
    const mount = workspace.activeMount
    if (!mount || !directory(workspace)) return
    if (
      context.rootSessionID !== plan.sessionID ||
      context.handoffID !== plan.handoffID ||
      context.session.scope.id !== plan.sourceBinding.projectID ||
      mount.target.environmentID !== context.session.environmentID ||
      mount.path !== workspace.binding.path ||
      !["active", "saving"].includes(mount.state)
    )
      fail("Native Workspace drainage requires its original source mount and selection")
    const epoch = async () => {
      await verify()
      const binding = await Epochs.ownerPreparationBinding({ sessionID: context.session.id, handoffID: plan.handoffID })
      assert()
      if (
        binding.scopeID !== plan.sourceBinding.projectID ||
        (binding.rootSessionID ?? binding.sessionID) !== plan.sessionID ||
        binding.sourceID !== plan.sourceRuntimeID ||
        binding.targetID !== plan.targetRuntimeID ||
        binding.fromEpoch !== plan.fromEpoch ||
        binding.toEpoch !== plan.toEpoch
      )
        fail("Native Workspace drainage has another actual source epoch")
    }
    await epoch()
    await EnvironmentExecution.drainSession({
      scopeID: context.session.scope.id,
      sessionID: context.session.id,
      signal: context.signal,
    })
    assert()
    const environment = await Environment.assertTarget(mount.target, context.session.scope.id)
    assert()
    if (EnvironmentProviders.get(environment.provider).ownership !== "borrowed")
      fail("Native Workspace drainage cannot move an allocated provider")
    const beforeEffect = async () => {
      await epoch()
      const current = await Session.get(context.session.id)
      assert()
      if (
        current.workspaceID !== workspace.id ||
        current.environmentID !== environment.id ||
        current.scope.id !== context.session.scope.id
      )
        fail("Native Workspace drainage changed its original Session selection")
      const catalog = await WorkspaceCatalog.get(workspace.id, workspace.scopeID)
      assert()
      if (
        !directory(catalog) ||
        catalog.binding.generation !== workspace.binding.generation ||
        catalog.binding.path !== workspace.binding.path ||
        catalog.binding.physicalID !== workspace.binding.physicalID ||
        catalog.activeMount?.id !== mount.id ||
        catalog.activeMount.generation !== mount.generation ||
        !Environment.sameTarget(catalog.activeMount.target, mount.target)
      )
        fail("Native Workspace drainage changed its actual original mount")
      const uses = await Environment.uses(environment.id)
      assert()
      for (const use of uses) {
        const ownership = use.ownership
        if (
          use.id !== `detach:${mount.id}` ||
          ownership.kind !== "workspace-mount" ||
          ownership.scopeID !== workspace.scopeID ||
          ownership.workspaceID !== workspace.id ||
          ownership.mountID !== mount.id ||
          ownership.mountGeneration !== mount.generation
        )
          throw new Environment.Busy({
            environmentID: environment.id,
            message: "Native Workspace drainage cannot release another active resource user",
          })
      }
      await Environment.assertTarget(mount.target, context.session.scope.id)
      assert()
    }
    await WorkspaceMounts.detach({
      workspaceID: workspace.id,
      scopeID: workspace.scopeID,
      expectedRevision: workspace.revision,
      beforeEffect,
      assertCurrent: assert,
    })
    await epoch()
  }
}
