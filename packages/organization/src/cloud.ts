import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders, type EnvironmentProvider } from "@ericsanchezok/synergy-harness/environment/provider"
import type { BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { OrganizationCloudProtocol as Cloud, OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { fail, revision } from "./error"

export interface OrganizationCloudOptions {
  blobStores?: Record<string, BlobStore>
  environmentProviders?: EnvironmentProvider[]
  workspaceProfiles?: Record<string, z.infer<typeof WorkspaceContent.Spec>>
  environmentProfiles?: Record<string, EnvironmentProviders.Default>
}

export namespace OrganizationCloud {
  const configuration = RuntimeContext.state(() => ({ profiles: undefined as OrganizationCloudOptions | undefined }))
  const Locator = z.strictObject({
    schemaVersion: z.literal(1), orgID: Identity.ID, projectID: Identity.ID, resourceID: Identity.ID,
    id: Identity.ID, name: Identity.Name,
  })
  const Receipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), result: Cloud.Workspace })
  const EnvironmentReceipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), id: Identity.ID })
  const key = (kind: "workspaces" | "environments", id: string) => ["organization", "cloud", kind, id]
  const receiptKey = (workspaceID: string, operationID: string) => ["organization", "cloud", "receipts", workspaceID, operationID]
  const creationKey = (kind: string, orgID: string, accountID: string, requestID: string) => ["organization", "cloud", "creation", kind, orgID, accountID, requestID]
  const projectKey = (kind: string, orgID: string, projectID: string, resourceID: string) => ["organization", "cloud", "project", kind, orgID, projectID, resourceID]
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

  export function register(options: OrganizationCloudOptions = {}) {
    RuntimeContext.assertCompositionOpen("Organization cloud resources")
    if (configuration().profiles) throw new Error("Organization cloud resources are already registered")
    for (const [id, store] of Object.entries(options.blobStores ?? {})) WorkspaceBlobs.register(id, store)
    for (const provider of options.environmentProviders ?? []) EnvironmentProviders.register(provider)
    for (const spec of Object.values(options.workspaceProfiles ?? {})) {
      const parsed = WorkspaceContent.Spec.parse(spec)
      WorkspaceBlobs.get(parsed.blobStore, parsed.settings)
    }
    for (const profile of Object.values(options.environmentProfiles ?? {})) EnvironmentProviders.get(profile.provider)
    configuration().profiles = structuredClone({ workspaceProfiles: options.workspaceProfiles, environmentProfiles: options.environmentProfiles })
  }

  export function scopeID(orgID: string, projectID: string) {
    return `org_${digest([orgID, projectID])}`
  }

  function profiles() {
    const value = configuration().profiles
    if (!value) fail("SERVICE_UNAVAILABLE", "Organization cloud resources are not configured")
    return value
  }

  async function resolve(credentials: Credentials, kind: "workspaces" | "environments", id: string, write = false) {
    const [raw] = await Storage.readMany([key(kind, id)])
    if (!raw) fail("NOT_FOUND", "Cloud resource not found")
    const locator = Locator.parse(raw)
    if (locator.id !== id) fail("PROTOCOL_MISMATCH", "Cloud resource identity is inconsistent")
    const authority = await authorize(credentials, write ? "resource.use" : "resource.read", { resourceID: locator.resourceID, projectID: locator.projectID })
    if (authority.account.orgID !== locator.orgID || authority.resource.state !== "enabled") fail("NOT_FOUND", "Cloud resource not found")
    if (authority.resource.configuration.protocol !== (kind === "workspaces" ? "workspace-storage" : "environment")) fail("PROTOCOL_MISMATCH", "Cloud resource owner is inconsistent")
    return { locator, authority, scopeID: scopeID(locator.orgID, locator.projectID) }
  }

  async function view(locator: z.infer<typeof Locator>): Promise<Cloud.Workspace> {
    const workspace = await WorkspaceCatalog.assertActive(locator.id, scopeID(locator.orgID, locator.projectID))
    if (workspace.backend?.provider !== "objects") fail("PROTOCOL_MISMATCH", "Cloud Workspace has no object authority")
    return Cloud.Workspace.parse({
      workspaceID: workspace.id, orgID: locator.orgID, projectID: locator.projectID, resourceID: locator.resourceID,
      name: locator.name, revision: workspace.revision, generation: workspace.binding.generation,
      contentRevision: workspace.content?.revision ?? 0, manifest: workspace.content?.manifest ?? null, activeMount: !!workspace.activeMount,
    })
  }

  export async function createWorkspace(credentials: Credentials, value: Cloud.CreateWorkspace) {
    const input = Cloud.CreateWorkspace.parse(value)
    const hash = digest(input)
    return Storage.transaction(async () => {
      const { account, resource } = await authorize(credentials, "resource.use", { resourceID: input.resourceID, projectID: input.projectID })
      if (resource.configuration.protocol !== "workspace-storage") fail("INVALID_REQUEST", "Select a Workspace storage resource")
      const receipt = creationKey("workspaces", account.orgID, account.accountID, input.requestID)
      const [raw] = await Storage.readMany([receipt])
      if (raw) {
        const previous = Receipt.parse(raw)
        if (previous.digest !== hash) fail("INVALID_REQUEST", "Request identity belongs to another Workspace creation")
        return previous.result
      }
      const profile = profiles().workspaceProfiles?.[resource.configuration.profile]
      if (!profile) fail("SERVICE_UNAVAILABLE", "Workspace storage profile is unavailable")
      const workspace = await WorkspaceCatalog.create({
        scopeID: scopeID(account.orgID, input.projectID), backend: WorkspaceCatalog.Backend.parse({ provider: "objects", spec: WorkspaceContent.Spec.parse(profile) }),
        metadata: { organization: { orgID: account.orgID, projectID: input.projectID, resourceID: resource.resourceID } },
      })
      const locator = Locator.parse({ schemaVersion: 1, orgID: account.orgID, projectID: input.projectID, resourceID: resource.resourceID, id: workspace.id, name: input.name })
      await Storage.write(key("workspaces", workspace.id), locator)
      await Storage.write([...projectKey("workspaces", account.orgID, input.projectID, resource.resourceID), workspace.id], { id: workspace.id })
      const result = await view(locator)
      await Storage.write(receipt, Receipt.parse({ schemaVersion: 1, digest: hash, result }))
      return result
    })
  }

  export async function getWorkspace(credentials: Credentials, workspaceID: string) {
    return Storage.snapshot(async () => view((await resolve(credentials, "workspaces", Identity.ID.parse(workspaceID))).locator))
  }

  export async function listWorkspaces(credentials: Credentials, projectID: string, resourceID: string, value: Identity.Page) {
    const page = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { account, resource } = await authorize(credentials, "resource.read", { resourceID, projectID })
      if (resource.configuration.protocol !== "workspace-storage" || resource.state !== "enabled") fail("NOT_FOUND", "Workspace storage resource not found")
      const prefix = projectKey("workspaces", account.orgID, projectID, resourceID)
      const rows = await Storage.query({ prefix, after: page.cursor ? [...prefix, page.cursor] : undefined, limit: page.limit + 1 })
      const items = await Promise.all(rows.slice(0, page.limit).map(async row => {
        const id = Identity.ID.parse(row.key.at(-1))
        const { locator } = await resolve(credentials, "workspaces", id)
        if (locator.resourceID !== resourceID || locator.projectID !== projectID) fail("PROTOCOL_MISMATCH", "Invalid cloud Workspace index")
        return view(locator)
      }))
      return { items, cursor: rows.length > page.limit ? items.at(-1)?.workspaceID : undefined }
    })
  }

  export async function read(credentials: Credentials, workspaceID: string, value: Cloud.Read) {
    const input = Cloud.Read.parse(value)
    return Storage.snapshot(async () => {
      const target = await resolve(credentials, "workspaces", workspaceID)
      const result = await WorkspaceContent.readRange({ workspaceID, scopeID: target.scopeID }, input.path, input.offset, input.length)
      return Cloud.Bytes.parse({ data: Buffer.from(result.bytes).toString("base64"), version: result.version, size: result.size, mode: result.mode })
    })
  }

  export async function write(credentials: Credentials, workspaceID: string, value: Cloud.Write): Promise<Cloud.Workspace> {
    const input = Cloud.Write.parse(value)
    const hash = digest(input)
    const operation = receiptKey(workspaceID, input.operationID)
    const initial = await Storage.snapshot(async () => {
      const target = await resolve(credentials, "workspaces", workspaceID, true)
      const [raw] = await Storage.readMany([operation])
      if (raw) {
        const previous = Receipt.parse(raw)
        if (previous.digest !== hash) fail("INVALID_REQUEST", "Operation identity belongs to another file write")
        return { result: previous.result } as const
      }
      const current = await WorkspaceCatalog.get(workspaceID, target.scopeID)
      revision(input.expectedRevision, current.revision)
      return { target } as const
    })
    if (initial.result !== undefined) return initial.result
    const data = Buffer.from(input.data, "base64")
    if (data.toString("base64") !== input.data || data.length > Cloud.chunkBytes) fail("INVALID_REQUEST", "Invalid file bytes")
    const prepared = await WorkspaceContent.prepareWrite({ workspaceID, scopeID: initial.target.scopeID }, {
      path: input.path, data, expectedVersion: input.expectedVersion, mode: input.mode,
    })
    return Storage.transaction(async () => {
      const { locator, scopeID } = await resolve(credentials, "workspaces", workspaceID, true)
      const [raw] = await Storage.readMany([operation])
      if (raw) {
        const previous = Receipt.parse(raw)
        if (previous.digest !== hash) fail("INVALID_REQUEST", "Operation identity belongs to another file write")
        return previous.result
      }
      revision(input.expectedRevision, (await WorkspaceCatalog.get(workspaceID, scopeID)).revision)
      await WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
      const result = await view(locator)
      await Storage.write(operation, Receipt.parse({ schemaVersion: 1, digest: hash, result }))
      return result
    })
  }

  export async function createEnvironment(credentials: Credentials, value: Cloud.CreateEnvironment) {
    const input = Cloud.CreateEnvironment.parse(value)
    const hash = digest(input)
    return Storage.transaction(async () => {
      const { account, resource } = await authorize(credentials, "resource.use", { resourceID: input.resourceID, projectID: input.projectID })
      if (resource.configuration.protocol !== "environment") fail("INVALID_REQUEST", "Select an execution Environment resource")
      const receipt = creationKey("environments", account.orgID, account.accountID, input.requestID)
      const [raw] = await Storage.readMany([receipt])
      if (raw) {
        const previous = EnvironmentReceipt.parse(raw)
        if (previous.digest !== hash) fail("INVALID_REQUEST", "Request identity belongs to another Environment creation")
        return getEnvironment(credentials, previous.id)
      }
      const profile = profiles().environmentProfiles?.[resource.configuration.profile]
      if (!profile) fail("SERVICE_UNAVAILABLE", "Execution Environment profile is unavailable")
      const environment = await Environment.bind({ scopeID: scopeID(account.orgID, input.projectID), ownerID: JSON.stringify([account.accountID, input.requestID]), ...profile })
      const locator = Locator.parse({ schemaVersion: 1, orgID: account.orgID, projectID: input.projectID, resourceID: resource.resourceID, id: environment.id, name: input.name })
      await Storage.write(key("environments", environment.id), locator)
      await Storage.write(receipt, EnvironmentReceipt.parse({ schemaVersion: 1, digest: hash, id: environment.id }))
      return environmentView(locator)
    })
  }

  async function environmentView(locator: z.infer<typeof Locator>) {
    const environment = await Environment.get(locator.id, scopeID(locator.orgID, locator.projectID))
    return Cloud.Environment.parse({ environmentID: locator.id, orgID: locator.orgID, projectID: locator.projectID, resourceID: locator.resourceID, name: locator.name, generation: environment.generation, state: environment.state, activeUses: (await Environment.uses(locator.id)).length })
  }

  export async function getEnvironment(credentials: Credentials, environmentID: string) {
    return Storage.snapshot(async () => environmentView((await resolve(credentials, "environments", Identity.ID.parse(environmentID))).locator))
  }
}
