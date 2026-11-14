import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"

export function organizationHandoffEnvironmentDefault(
  options: Handoff.Options,
): Handoff.EnvironmentTargetSelection | undefined {
  const environment = options.environment
  if (!environment) return
  if (environment.source.kind === "native") return environment.native ?? undefined
  return environment.source
}
export function organizationHandoffEnvironmentMapping(
  options: Handoff.Options,
  workspace: Handoff.WorkspaceMapping,
  selected: Handoff.EnvironmentTargetSelection | undefined,
) {
  const environment = options.environment
  if (!environment || !selected || !environment.choices.includes(selected.kind)) return
  if (
    selected.kind === "native" &&
    ((workspace.kind !== "native" && !Handoff.isNativeTargetMapping(workspace)) ||
      JSON.stringify(selected) !== JSON.stringify(environment.native))
  )
    return
  if (
    selected.kind === "organization" &&
    workspace.kind !== "organization-live" &&
    workspace.kind !== "organization-object"
  )
    return
  return Handoff.EnvironmentMapping.parse({
    version: 1,
    expectedSelectionRevision: environment.expectedSelectionRevision,
    source: environment.source,
    target: selected,
  })
}
