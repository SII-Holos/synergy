import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders, type EnvironmentProvider } from "@ericsanchezok/synergy-harness/environment/provider"
import type { BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { fail, revision } from "./error"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { OrganizationExecutionGrants } from "./execution-grants"
import { OrganizationHandoffExecution } from "./handoff"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"

export interface OrganizationCloudOptions {
  blobStores?: Record<string, BlobStore>
  environmentProviders?: EnvironmentProvider[]
  workspaceProfiles?: Record<string, z.infer<typeof WorkspaceContent.Spec>>
  environmentProfiles?: Record<string, EnvironmentProviders.Default>
}

export namespace OrganizationCloud {
  const moveSource =
    RuntimeContext.createAsyncContext<ReturnType<typeof OrganizationHandoffExecution.workspaceAuthority>>()
  const configuration = RuntimeContext.state(() => ({ profiles: undefined as OrganizationCloudOptions | undefined }))
  const Locator = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    projectID: Identity.ID,
    resourceID: Identity.ID,
    id: Identity.ID,
    name: Identity.Name,
  })
  const Receipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), result: Cloud.Workspace })
  const EnvironmentReceipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), id: Identity.ID })
  const FileReceipt = z.strictObject({
    version: z.literal(1),
    digest: Cloud.Hash,
    reference: Cloud.FileReference,
    result: Cloud.FileResult,
  })
  const key = (kind: "workspaces" | "environments", id: string) => ["organization", "cloud", kind, id]
  const receiptKey = (workspaceID: string, operationID: string) => [
    "organization",
    "cloud",
    "receipts",
    workspaceID,
    operationID,
  ]
  const creationKey = (kind: string, orgID: string, accountID: string, requestID: string) => [
    "organization",
    "cloud",
    "creation",
    kind,
    orgID,
    accountID,
    requestID,
  ]
  const projectKey = (kind: string, orgID: string, projectID: string, resourceID: string) => [
    "organization",
    "cloud",
    "project",
    kind,
    orgID,
    projectID,
    resourceID,
  ]
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

  export function register(options: OrganizationCloudOptions = {}) {
    RuntimeContext.assertCompositionOpen("Organization cloud resources")
    if (configuration().profiles) throw new Error("Organization cloud resources are already registered")
    WorkspaceMove.registerCapturedSourceHost("organization-handoff", {
      async capture(request, _store, consume) {
        const frame = moveSource.getStore()
        if (!frame) fail("PERMISSION_DENIED", "Workspace move requires its original source handoff callback")
        frame.assert()
        if (JSON.stringify(request) !== JSON.stringify(frame.request) || frame.proof.operation.action !== "publish")
          fail("PERMISSION_DENIED", "Workspace move source belongs to another complete operation")
        const source = WorkspaceMove.CapturedSource.parse(frame.proof.operation.source)
        await frame.recheck()
        const result = await consume(source, frame.assert, frame.recheck)
        frame.assert()
        return result
      },
    })
    for (const [id, store] of Object.entries(options.blobStores ?? {})) WorkspaceBlobs.register(id, store)
    for (const provider of options.environmentProviders ?? []) EnvironmentProviders.register(provider)
    for (const spec of Object.values(options.workspaceProfiles ?? {})) {
      const parsed = WorkspaceContent.Spec.parse(spec)
      WorkspaceBlobs.get(parsed.blobStore, parsed.settings)
    }
    for (const profile of Object.values(options.environmentProfiles ?? {})) EnvironmentProviders.get(profile.provider)
    configuration().profiles = structuredClone({
      workspaceProfiles: options.workspaceProfiles,
      environmentProfiles: options.environmentProfiles,
    })
  }

  export function registerAuthorityHistory() {
    AuthorityJournal.register({
      id: "organization-cloud-authority",
      version: 1,
      prefixes: [
        ["organization", "cloud", "workspaces"],
        ["organization", "cloud", "environments"],
      ],
      project(_key, value) {
        const locator = Locator.parse(value)
        return { orgID: locator.orgID, projectID: locator.projectID, resourceID: locator.resourceID, id: locator.id }
      },
    })
  }

  export function scopeID(orgID: string, projectID: string) {
    return `org_${digest([orgID, projectID])}`
  }

  export async function assertInfrastructure(orgID: string, projectID: string, value: Execution.Infrastructure) {
    orgID = Identity.ID.parse(orgID)
    projectID = Identity.ID.parse(projectID)
    const input = Execution.Infrastructure.parse(value)
    const selected = [
      ...(input.workspace
        ? [{ kind: "workspaces" as const, resourceID: input.workspace.resourceID, id: input.workspace.workspaceID }]
        : []),
      ...(input.environment
        ? [
            {
              kind: "environments" as const,
              resourceID: input.environment.resourceID,
              id: input.environment.environmentID,
            },
          ]
        : []),
    ]
    return Storage.snapshot(async () => {
      const rows = await Storage.readMany(selected.map((ref) => key(ref.kind, ref.id)))
      for (const [index, ref] of selected.entries()) {
        const raw = rows[index]
        if (!raw) fail("RESOURCE_UNAVAILABLE", "Selected infrastructure is unavailable")
        const locator = Locator.parse(raw)
        if (
          locator.orgID !== orgID ||
          locator.projectID !== projectID ||
          locator.resourceID !== ref.resourceID ||
          locator.id !== ref.id
        )
          fail("RESOURCE_UNAVAILABLE", "Selected infrastructure belongs to another resource or project")
        try {
          if (ref.kind === "workspaces") await view(locator)
          else await Environment.get(ref.id, scopeID(orgID, projectID))
        } catch (error) {
          if (error instanceof Storage.NotFoundError)
            fail("RESOURCE_UNAVAILABLE", "Selected infrastructure is unavailable")
          throw error
        }
      }
    })
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
    const authority = await authorize(credentials, write ? "resource.use" : "resource.read", {
      resourceID: locator.resourceID,
      projectID: locator.projectID,
    })
    if (authority.account.orgID !== locator.orgID || authority.resource.state !== "enabled")
      fail("NOT_FOUND", "Cloud resource not found")
    if (authority.resource.configuration.protocol !== (kind === "workspaces" ? "workspace-storage" : "environment"))
      fail("PROTOCOL_MISMATCH", "Cloud resource owner is inconsistent")
    return { locator, authority, scopeID: scopeID(locator.orgID, locator.projectID) }
  }

  async function view(locator: z.infer<typeof Locator>): Promise<Cloud.Workspace> {
    const workspace = await WorkspaceCatalog.assertActive(locator.id, scopeID(locator.orgID, locator.projectID))
    if (workspace.backend?.provider !== "objects") fail("PROTOCOL_MISMATCH", "Cloud Workspace has no object authority")
    return Cloud.Workspace.parse({
      workspaceID: workspace.id,
      orgID: locator.orgID,
      projectID: locator.projectID,
      resourceID: locator.resourceID,
      name: locator.name,
      revision: workspace.revision,
      generation: workspace.binding.generation,
      contentRevision: workspace.content?.revision ?? 0,
      manifest: workspace.content?.manifest ?? null,
      activeMount: !!workspace.activeMount,
    })
  }

  export async function createWorkspace(credentials: Credentials, value: Cloud.CreateWorkspace) {
    const input = Cloud.CreateWorkspace.parse(value)
    const hash = digest(input)
    return History.credentials(credentials, "cloud.workspace-create", async () => {
      const { account, resource } = await authorize(credentials, "resource.use", {
        resourceID: input.resourceID,
        projectID: input.projectID,
      })
      if (resource.configuration.protocol !== "workspace-storage")
        fail("INVALID_REQUEST", "Select a Workspace storage resource")
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
        scopeID: scopeID(account.orgID, input.projectID),
        backend: WorkspaceCatalog.Backend.parse({ provider: "objects", spec: WorkspaceContent.Spec.parse(profile) }),
        metadata: {
          organization: { orgID: account.orgID, projectID: input.projectID, resourceID: resource.resourceID },
        },
      })
      const locator = Locator.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        projectID: input.projectID,
        resourceID: resource.resourceID,
        id: workspace.id,
        name: input.name,
      })
      await Storage.write(key("workspaces", workspace.id), locator)
      await Storage.write(
        [...projectKey("workspaces", account.orgID, input.projectID, resource.resourceID), workspace.id],
        { id: workspace.id },
      )
      const result = await view(locator)
      await Storage.write(receipt, Receipt.parse({ schemaVersion: 1, digest: hash, result }))
      return result
    })
  }

  export async function getWorkspace(credentials: Credentials, workspaceID: string) {
    return Storage.snapshot(async () =>
      view((await resolve(credentials, "workspaces", Identity.ID.parse(workspaceID))).locator),
    )
  }

  export async function listWorkspaces(
    credentials: Credentials,
    projectID: string,
    resourceID: string,
    value: Identity.Page,
  ) {
    const page = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { account, resource } = await authorize(credentials, "resource.read", { resourceID, projectID })
      if (resource.configuration.protocol !== "workspace-storage" || resource.state !== "enabled")
        fail("NOT_FOUND", "Workspace storage resource not found")
      const prefix = projectKey("workspaces", account.orgID, projectID, resourceID)
      const rows = await Storage.query({
        prefix,
        after: page.cursor ? [...prefix, page.cursor] : undefined,
        limit: page.limit + 1,
      })
      const items = await Promise.all(
        rows.slice(0, page.limit).map(async (row) => {
          const id = Identity.ID.parse(row.key.at(-1))
          const { locator } = await resolve(credentials, "workspaces", id)
          if (locator.resourceID !== resourceID || locator.projectID !== projectID)
            fail("PROTOCOL_MISMATCH", "Invalid cloud Workspace index")
          return view(locator)
        }),
      )
      return { items, cursor: rows.length > page.limit ? items.at(-1)?.workspaceID : undefined }
    })
  }

  export async function read(credentials: Credentials, workspaceID: string, value: Cloud.Read) {
    const input = Cloud.Read.parse(value)
    return Storage.snapshot(async () => {
      const target = await resolve(credentials, "workspaces", workspaceID)
      const result = await WorkspaceContent.readRange(
        { workspaceID, scopeID: target.scopeID },
        input.path,
        input.offset,
        input.length,
      )
      return Cloud.Bytes.parse({
        data: Buffer.from(result.bytes).toString("base64"),
        version: result.version,
        size: result.size,
        mode: result.mode,
      })
    })
  }

  export async function write(
    credentials: Credentials,
    workspaceID: string,
    value: Cloud.Write,
  ): Promise<Cloud.Workspace> {
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
    if (data.toString("base64") !== input.data || data.length > Cloud.chunkBytes)
      fail("INVALID_REQUEST", "Invalid file bytes")
    const prepared = await WorkspaceContent.prepareWrite(
      { workspaceID, scopeID: initial.target.scopeID },
      {
        path: input.path,
        data,
        expectedVersion: input.expectedVersion,
        mode: input.mode,
      },
    )
    return History.credentials(credentials, "cloud.workspace-write", async () => {
      const { locator, scopeID } = await resolve(credentials, "workspaces", workspaceID, true)
      const [raw] = await Storage.readMany([operation])
      if (raw) {
        const previous = Receipt.parse(raw)
        if (previous.digest !== hash) fail("INVALID_REQUEST", "Operation identity belongs to another file write")
        return previous.result
      }
      revision(input.expectedRevision, (await WorkspaceCatalog.get(workspaceID, scopeID)).revision)
      await prepared.publish()
      const result = await view(locator)
      await Storage.write(operation, Receipt.parse({ schemaVersion: 1, digest: hash, result }))
      return result
    })
  }

  export async function file(
    evidence: OrganizationExecutionGrants.WorkspaceAuthority,
    signal?: AbortSignal,
  ): Promise<Cloud.FileResult> {
    const authority = OrganizationExecutionGrants.workspaceAuthority(evidence)
    const input = authority.request
    const selected = authority.grant.selection.infrastructure.workspace
    if (!selected) fail("RESOURCE_UNAVAILABLE", "The accepted Session has no organization Workspace")
    const grant = authority.grant
    const ref = input.reference
    const receiptOnly = input.operation.action === "receipt" || input.operation.action === "acknowledge"
    if (
      ref &&
      (ref.orgID !== grant.orgID ||
        ref.projectID !== grant.projectID ||
        ref.resourceID !== selected.resourceID ||
        ref.workspaceID !== selected.workspaceID)
    )
      fail("PERMISSION_DENIED", "Workspace file reference belongs to another accepted resource")
    const scope = scopeID(grant.orgID, grant.projectID)
    async function current() {
      await authority.recheck()
      const [raw] = await Storage.readMany([key("workspaces", selected!.workspaceID)])
      if (!raw) fail("RESOURCE_UNAVAILABLE", "Organization Workspace is unavailable")
      const locator = Locator.parse(raw)
      if (
        locator.orgID !== grant.orgID ||
        locator.projectID !== grant.projectID ||
        locator.resourceID !== selected!.resourceID ||
        locator.id !== selected!.workspaceID
      )
        fail("PERMISSION_DENIED", "Workspace file resource attribution changed")
      const info = await (receiptOnly
        ? WorkspaceCatalog.get(locator.id, scope)
        : WorkspaceCatalog.assertActive(locator.id, scope))
      if (!receiptOnly && (info.backend?.provider !== "objects" || info.activeMount || info.binding.state !== "bound"))
        fail("RESOURCE_UNAVAILABLE", "Workspace files require their dormant object owner")
      if (!receiptOnly && ref && ref.generation !== info.binding.generation)
        fail("REVISION_CONFLICT", "Workspace binding generation changed")
      authority.assert()
      return info
    }
    function reference(info: WorkspaceCatalog.Info): Cloud.FileReference {
      return Cloud.FileReference.parse({
        orgID: grant.orgID,
        projectID: grant.projectID,
        resourceID: selected!.resourceID,
        workspaceID: info.id,
        generation: info.binding.generation,
        revision: info.revision,
        rootPath: ref?.rootPath,
      })
    }
    function item(info: WorkspaceCatalog.Info, header: WorkspaceTree.Header, path: string) {
      return Cloud.FileItem.parse({
        path,
        kind: header.kind,
        entryVersion: WorkspaceTree.entryVersion(header, info.content?.revision),
        size: header.kind === "file" ? header.size : 0,
        mode: header.mode,
        mtime: info.updatedAt,
        ctime: info.createdAt,
      })
    }
    const operation = input.operation
    function within(path: string) {
      if (ref?.rootPath && path !== ref.rootPath && !path.startsWith(ref.rootPath + "/"))
        fail("PERMISSION_DENIED", "File path escapes its original mapped Workspace directory")
    }
    const info = await current()
    const finish = async (result: Cloud.FileResult["result"]) => {
      await current()
      authority.assert()
      return Cloud.FileResult.parse({ reference: receiptOnly ? ref : reference(info), result })
    }
    if (operation.action === "describe") return finish({ action: "describe" })
    if (!ref) fail("INVALID_REQUEST", "File operations require their original Workspace version")
    const id =
      "id" in operation
        ? "file_" +
          digest([
            grant.orgID,
            grant.projectID,
            grant.sessionID,
            grant.runtimeID,
            grant.bindingEpoch,
            grant.admissionID,
            grant.attemptID,
            authority.rootID,
            operation.id,
          ])
        : undefined
    const operationKey = id ? [...receiptKey(info.id, "file"), id] : undefined
    if (operation.action === "receipt" || operation.action === "acknowledge") {
      const [raw] = await Storage.readMany([operationKey!])
      const saved = raw === undefined ? undefined : FileReceipt.parse(raw)
      if (saved && JSON.stringify(saved.reference) !== JSON.stringify(ref))
        fail("REVISION_CONFLICT", "File receipt belongs to another original Workspace version")
      const result = saved?.result.result
      const checkpoint =
        result && (result.action === "write" || result.action === "mutate") ? result.checkpoint : undefined
      if (operation.action === "acknowledge") {
        if (!checkpoint) fail("RESOURCE_UNAVAILABLE", "File publication has no confirmed receipt")
        return finish({ action: "acknowledge", id: operation.id })
      }
      return finish({
        action: "receipt",
        status: checkpoint ? { id: operation.id, mount: checkpoint.mount, state: "saved", checkpoint } : undefined,
      })
    }
    if (operation.action === "write" || operation.action === "mutate") {
      const requestHash = digest({ reference: ref, operation })
      const [raw] = await Storage.readMany([operationKey!])
      if (raw !== undefined) {
        const previous = FileReceipt.parse(raw)
        if (previous.digest !== requestHash)
          fail("REVISION_CONFLICT", "File operation identity already has different input")
        await current()
        return previous.result
      }
      revision(ref.revision, info.revision)
      const selection = { workspaceID: info.id, scopeID: scope, generation: ref.generation, signal }
      if (ref.rootPath) {
        const { store } = await WorkspaceContent.resolve(selection)
        await WorkspaceContent.withTree(
          info,
          store,
          async (tree) => {
            const paths =
              operation.action === "write"
                ? [{ path: operation.path, follow: true }]
                : "path" in operation.change
                  ? [{ path: operation.change.path, follow: false }]
                  : [
                      { path: operation.change.from, follow: false },
                      { path: operation.change.to, follow: false },
                    ]
            for (const path of paths) {
              within(path.path)
              within((await tree.resolve(path.path, path.follow)).path)
            }
          },
          { signal },
        )
      }
      let prepared: WorkspaceContent.Prepared
      try {
        if (operation.action === "write") {
          const data = Buffer.from(operation.data, "base64")
          if (data.toString("base64") !== operation.data) fail("INVALID_REQUEST", "File bytes must be canonical base64")
          prepared = await WorkspaceContent.prepareWrite(selection, { ...operation, data })
        } else {
          if (
            operation.change.kind === "replace" &&
            Buffer.from(operation.change.data, "base64").toString("base64") !== operation.change.data
          )
            fail("INVALID_REQUEST", "File bytes must be canonical base64")
          prepared = await WorkspaceContent.prepareChange(selection, operation.change, operation.protectSensitive)
        }
      } catch (error) {
        if (error instanceof WorkspaceErrors.ConflictError) fail("REVISION_CONFLICT", error.message)
        if (error instanceof WorkspaceErrors.AccessDeniedError) fail("PERMISSION_DENIED", error.message)
        throw error
      }
      authority.assert()
      return Storage.transaction(
        async () => {
          const latest = await current()
          const [existing] = await Storage.readMany([operationKey!])
          if (existing !== undefined) {
            const previous = FileReceipt.parse(existing)
            if (previous.digest !== requestHash)
              fail("REVISION_CONFLICT", "File operation identity already has different input")
            return previous.result
          }
          revision(ref.revision, latest.revision)
          const published = await prepared.publish()
          const result = Cloud.FileResult.parse({
            reference: reference(published),
            result: {
              action: operation.action,
              checkpoint: {
                id: operation.id,
                mount: { id: info.id, workspaceID: info.id, generation: ref.generation },
                manifest: prepared.manifest,
                beforeManifest: prepared.info.content?.manifest ?? undefined,
                isolated: true,
              },
            },
          })
          await Storage.write(
            operationKey!,
            FileReceipt.parse({ version: 1, digest: requestHash, reference: ref, result }),
          )
          authority.assert()
          return result
        },
        { commitGuard: authority.assert },
      )
    }
    const { store } = await WorkspaceContent.resolve({
      workspaceID: info.id,
      scopeID: scope,
      generation: ref.generation,
      signal,
    })
    const result = await WorkspaceContent.withTree(
      info,
      store,
      async (tree) => {
        within(operation.path)
        const resolved = await tree.resolve(
          operation.path,
          operation.action === "canonical" ? operation.follow : operation.action === "stat" ? operation.follow : true,
        )
        within(resolved.path)
        const header = resolved.path ? resolved.entry : { kind: "directory" as const, path: "", mode: tree.mode }
        if (operation.action === "canonical") return { action: "canonical" as const, path: resolved.path }
        if (operation.action === "stat")
          return { action: "stat" as const, item: header ? item(info, header, operation.path) : undefined }
        if (operation.action === "list") {
          if (operation.cursor !== undefined && operation.revision === undefined)
            fail("INVALID_REQUEST", "Workspace list cursors require their original revision")
          if (operation.revision !== undefined) revision(operation.revision, info.revision)
          if (header?.kind !== "directory") fail("INVALID_REQUEST", "Workspace path is not a directory")
          if (
            operation.cursor !== undefined &&
            operation.cursor.slice(0, Math.max(0, operation.cursor.lastIndexOf("/"))) !== resolved.path
          )
            fail("INVALID_REQUEST", "Workspace cursor is not a direct child of its canonical directory")
          const entries: z.infer<typeof Cloud.FileItem>[] = []
          for await (const child of tree.children(resolved.path, { after: operation.cursor })) {
            entries.push(item(info, child, child.path))
            if (entries.length > operation.limit) break
          }
          return {
            action: "list" as const,
            items: entries.slice(0, operation.limit),
            cursor: entries.length > operation.limit ? entries[operation.limit - 1]?.path : undefined,
            revision: info.revision,
          }
        }
        if (header?.kind !== "file") fail("NOT_FOUND", "Workspace file is absent")
        const version = `sha256:${header.hash}`
        if (operation.expectedVersion !== undefined && operation.expectedVersion !== version)
          fail("REVISION_CONFLICT", "Workspace file version changed")
        const length = Math.min(operation.maximumBytes, Math.max(0, header.size - operation.offset))
        const bytes = new Uint8Array(length)
        let offset = 0
        for await (const chunk of tree.read(resolved.path, { offset: operation.offset, length })) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        if (offset !== length) fail("RESOURCE_UNAVAILABLE", "Workspace file output is incomplete")
        return {
          action: "read" as const,
          data: Buffer.from(bytes).toString("base64"),
          version,
          size: header.size,
          mode: header.mode,
        }
      },
      { signal },
    )
    return finish(result)
  }

  export async function handoffWorkspace(
    evidence: OrganizationHandoffExecution.WorkspaceAuthority,
    signal?: AbortSignal,
  ): Promise<Cloud.HandoffWorkspaceResult> {
    const frame = OrganizationHandoffExecution.workspaceAuthority(evidence)
    const operation = frame.proof.operation
    await frame.recheck()
    if (
      operation.action === "source" ||
      operation.action === "source-object" ||
      operation.action === "source-validate"
    ) {
      const selected = frame.source
      if (!selected) fail("PROTOCOL_MISMATCH", "Workspace handoff has no live source selection")
      let snapshot = await frame.snapshot()
      const { info, store } = await WorkspaceContent.resolve({
        workspaceID: selected.workspaceID,
        scopeID: frame.scopeID,
        generation: selected.generation,
        signal,
      })
      const membership = (manifest: string, hash: string) => [
        "organization",
        "cloud",
        "handoff-source-objects",
        frame.proof.handoffID,
        manifest,
        hash,
      ]
      if (!snapshot) {
        if (operation.action !== "source") fail("HANDOFF_BLOCKED", "Workspace source has no completed snapshot")
        const saved = await WorkspaceArchive.saved({
          workspaceID: info.id,
          scopeID: info.scopeID,
          expectedRevision: info.revision,
        })
        snapshot = await WorkspaceArchive.subtree(saved, selected.path, signal)
        for await (const object of WorkspaceArchive.subtreeObjects(snapshot)) {
          frame.assert()
          await Storage.write(membership(snapshot.manifest, object.hash), { hash: object.hash, bytes: object.bytes })
        }
        await frame.recheck()
        snapshot = await frame.retain(snapshot)
      }
      if (operation.action === "source-object") {
        const [raw] = await Storage.readMany([membership(snapshot.manifest, operation.hash)])
        const metadata = z
          .strictObject({ hash: WorkspaceTree.Hash, bytes: z.number().int().nonnegative().max(Cloud.chunkBytes) })
          .parse(raw)
        if (metadata.hash !== operation.hash || metadata.bytes > operation.maximumBytes)
          fail("INVALID_REQUEST", "Workspace source object exceeds its original bound")
        const bytes = WorkspaceTree.verify(
          operation.hash,
          await store.get(operation.hash, operation.maximumBytes),
          operation.maximumBytes,
        )
        if (bytes.byteLength !== metadata.bytes) fail("SERVICE_UNAVAILABLE", "Workspace source object is incomplete")
        await frame.recheck()
        return { action: "source-object", hash: operation.hash, data: Buffer.from(bytes).toString("base64") }
      }
      await frame.recheck()
      return Cloud.HandoffWorkspaceResult.parse({ action: operation.action, snapshot })
    }
    const request = frame.request
    if (!request) fail("PROTOCOL_MISMATCH", "Workspace handoff has no original move request")
    if (operation.action === "put") {
      const bytes = Buffer.from(operation.data, "base64")
      if (bytes.toString("base64") !== operation.data || bytes.byteLength > Cloud.chunkBytes)
        fail("INVALID_REQUEST", "Workspace transfer bytes must complete their canonical window")
      WorkspaceTree.verify(operation.hash, bytes, Cloud.chunkBytes)
      const { store } = await WorkspaceContent.resolve({ ...request.target, signal })
      frame.assert()
      await store.put(operation.hash, bytes)
      await frame.recheck()
      return { action: "put", hash: operation.hash }
    }
    if (operation.action === "inspect") {
      const status = await WorkspaceMove.inspect(request)
      await frame.recheck()
      return Cloud.HandoffWorkspaceResult.parse({ action: "inspect", status })
    }
    const receipt =
      operation.action === "validate"
        ? await WorkspaceMove.validate(request)
        : await moveSource.run(frame, () => WorkspaceMove.runCaptured(request, "organization-handoff", { signal }))
    await frame.recheck()
    return Cloud.HandoffWorkspaceResult.parse({ action: operation.action, receipt })
  }

  export async function createEnvironment(credentials: Credentials, value: Cloud.CreateEnvironment) {
    const input = Cloud.CreateEnvironment.parse(value)
    const hash = digest(input)
    return History.credentials(credentials, "cloud.environment-create", async () => {
      const { account, resource } = await authorize(credentials, "resource.use", {
        resourceID: input.resourceID,
        projectID: input.projectID,
      })
      if (resource.configuration.protocol !== "environment")
        fail("INVALID_REQUEST", "Select an execution Environment resource")
      const receipt = creationKey("environments", account.orgID, account.accountID, input.requestID)
      const [raw] = await Storage.readMany([receipt])
      if (raw) {
        const previous = EnvironmentReceipt.parse(raw)
        if (previous.digest !== hash)
          fail("INVALID_REQUEST", "Request identity belongs to another Environment creation")
        return getEnvironment(credentials, previous.id)
      }
      const profile = profiles().environmentProfiles?.[resource.configuration.profile]
      if (!profile) fail("SERVICE_UNAVAILABLE", "Execution Environment profile is unavailable")
      const environment = await Environment.bind({
        scopeID: scopeID(account.orgID, input.projectID),
        ownerID: JSON.stringify([account.accountID, input.requestID]),
        ...profile,
      })
      const locator = Locator.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        projectID: input.projectID,
        resourceID: resource.resourceID,
        id: environment.id,
        name: input.name,
      })
      await Storage.write(key("environments", environment.id), locator)
      await Storage.write(receipt, EnvironmentReceipt.parse({ schemaVersion: 1, digest: hash, id: environment.id }))
      return environmentView(locator)
    })
  }

  async function environmentView(locator: z.infer<typeof Locator>) {
    const environment = await Environment.get(locator.id, scopeID(locator.orgID, locator.projectID))
    return Cloud.Environment.parse({
      environmentID: locator.id,
      orgID: locator.orgID,
      projectID: locator.projectID,
      resourceID: locator.resourceID,
      name: locator.name,
      generation: environment.generation,
      state: environment.state,
      activeUses: (await Environment.uses(locator.id)).length,
    })
  }

  export async function getEnvironment(credentials: Credentials, environmentID: string) {
    return Storage.snapshot(async () =>
      environmentView((await resolve(credentials, "environments", Identity.ID.parse(environmentID))).locator),
    )
  }
}
