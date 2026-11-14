import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { authorize, requireAdministrator } from "./authorization"
import type { Credentials } from "./auth/session"

export async function authorizePublicationScope(credentials: Credentials, scope: Publication.Scope, write = false) {
  if (scope.kind === "project") {
    const current = await authorize(credentials, write ? "project.execute" : "project.read", {
      projectID: scope.projectID,
    })
    return current.account
  }
  const current = await authorize(credentials, "organization.read")
  if (write) requireAdministrator(current.account)
  return current.account
}

export function publicationScopeKey(scope: Publication.Scope) {
  return scope.kind === "organization" ? "organization" : `project:${scope.projectID}`
}
