import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { z } from "zod"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { account, type Credentials } from "./auth/session"
import { authorize, projectView } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail, revision } from "./error"
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { OrganizationSessionDirectory } from "./session-directory"

export namespace OrganizationProjects {
  export async function members(credentials: Credentials, projectID: string, input: Identity.Page) {
    const page = Identity.Page.parse(input)
    return Storage.snapshot(async () => {
      const { project } = await authorize(credentials, "project.read", { projectID })
      const prefix = Keys.projectMembers(projectID)
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: page.limit + 1,
      })
      const selected = rows.slice(0, page.limit)
      const items = await Promise.all(
        selected.map(async (row) => {
          const membership = Record.parse(Record.ProjectMember, row.key, row.value)
          if (membership.projectID !== projectID || membership.accountID !== row.key.at(-1))
            fail("SERVICE_UNAVAILABLE", "Project membership index is inconsistent")
          const member = await account(membership.accountID, project.orgID)
          return Identity.ProjectMemberView.parse({
            ...Identity.ProjectMemberIdentity.parse({
              accountID: member.accountID,
              displayName: member.displayName,
              loginName: member.loginName,
              state: member.state,
            }),
            role: membership.role,
          })
        }),
      )
      return Identity.ProjectMemberPage.parse({
        items,
        projectRevision: project.revision,
        cursor: rows.length > page.limit ? selected.at(-1)?.key.at(-1) : undefined,
      })
    })
  }

  export async function candidates(
    credentials: Credentials,
    projectID: string,
    input: z.input<typeof Identity.CandidateQuery>,
  ) {
    const page = Identity.CandidateQuery.parse(input)
    return Storage.snapshot(async () => {
      const { project } = await authorize(credentials, "project.manage", { projectID })
      const prefix = Keys.accounts()
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: 256,
      })
      const items: z.infer<typeof Identity.ProjectMemberIdentity>[] = []
      let cursor: string | undefined
      for (const row of rows) {
        cursor = row.key.at(-1)
        const member = Record.parse(Record.Account, row.key, row.value)
        if (member.accountID !== cursor) fail("SERVICE_UNAVAILABLE", "Account index is inconsistent")
        if (
          member.orgID !== project.orgID ||
          member.state !== "active" ||
          !`${member.displayName} ${member.loginName}`.toLocaleLowerCase().includes(page.q.toLocaleLowerCase())
        )
          continue
        items.push({
          accountID: member.accountID,
          displayName: member.displayName,
          loginName: member.loginName,
          state: member.state,
        })
        if (items.length === page.limit) break
      }
      return Identity.ProjectCandidatePage.parse({
        items,
        projectRevision: project.revision,
        cursor: rows.length === 256 || (cursor && cursor !== rows.at(-1)?.key.at(-1)) ? cursor : undefined,
      })
    })
  }

  export async function create(credentials: Credentials, input: Identity.ProjectCreate) {
    return History.credentials(credentials, "project.create", async () => {
      const { account } = await authorize(credentials, "project.create")
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
      const { account } = await authorize(credentials, "project.list")
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
    return History.credentials(credentials, "project.update", async () => {
      const { project } = await authorize(credentials, "project.manage", { projectID })
      revision(input.expectedRevision, project.revision)
      if (input.state === "archived" && project.state !== "archived")
        await OrganizationSessionDirectory.assertProjectArchivable(projectID)
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
    return History.credentials(credentials, "project.member", async () => {
      const { project } = await authorize(credentials, "project.manage", { projectID })
      revision(input.expectedRevision, project.revision)
      const target = await account(accountID, project.orgID)
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
