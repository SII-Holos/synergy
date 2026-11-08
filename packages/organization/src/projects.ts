import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { authenticate, account, type Credentials } from "./auth"
import { authorize, projectView } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail, revision } from "./error"

export namespace OrganizationProjects {
  export async function create(credentials: Credentials, input: Identity.ProjectCreate) {
    return Storage.transaction(async () => {
      const { account } = await authenticate(credentials)
      const project = Record.Project.parse({
        schemaVersion: 1,
        projectID: crypto.randomUUID(),
        orgID: account.orgID,
        ...input,
        state: "active",
        revision: 1,
        createdAt: Date.now(),
      })
      const membership = Record.ProjectMember.parse({
        schemaVersion: 1,
        projectID: project.projectID,
        accountID: account.accountID,
        role: "maintainer",
        revision: 1,
      })
      await Storage.write(Keys.project(project.projectID), project)
      await Storage.write(Keys.projectMember(project.projectID, account.accountID), membership)
      await Storage.write(Keys.projectAccess(account.accountID, project.projectID), membership)
      return (await authorize(credentials, "project.read", project)).view
    })
  }
  export async function get(credentials: Credentials, projectID: string) {
    return Storage.snapshot(async () => (await authorize(credentials, "project.read", { projectID })).view)
  }
  export async function list(credentials: Credentials, page: Identity.Page) {
    return Storage.snapshot(async () => {
      const { account } = await authenticate(credentials)
      const prefix = account.role === "member" ? Keys.accessibleProjects(account.accountID) : Keys.projects()
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: page.limit + 1,
      })
      const ids = rows.slice(0, page.limit).map((row) => row.key.at(-1)!)
      const [projects, memberships] = await Promise.all([
        Storage.readMany(ids.map(Keys.project)),
        Storage.readMany(ids.map((id) => Keys.projectMember(id, account.accountID))),
      ])
      const items = projects.map((value, index) =>
        projectView(
          account,
          Record.Project.parse(value),
          memberships[index] === undefined ? undefined : Record.ProjectMember.parse(memberships[index]),
          "project.read",
        ),
      )
      return { items, cursor: rows.length > page.limit ? items.at(-1)?.projectID : undefined }
    })
  }
  export async function update(credentials: Credentials, projectID: string, input: Identity.ProjectChange) {
    return Storage.transaction(async () => {
      const { project } = await authorize(credentials, "project.manage", { projectID })
      revision(input.expectedRevision, project.revision)
      const { expectedRevision: _, ...changes } = input
      const updated = Record.Project.parse({ ...project, ...changes, revision: project.revision + 1 })
      await Storage.write(Keys.project(projectID), updated)
      return (await authorize(credentials, "project.read", { projectID })).view
    })
  }
  export async function member(
    credentials: Credentials,
    projectID: string,
    accountID: string,
    input: Identity.ProjectMemberChange,
  ) {
    return Storage.transaction(async () => {
      const { project } = await authorize(credentials, "project.manage", { projectID })
      revision(input.expectedRevision, project.revision)
      const target = await account(accountID)
      if (input.role !== null && target.state !== "active") fail("NOT_FOUND", "Active account not found")
      const next = project.revision + 1
      if (input.role === null) {
        await Storage.remove(Keys.projectMember(projectID, accountID))
        await Storage.remove(Keys.projectAccess(accountID, projectID))
      } else {
        const value = Record.ProjectMember.parse({
          schemaVersion: 1,
          projectID,
          accountID,
          role: input.role,
          revision: next,
        })
        await Storage.write(Keys.projectMember(projectID, accountID), value)
        await Storage.write(Keys.projectAccess(accountID, projectID), value)
      }
      await Storage.write(Keys.project(projectID), { ...project, revision: next })
      return { ok: true as const }
    })
  }
}
