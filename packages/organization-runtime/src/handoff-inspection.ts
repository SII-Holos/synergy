import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationCloudProtocol as Cloud,
} from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { SessionTransferEnvironments as Environments } from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationLocalProjects } from "./local-project"
import { RuntimeIdentity } from "./home"
import { assertHandoffHome } from "./handoff-home"
import { OrganizationRuntimeError } from "./error"
import { OrganizationHandoffWorkspaceDrain as WorkspaceDrain } from "./handoff-workspace-drain"
import type { MemberConnectionOptions } from "./connection"

export function createHandoffInspection(input: {
  identity: RuntimeIdentity
  runtimeID: string
}): NonNullable<MemberConnectionOptions["handoffInspection"]> {
  const identity = RuntimeIdentity.parse(input.identity)
  const runtimeID = input.runtimeID
  const owner = WorkspaceContent.captureOwner()
  const fail = (message: string): never => {
    throw new OrganizationRuntimeError({
      code: "HANDOFF_BLOCKED",
      message,
      outcome: "not_dispatched",
      retryable: false,
    })
  }
  return async (authorization, value, signal) => {
    const { plan, signature } = Handoff.SignedInspectionPlan.parse(authorization)
    const connection = Runtime.Connected.parse(value)
    const assert = () => {
      owner()
      signal.throwIfAborted()
      if (
        plan.runtimeID !== runtimeID ||
        connection.runtimeID !== runtimeID ||
        plan.orgID !== identity.orgID ||
        plan.orgID !== connection.orgID ||
        plan.deploymentIncarnation !== connection.deploymentIncarnation ||
        plan.connectionEpoch !== connection.connectionEpoch ||
        plan.keyID !== connection.signingIdentity.keyID ||
        plan.issuedAt > Date.now() ||
        plan.expiresAt <= Date.now()
      )
        fail("Handoff inspection requires its current finite enrolled connection")
    }
    assert()
    if (!(await Handoff.verifyInspection(plan, signature, connection.signingIdentity.publicKey)))
      fail("Handoff inspection signature is invalid")
    await assertHandoffHome(identity, runtimeID, plan)
    assert()
    let workspace: Handoff.InspectionResult["workspace"] = null
    let native: Handoff.InspectionResult["native"] = null
    let sourceEnvironment: Handoff.NativeEnvironmentSelection | null = null
    let nativeEnvironment: Handoff.NativeEnvironmentTarget | null = null
    let verifyEnvironment: (() => Promise<void>) | undefined
    if (plan.role === "source") {
      const source = await Session.get(plan.sessionID)
      assert()
      const binding = source.organization
      if (
        source.parentID ||
        source.time.archived ||
        source.scope.id !== plan.projectID ||
        binding?.orgID !== plan.orgID ||
        binding.driverRuntimeID !== plan.sourceRuntimeID ||
        binding.bindingEpoch !== plan.bindingEpoch
      )
        fail("Handoff source metadata has another current Session binding")
      const environment = await Environments.nativeSelection({
        environmentID: source.environmentID ?? null,
        scopeID: source.scope.id,
        signal,
      })
      assert()
      if (environment)
        sourceEnvironment = Handoff.NativeEnvironmentSelection.parse({
          kind: "native",
          environmentID: environment.environmentID,
          provider: environment.provider,
          generation: environment.generation,
          descriptor: environment.descriptor,
        })
      verifyEnvironment = async () => {
        const current = await Environments.nativeSelection({
          environmentID: source.environmentID ?? null,
          scopeID: source.scope.id,
          signal,
        })
        if (JSON.stringify(current) !== JSON.stringify(environment))
          fail("Handoff source Environment changed during inspection")
      }
      if (source.workspaceID) {
        const catalog = await WorkspaceCatalog.get(source.workspaceID, source.scope.id)
        assert()
        let kind: Handoff.SourceWorkspace["kind"] = "unsupported"
        let resource: Handoff.SourceWorkspace["resource"]
        if (catalog.lifecycle === "active" && catalog.binding.state === "bound") {
          if (await WorkspaceDrain.inspectNative(source, catalog, assert)) kind = "native"
          if (
            catalog.backend?.provider === "organization" &&
            !catalog.activeMount &&
            catalog.binding.path === null &&
            !catalog.content
          ) {
            const locator = Cloud.FileLocator.parse(catalog.backend.spec)
            if (
              locator.orgID !== plan.orgID ||
              locator.deploymentIncarnation !== plan.deploymentIncarnation ||
              locator.projectID !== plan.projectID
            )
              fail("Handoff source Locator has another organization owner")
            kind = "organization"
            resource = {
              resourceID: locator.resourceID,
              workspaceID: locator.workspaceID,
              generation: locator.generation,
              path: locator.version === 3 ? "" : locator.path,
            }
          }
        }
        workspace = {
          reference: { workspaceID: catalog.id, generation: catalog.binding.generation, revision: catalog.revision },
          kind,
          label: kind === "organization" ? "Organization Workspace" : "Project directory",
          ...(resource ? { resource } : {}),
        }
        const current = await WorkspaceCatalog.get(catalog.id, catalog.scopeID)
        if (JSON.stringify(current) !== JSON.stringify(catalog))
          fail("Handoff source Workspace changed during inspection")
      }
      const retained = await Session.get(plan.sessionID)
      if (
        retained.workspaceID !== source.workspaceID ||
        retained.environmentID !== source.environmentID ||
        JSON.stringify(retained.organization) !== JSON.stringify(source.organization) ||
        retained.scope.id !== source.scope.id ||
        retained.parentID !== source.parentID ||
        retained.time.archived
      )
        fail("Handoff source selection changed during inspection")
    } else if ("accountID" in identity) {
      const environment = await Environment.binding(plan.projectID, plan.sessionID)
      assert()
      if (environment) {
        const actual =
          (await Environments.nativeSelection({
            environmentID: environment.id,
            scopeID: plan.projectID,
            signal,
          })) ?? fail("Native destination has no original Environment descriptor")
        nativeEnvironment = Handoff.NativeEnvironmentTarget.parse({
          kind: "native",
          provider: actual.provider,
          descriptor: actual.descriptor,
          reference: { environmentID: actual.environmentID, generation: actual.generation },
        })
        verifyEnvironment = async () => {
          const current = await Environment.binding(plan.projectID, plan.sessionID)
          if (
            current?.id !== environment.id ||
            JSON.stringify(
              await Environments.nativeSelection({
                environmentID: environment.id,
                scopeID: plan.projectID,
                signal,
              }),
            ) !== JSON.stringify(actual)
          )
            fail("Native destination Environment changed during inspection")
        }
      } else if (
        EnvironmentProviders.list().some((provider) => provider.id === "native" && provider.ownership === "borrowed")
      ) {
        const provider = EnvironmentProviders.get("native")
        if (provider.portableDescriptor) {
          const descriptor = Handoff.NativeEnvironmentDescriptor.parse(provider.portableDescriptor({}))
          nativeEnvironment = { kind: "native", provider: provider.id, descriptor, reference: null }
          verifyEnvironment = async () => {
            if (
              EnvironmentProviders.get(provider.id) !== provider ||
              !provider.portableDescriptor ||
              JSON.stringify(provider.portableDescriptor({})) !== JSON.stringify(descriptor)
            )
              fail("Native destination registered descriptor changed during inspection")
          }
        }
      }
      const selected = await OrganizationLocalProjects.get(plan.projectID)
      assert()
      if (selected.binding) {
        const catalog = await WorkspaceCatalog.get(selected.binding.workspaceID, plan.projectID)
        assert()
        if (
          catalog.lifecycle === "active" &&
          catalog.binding.state === "bound" &&
          catalog.binding.generation === selected.binding.generation &&
          catalog.backend?.provider === "directory" &&
          catalog.binding.path &&
          catalog.binding.physicalID &&
          !catalog.activeMount
        )
          native = {
            reference: { workspaceID: catalog.id, generation: catalog.binding.generation, revision: catalog.revision },
            projectRevision: selected.revision,
            label: plan.actor.subjectID === identity.accountID ? selected.binding.label : "Project directory",
          }
        const retained = await OrganizationLocalProjects.get(plan.projectID)
        const current = await WorkspaceCatalog.get(catalog.id, plan.projectID)
        if (
          JSON.stringify(retained) !== JSON.stringify(selected) ||
          JSON.stringify(current) !== JSON.stringify(catalog)
        )
          fail("Handoff native target selection changed during inspection")
      }
    }
    await verifyEnvironment?.()
    assert()
    return Handoff.InspectionResult.parse({
      requestID: plan.requestID,
      orgID: plan.orgID,
      deploymentIncarnation: plan.deploymentIncarnation,
      projectID: plan.projectID,
      sessionID: plan.sessionID,
      runtimeID: plan.runtimeID,
      connectionEpoch: plan.connectionEpoch,
      bindingEpoch: plan.bindingEpoch,
      controlRevision: plan.controlRevision,
      role: plan.role,
      workspace,
      native,
      sourceEnvironment,
      nativeEnvironment,
    })
  }
}
