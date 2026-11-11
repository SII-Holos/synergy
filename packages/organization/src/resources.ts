import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationIdentity as Identity,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { account as resolveAccount, type Credentials } from "./auth/session"
import { authorize, resourceView } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail, revision } from "./error"

export namespace OrganizationResources {
  function adminView(resource: Record.Resource): Resource.AdminView {
    return Resource.AdminView.parse({
      ...Resource.Metadata.strip().parse(resource),
      configuration: resource.configuration,
      credential: resource.credential,
    })
  }
  function access(resource: Record.Resource, subject: Resource.Subject) {
    return subject.kind === "project"
      ? Keys.projectResources(resource.orgID, subject.id)
      : Keys.accountResources(
          resource.orgID,
          subject.id,
          resource.scope.kind === "project" ? resource.scope.projectID : undefined,
        )
  }
  function validateCredential(
    configuration: Resource.Configuration,
    credential: z.infer<typeof Resource.CredentialInfo>,
  ) {
    if (configuration.protocol === "workspace-storage" || configuration.protocol === "environment") {
      if (credential.kind !== "none") fail("INVALID_REQUEST", "Infrastructure credentials belong to the cloud resource owner")
      return
    }
    if (credential.kind === "none") return
    if (configuration.protocol === "openai-compatible" && credential.kind !== "bearer")
      fail("INVALID_REQUEST", "OpenAI-compatible resources require a bearer credential")
    if (
      configuration.protocol === "anthropic-compatible" &&
      (credential.kind !== "header" || credential.name.toLowerCase() !== "x-api-key")
    )
      fail("INVALID_REQUEST", "Anthropic-compatible resources require an x-api-key credential")
  }
  async function credential(resource: Record.Resource, input: Resource.Credential) {
    const info = Resource.CredentialInfo.parse(
      input.kind === "header" ? { kind: input.kind, name: input.name } : { kind: input.kind },
    )
    validateCredential(resource.configuration, info)
    if (input.kind === "none") {
      if (resource.secretID) await Storage.remove(Keys.resourceSecret(resource.secretID))
      return { credential: info, secretID: undefined }
    }
    const secretID = resource.secretID ?? crypto.randomUUID()
    await Storage.write(
      Keys.resourceSecret(secretID),
      Record.ResourceSecret.parse({
        schemaVersion: 1,
        orgID: resource.orgID,
        resourceID: resource.resourceID,
        credential: input,
      }),
    )
    return { credential: info, secretID }
  }
  export async function create(credentials: Credentials, value: Resource.Create) {
    credentials = { ...credentials }
    const input = Resource.Create.parse(value)
    return Storage.transaction(async () => {
      const { account } = await authorize(credentials, "resources.manage")
      if (input.scope.kind === "project")
        await authorize(credentials, "project.read", { projectID: input.scope.projectID })
      const now = Date.now()
      let resource = Record.Resource.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        resourceID: crypto.randomUUID(),
        name: input.name,
        scope: input.scope,
        kind: Resource.kind(input.configuration),
        configuration: input.configuration,
        credential: { kind: "none" },
        state: "enabled",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      resource = Record.Resource.parse({ ...resource, ...(await credential(resource, input.credential)) })
      await Storage.write(Keys.resource(account.orgID, resource.resourceID), resource)
      return adminView(resource)
    })
  }
  export async function get(credentials: Credentials, resourceID: string) {
    credentials = { ...credentials }
    resourceID = Identity.ID.parse(resourceID)
    return Storage.snapshot(async () =>
      adminView((await authorize(credentials, "resource.manage", { resourceID })).resource),
    )
  }
  export async function list(credentials: Credentials, value: Identity.Page) {
    credentials = { ...credentials }
    const page = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { account } = await authorize(credentials, "resources.manage")
      const prefix = Keys.resources(account.orgID)
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: page.limit + 1,
      })
      const items = rows.slice(0, page.limit).map((row) => {
        const record = Record.Resource.parse(row.value)
        if (record.orgID !== account.orgID || record.resourceID !== row.key.at(-1))
          fail("PERMISSION_DENIED", "Invalid resource identity")
        return adminView(record)
      })
      return { items, cursor: rows.length > page.limit ? items.at(-1)?.resourceID : undefined }
    })
  }
  export async function update(credentials: Credentials, resourceID: string, value: Resource.Change) {
    credentials = { ...credentials }
    resourceID = Identity.ID.parse(resourceID)
    const input = Resource.Change.parse(value)
    return Storage.transaction(async () => {
      const { resource } = await authorize(credentials, "resource.manage", { resourceID })
      revision(input.expectedRevision, resource.revision)
      if (input.configuration && input.configuration.protocol !== resource.configuration.protocol)
        fail("INVALID_REQUEST", "Resource protocol is immutable; create another resource")
      const updated = Record.Resource.parse({
        ...resource,
        name: input.name ?? resource.name,
        state: input.state ?? resource.state,
        configuration: input.configuration ?? resource.configuration,
        ...(input.credential ? await credential(resource, input.credential) : {}),
        revision: resource.revision + 1,
        updatedAt: Date.now(),
      })
      validateCredential(updated.configuration, updated.credential)
      await Storage.write(Keys.resource(resource.orgID, resourceID), updated)
      return adminView(updated)
    })
  }
  export async function grant(
    credentials: Credentials,
    resourceID: string,
    target: Resource.Subject,
    value: Resource.GrantChange,
  ) {
    credentials = { ...credentials }
    resourceID = Identity.ID.parse(resourceID)
    const subject = Resource.Subject.parse(target)
    const input = Resource.GrantChange.parse(value)
    return Storage.transaction(async () => {
      const { account, resource } = await authorize(credentials, "resource.manage", { resourceID })
      if (subject.kind === "account") {
        const target = await resolveAccount(subject.id, account.orgID)
        if (input.enabled && target.state !== "active") fail("NOT_FOUND", "Active account not found")
      } else {
        await authorize(credentials, "project.read", { projectID: subject.id })
        if (resource.scope.kind === "project" && resource.scope.projectID !== subject.id)
          fail("PERMISSION_DENIED", "A project resource cannot be granted to another project")
      }
      const key = Keys.resourceGrant(account.orgID, resourceID, subject)
      const current = await Record.read(Record.ResourceGrant, key)
      if (
        current &&
        (current.orgID !== account.orgID ||
          current.resourceID !== resourceID ||
          current.subject.kind !== subject.kind ||
          current.subject.id !== subject.id)
      )
        fail("PERMISSION_DENIED", "Invalid resource grant")
      revision(input.expectedRevision, current?.revision ?? 0)
      const updated = Record.ResourceGrant.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        resourceID,
        subject,
        enabled: input.enabled,
        revision: (current?.revision ?? 0) + 1,
        updatedBy: account.accountID,
        updatedAt: Date.now(),
      })
      await Storage.write(key, updated)
      const index = [...access(resource, subject), resourceID]
      if (input.enabled) await Storage.write(index, Record.ResourceAccess.parse({ resourceID, subject }))
      else await Storage.remove(index)
      const { schemaVersion: _, ...result } = updated
      return result
    })
  }
  export async function grants(
    credentials: Credentials,
    resourceID: string,
    kind: Resource.Subject["kind"],
    value: Identity.Page,
  ) {
    credentials = { ...credentials }
    resourceID = Identity.ID.parse(resourceID)
    kind = Resource.SubjectKind.parse(kind)
    const page = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { resource } = await authorize(credentials, "resource.manage", { resourceID })
      const prefix = Keys.resourceGrants(resource.orgID, resourceID, kind)
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: page.limit + 1,
      })
      const items = rows.slice(0, page.limit).map((row) => {
        const { schemaVersion: _, ...grant } = Record.ResourceGrant.parse(row.value)
        if (
          grant.orgID !== resource.orgID ||
          grant.resourceID !== resourceID ||
          grant.subject.kind !== kind ||
          grant.subject.id !== row.key.at(-1)
        )
          fail("PERMISSION_DENIED", "Invalid resource grant")
        return grant
      })
      return { items, cursor: rows.length > page.limit ? items.at(-1)?.subject.id : undefined }
    })
  }
  export async function available(credentials: Credentials, projectID: string, value: Identity.Page) {
    credentials = { ...credentials }
    projectID = Identity.ID.parse(projectID)
    const page = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { account, view: project } = await authorize(credentials, "project.read", { projectID })
      const personal: Resource.Subject = { kind: "account", id: account.accountID }
      const shared: Resource.Subject = { kind: "project", id: projectID }
      const sources = [
        { prefix: Keys.accountResources(account.orgID, account.accountID), subject: personal },
        { prefix: Keys.accountResources(account.orgID, account.accountID, projectID), subject: personal },
        { prefix: Keys.projectResources(account.orgID, projectID), subject: shared },
      ]
      const pages = await Promise.all(
        sources.map(async ({ prefix, subject }) => {
          const rows = await Storage.query({
            prefix,
            after: page.cursor ? [...prefix, page.cursor] : undefined,
            limit: page.limit + 1,
          })
          return rows.map((row) => {
            const index = Record.ResourceAccess.parse(row.value)
            if (
              row.key.length !== prefix.length + 1 ||
              index.resourceID !== row.key.at(-1) ||
              index.subject.kind !== subject.kind ||
              index.subject.id !== subject.id
            )
              fail("PERMISSION_DENIED", "Invalid resource access index")
            return index.resourceID
          })
        }),
      )
      const candidates = [...new Set(pages.flat())].sort()
      const ids = candidates.slice(0, page.limit)
      const records = await Storage.readMany(
        ids.flatMap((id) => [
          Keys.resource(account.orgID, id),
          Keys.resourceGrant(account.orgID, id, personal),
          Keys.resourceGrant(account.orgID, id, shared),
        ]),
      )
      const items = ids.map((id, index) => {
        const resource = Record.Resource.parse(records[index * 3])
        if (resource.resourceID !== id) fail("PERMISSION_DENIED", "Invalid resource identity")
        return resourceView(
          account,
          resource,
          project,
          records[index * 3 + 1] === undefined ? undefined : Record.ResourceGrant.parse(records[index * 3 + 1]),
          records[index * 3 + 2] === undefined ? undefined : Record.ResourceGrant.parse(records[index * 3 + 2]),
        )
      })
      return { items, cursor: candidates.length > page.limit ? ids.at(-1) : undefined }
    })
  }
}
