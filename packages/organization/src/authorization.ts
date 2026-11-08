import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { authenticate, type Credentials } from "./auth"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { z } from "zod"

// Provenance: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
// Local adaptation: resolve authoritative project ownership and current roles within the caller's SQL transaction.
export async function authorize(credentials: Credentials, action: string, target: { projectID: string }) {
  const { account } = await authenticate(credentials)
  const project = await Record.read(Record.Project, Keys.project(target.projectID))
  if (!project || project.orgID !== account.orgID) fail("NOT_FOUND", "Project not found")
  const membership = await Record.read(Record.ProjectMember, Keys.projectMember(project.projectID, account.accountID))
  return { account, project, view: projectView(account, project, membership, action) }
}

export function projectView(
  account: Identity.Account,
  project: z.infer<typeof Record.Project>,
  membership: z.infer<typeof Record.ProjectMember> | undefined,
  action: string,
) {
  if (project.orgID !== account.orgID || account.state !== "active") fail("NOT_FOUND", "Project not found")
  if (membership && (membership.projectID !== project.projectID || membership.accountID !== account.accountID))
    fail("PERMISSION_DENIED", "Invalid project membership")
  const permissions = {
    read: !!membership || account.role !== "member",
    manage: membership?.role === "maintainer" || account.role !== "member",
    execute: !!membership && membership.role !== "reader" && project.state === "active",
  }
  if (!permissions.read) fail("NOT_FOUND", "Project not found")
  const allowed =
    action === "project.read"
      ? permissions.read
      : action === "project.manage"
        ? permissions.manage
        : action === "project.execute"
          ? permissions.execute
          : false
  if (!allowed) fail("PERMISSION_DENIED", "This action is not allowed")
  const { schemaVersion: _, ...publicProject } = project
  return Identity.ProjectView.parse({ ...publicProject, permissions, role: membership?.role })
}
