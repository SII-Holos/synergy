import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { authenticate, account as resolveAccount, type Credentials } from "./auth/session"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { z } from "zod"

// Provenance: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
// Local adaptation: resolve authoritative object ownership and current roles within the caller's SQL transaction.
type Authenticated = Awaited<ReturnType<typeof authenticate>>
export function authorize(
  credentials: Credentials,
  action: string,
  target: { projectID: string },
): Promise<Authenticated & { project: z.infer<typeof Record.Project>; view: Identity.ProjectView }>
export function authorize(
  credentials: Credentials,
  action: string,
  target: { accountID: string },
): Promise<Authenticated & { target: Record.Account }>
export function authorize(credentials: Credentials, action: string): Promise<Authenticated>
export async function authorize(
  credentials: Credentials,
  action: string,
  target?: { projectID: string } | { accountID: string },
) {
  const current = await authenticate(credentials)
  const { account } = current
  if (target && "projectID" in target) {
    const project = await Record.read(Record.Project, Keys.project(target.projectID))
    if (!project || project.orgID !== account.orgID) fail("NOT_FOUND", "Project not found")
    const membership = await Record.read(Record.ProjectMember, Keys.projectMember(project.projectID, account.accountID))
    return { ...current, project, view: projectView(account, project, membership, action) }
  }
  if (target && "accountID" in target) {
    const subject = await resolveAccount(target.accountID, account.orgID)
    const administrator = account.role !== "member"
    const allowed =
      action === "account.profile"
        ? subject.accountID === account.accountID || administrator
        : action === "account.manage" || action === "account.reset"
          ? administrator && (subject.role !== "owner" || account.role === "owner")
          : action === "account.promote-owner" || action === "account.transfer-owner"
            ? account.role === "owner"
            : false
    if (!allowed) fail("PERMISSION_DENIED", "This action is not allowed")
    return { ...current, target: subject }
  }
  if (["accounts.list", "invites.create"].includes(action)) requireAdministrator(account)
  else if (!["organization.read", "project.create", "project.list"].includes(action))
    fail("PERMISSION_DENIED", "This action is not allowed")
  return current
}

export function requireAdministrator(value: Identity.Account) {
  if (value.state !== "active" || value.role === "member")
    fail("PERMISSION_DENIED", "Organization administrator access is required")
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
