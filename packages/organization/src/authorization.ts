import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSessionProtocol as Session,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
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
export function authorize(
  credentials: Credentials,
  action: string,
  target: { resourceID: string; projectID?: string },
): Promise<Authenticated & { resource: Record.Resource; view?: Resource.View }>
export function authorize(
  credentials: Credentials,
  action: string,
  target: { runtimeID: string },
): Promise<Authenticated & { runtime: Record.RuntimeRegistration; view: Runtime.Registration }>
export function authorize(
  credentials: Credentials,
  action: string,
  target: { sessionID: string },
): Promise<
  Authenticated & { session: Record.SessionDirectory; project: z.infer<typeof Record.Project>; view: Session.View }
>
export async function authorize(
  credentials: Credentials,
  action: string,
  target?:
    | { projectID: string }
    | { accountID: string }
    | { runtimeID: string }
    | { sessionID: string }
    | { resourceID: string; projectID?: string },
) {
  const current = await authenticate(credentials)
  const { account } = current
  if (target && "resourceID" in target) {
    if (action === "resource.manage") requireAdministrator(account)
    const resource = await Record.read(Record.Resource, Keys.resource(account.orgID, target.resourceID))
    if (!resource || resource.orgID !== account.orgID || resource.resourceID !== target.resourceID)
      fail("NOT_FOUND", "Resource not found")
    if (action === "resource.manage") {
      return { ...current, resource }
    }
    if (!["resource.read", "resource.use"].includes(action) || !target.projectID)
      fail("PERMISSION_DENIED", "This action is not allowed")
    const project = await authorize(credentials, "project.read", { projectID: target.projectID })
    const [personal, shared] = await Promise.all([
      Record.read(
        Record.ResourceGrant,
        Keys.resourceGrant(account.orgID, resource.resourceID, { kind: "account", id: account.accountID }),
      ),
      Record.read(
        Record.ResourceGrant,
        Keys.resourceGrant(account.orgID, resource.resourceID, { kind: "project", id: target.projectID }),
      ),
    ])
    const view = resourceView(account, resource, project.view, personal, shared)
    if (action === "resource.use" && !view.permissions.use) fail("PERMISSION_DENIED", "Resource use is not allowed")
    return { ...current, resource, view }
  }
  if (target && "sessionID" in target) {
    const session = await Record.read(Record.SessionDirectory, Keys.session(target.sessionID))
    if (
      !session ||
      session.sessionID !== target.sessionID ||
      session.orgID !== account.orgID ||
      (session.shareState === "private" && session.creatorID !== account.accountID)
    )
      fail("NOT_FOUND", "Session not found")
    const project = await Record.read(Record.Project, Keys.project(session.projectID))
    if (!project) fail("NOT_FOUND", "Session not found")
    const membership = await Record.read(Record.ProjectMember, Keys.projectMember(project.projectID, account.accountID))
    const access = projectView(account, project, membership, "project.read")
    return { ...current, session, project, view: sessionView(account, session, access, action) }
  }
  if (target && "runtimeID" in target) {
    const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(target.runtimeID))
    if (!runtime) fail("NOT_FOUND", "Runtime not found")
    return { ...current, runtime, view: runtimeView(account, runtime, action) }
  }
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
  if (["accounts.list", "invites.create", "sessions.capacity", "resources.manage"].includes(action))
    requireAdministrator(account)
  else if (
    !["organization.read", "project.create", "project.list", "runtimes.register", "runtimes.list"].includes(action)
  )
    fail("PERMISSION_DENIED", "This action is not allowed")
  return current
}

export function sessionView(
  account: Identity.Account,
  session: Record.SessionDirectory,
  project: Identity.ProjectView,
  action: string,
): Session.View {
  if (
    account.state !== "active" ||
    session.orgID !== account.orgID ||
    project.orgID !== account.orgID ||
    session.projectID !== project.projectID ||
    !project.permissions.read ||
    (session.shareState === "private" && session.creatorID !== account.accountID)
  )
    fail("NOT_FOUND", "Session not found")
  const execute = project.permissions.execute && !session.handoffID
  const stop = (project.role === "maintainer" || project.role === "collaborator") && !session.handoffID
  if (action !== "session.read" && !(action === "session.execute" && execute) && !(action === "session.stop" && stop))
    fail("PERMISSION_DENIED", "This action is not allowed")
  return Session.View.parse({
    sessionID: session.sessionID,
    projectID: session.projectID,
    creatorID: session.creatorID,
    driverRuntimeID: session.driverRuntimeID,
    bindingEpoch: session.bindingEpoch,
    createdAt: session.createdAt,
    shareState: session.shareState,
    resourceIDs: session.resourceIDs,
    executionGrantIDs: session.executionGrantIDs,
    permissions: { read: true, execute, stop },
  })
}

export function runtimeView(account: Identity.Account, runtime: Record.RuntimeRegistration, action: string) {
  if (
    account.state !== "active" ||
    runtime.orgID !== account.orgID ||
    (runtime.accountID !== account.accountID && account.role === "member")
  )
    fail("NOT_FOUND", "Runtime not found")
  if (!["runtime.read", "runtime.revoke"].includes(action)) fail("PERMISSION_DENIED", "This action is not allowed")
  const { schemaVersion: _, ...result } = runtime
  return Runtime.Registration.parse(result)
}

export function resourceView(
  account: Identity.Account,
  resource: Record.Resource,
  project: Identity.ProjectView,
  personal?: Record.ResourceGrant,
  shared?: Record.ResourceGrant,
): Resource.View {
  if (
    account.state !== "active" ||
    !project.permissions.read ||
    resource.orgID !== account.orgID ||
    project.orgID !== account.orgID ||
    (resource.scope.kind === "project" && resource.scope.projectID !== project.projectID)
  )
    fail("NOT_FOUND", "Resource not found")
  for (const [grant, kind, id] of [
    [personal, "account", account.accountID],
    [shared, "project", project.projectID],
  ] as const) {
    if (
      grant &&
      (grant.orgID !== account.orgID ||
        grant.resourceID !== resource.resourceID ||
        grant.subject.kind !== kind ||
        grant.subject.id !== id)
    )
      fail("PERMISSION_DENIED", "Invalid resource grant")
  }
  if (!personal?.enabled && !shared?.enabled) fail("NOT_FOUND", "Resource not found")
  const { endpoint: _, ...definition } = resource.configuration
  return Resource.View.parse({
    ...Resource.Metadata.strip().parse(resource),
    definition,
    permissions: { use: project.permissions.execute && resource.state === "enabled" },
  })
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
