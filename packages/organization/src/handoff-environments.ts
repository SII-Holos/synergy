import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationCloud as Cloud } from "./cloud"
import { fail, revision } from "./error"

export namespace OrganizationHandoffEnvironments {
  async function organization(
    session: Record.SessionDirectory,
    value: Extract<Handoff.EnvironmentSourceSelection, { kind: "organization" }>,
  ) {
    const resource = await Record.read(Record.Resource, Keys.resource(session.orgID, value.resourceID))
    if (
      !resource ||
      resource.state !== "enabled" ||
      resource.kind !== "environment" ||
      resource.configuration.protocol !== "environment" ||
      (resource.scope.kind === "project" && resource.scope.projectID !== session.projectID)
    )
      fail("RESOURCE_UNAVAILABLE", "The mapped Environment resource is unavailable")
    revision(value.resourceRevision, resource.revision)
    await Cloud.assertInfrastructure(session.orgID, session.projectID, {
      workspace: null,
      environment: { resourceID: value.resourceID, environmentID: value.environmentID },
    })
    return resource
  }
  export async function source(
    session: Record.SessionDirectory,
    contract: Record.SessionResources | undefined,
    native: Handoff.NativeEnvironmentSelection | null,
  ): Promise<Handoff.EnvironmentSourceSelection> {
    const selected = contract?.selection?.infrastructure.environment
    if (!selected) return native ?? { kind: "none" }
    if (native) fail("PROTOCOL_MISMATCH", "A logical cloud Environment cannot also select native compute")
    const resource = await Record.read(Record.Resource, Keys.resource(session.orgID, selected.resourceID))
    if (!resource) fail("RESOURCE_UNAVAILABLE", "The source Environment resource is unavailable")
    const value = Handoff.OrganizationEnvironmentSelection.parse({
      kind: "organization",
      ...selected,
      resourceRevision: resource.revision,
    })
    await organization(session, value)
    return value
  }
  export function selected(mapping: Handoff.EnvironmentMapping) {
    return mapping.target.kind === "organization"
      ? { resourceID: mapping.target.resourceID, environmentID: mapping.target.environmentID }
      : null
  }
  export function changed(mapping: Handoff.EnvironmentMapping) {
    return (
      mapping.target.kind === "organization" &&
      (mapping.source.kind !== "organization" ||
        mapping.source.resourceID !== mapping.target.resourceID ||
        mapping.source.environmentID !== mapping.target.environmentID)
    )
  }
  export async function validate(input: {
    session: Record.SessionDirectory
    contract?: Record.SessionResources
    mapping: Handoff.EnvironmentMapping
    workspace: Handoff.WorkspaceMapping
    targetKind: "member" | "hosted"
  }) {
    const { session, contract, mapping, workspace } = input
    revision(mapping.expectedSelectionRevision, contract?.revision ?? 0)
    const selected = contract?.selection?.infrastructure.environment
    if (mapping.source.kind === "organization") {
      if (
        !selected ||
        selected.resourceID !== mapping.source.resourceID ||
        selected.environmentID !== mapping.source.environmentID
      )
        fail("REVISION_CONFLICT", "The source Environment differs from its original resource contract")
      await organization(session, mapping.source)
    } else if (selected) fail("REVISION_CONFLICT", "The source mapping cannot erase its original cloud Environment")
    if (mapping.target.kind === "organization") {
      if (workspace.kind !== "organization-live" && workspace.kind !== "organization-object")
        fail("HANDOFF_BLOCKED", "Cloud compute requires its explicitly mapped cloud Workspace")
      await organization(session, mapping.target)
    } else if (mapping.target.kind === "native") {
      if (input.targetKind !== "member" || (workspace.kind !== "native" && !Handoff.isNativeTargetMapping(workspace)))
        fail("HANDOFF_BLOCKED", "Native compute requires its destination member and native Working location")
    }
  }
}
