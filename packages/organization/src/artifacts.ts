import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationArtifactProtocol as Artifact,
  OrganizationIdentity as Identity,
  OrganizationPublicationProtocol as Publication,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { OrganizationPublications as Publications } from "./publications"
import { OrganizationError, fail, revision } from "./error"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { OrganizationRecord } from "./storage/records"
import { OrganizationStoragePath as OrganizationKeys } from "./storage/path"

const Item = z.strictObject({
  schemaVersion: z.literal(1),
  artifactID: Identity.ID,
  orgID: Identity.ID,
  projectID: Identity.ID,
  title: Identity.Name,
  revision: Identity.Revision,
  latestVersion: z.number().int().positive(),
})
const Version = Artifact.Version.omit({ sourceAvailable: true }).extend({
  schemaVersion: z.literal(1),
  sourceSessionID: Identity.ID,
  uploadID: Identity.ID,
})
const Receipt = z.strictObject({
  requestHash: z.string(),
  artifactID: Identity.ID,
  version: z.number().int().positive(),
})
const keys = {
  item: (orgID: string, artifactID: string) => ["organization-artifacts", "items", orgID, artifactID],
  index: (orgID: string, projectID: string) => ["organization-artifacts", "index", orgID, projectID],
  versions: (orgID: string, artifactID: string) => ["organization-artifacts", "versions", orgID, artifactID],
  version: (orgID: string, artifactID: string, version: number) => [
    "organization-artifacts",
    "versions",
    orgID,
    artifactID,
    String(version).padStart(16, "0"),
  ],
  receipt: (orgID: string, accountID: string, requestID: string) => [
    "organization-artifacts",
    "receipts",
    orgID,
    accountID,
    requestID,
  ],
}

async function read<T>(schema: z.ZodType<T>, key: string[]) {
  const [value] = await Storage.readMany<unknown>([key])
  return value === undefined ? undefined : schema.parse(value)
}

async function item(credentials: Credentials, artifactID: string, write = false) {
  const { account } = await authorize(credentials, "organization.read")
  const value = await read(Item, keys.item(account.orgID, Identity.ID.parse(artifactID)))
  if (!value || value.orgID !== account.orgID || value.artifactID !== artifactID)
    fail("NOT_FOUND", "Published artifact not found")
  await authorize(credentials, write ? "project.execute" : "project.read", { projectID: value.projectID })
  return value
}

async function version(current: z.infer<typeof Item>, selected = current.latestVersion) {
  const value = await read(
    Version,
    keys.version(current.orgID, current.artifactID, z.number().int().positive().parse(selected)),
  )
  if (
    !value ||
    value.orgID !== current.orgID ||
    value.projectID !== current.projectID ||
    value.artifactID !== current.artifactID ||
    value.version !== selected
  )
    fail("NOT_FOUND", "Published artifact version not found")
  return value
}

async function view(credentials: Credentials, value: z.infer<typeof Version>): Promise<Artifact.Version> {
  const { schemaVersion: _, uploadID: _upload, sourceSessionID, ...result } = value
  try {
    await authorize(credentials, "session.read", { sessionID: sourceSessionID })
    return Artifact.Version.parse({ ...result, sourceAvailable: true, sourceSessionID })
  } catch (error) {
    if (!(error instanceof OrganizationError) || !["NOT_FOUND", "PERMISSION_DENIED"].includes(error.data.code))
      throw error
    return Artifact.Version.parse({ ...result, sourceAvailable: false })
  }
}

export namespace OrganizationArtifacts {
  export async function history(reader: Publications.HistoricalSource) {
    const bad = (message: string): never => fail("PROTOCOL_MISMATCH", "Historical artifact " + message)
    const orgID = reader.read(Protocol.Deployment, OrganizationKeys.deployment()).orgID
    const account = (accountID: string) => {
      const value = reader.read(OrganizationRecord.Account, OrganizationKeys.account(accountID))
      if (value.orgID !== orgID || value.accountID !== accountID) bad("has another original account")
    }
    for (const row of reader.entries(["organization-artifacts", "items"])) {
      const item = Item.parse(row.value)
      const project = reader.read(OrganizationRecord.Project, OrganizationKeys.project(item.projectID))
      if (
        JSON.stringify(row.key) !== JSON.stringify(keys.item(orgID, item.artifactID)) ||
        item.orgID !== orgID ||
        project.orgID !== orgID ||
        project.projectID !== item.projectID
      )
        bad("item has another canonical project or key")
      let count = 0
      let latest: z.infer<typeof Version> | undefined
      for (const row of reader.entries(keys.versions(orgID, item.artifactID))) {
        const version = Version.parse(row.value)
        if (
          version.version !== ++count ||
          JSON.stringify(row.key) !== JSON.stringify(keys.version(orgID, item.artifactID, count)) ||
          version.orgID !== orgID ||
          version.projectID !== item.projectID ||
          version.artifactID !== item.artifactID ||
          version.revision !== (latest?.revision ?? 0) + 1 ||
          (version.author && version.author.accountID !== version.authorID)
        )
          bad("version has another original item or sequence")
        account(version.authorID)
        await Publications.historicalUpload(reader, {
          ...version,
          purpose: "artifact",
          scope: { kind: "project", projectID: item.projectID },
        })
        latest = version
        reader.accept(row.key)
      }
      if (!latest || count !== item.latestVersion || latest.revision !== item.revision || latest.title !== item.title)
        bad("item version history is incomplete")
      reader.accept(row.key)
      const index = [...keys.index(orgID, item.projectID), item.artifactID]
      if (reader.read(z.strictObject({ artifactID: Identity.ID }), index).artifactID !== item.artifactID)
        bad("project index changed")
      reader.accept(index)
    }
    for (const row of reader.entries(["organization-artifacts", "receipts"])) {
      const receipt = Receipt.parse(row.value)
      const originalOrgID = row.key[2],
        accountID = row.key[3],
        requestID = row.key[4]
      if (row.key.length !== 5 || originalOrgID !== orgID || !accountID || !requestID)
        bad("publication receipt has another key")
      account(accountID)
      Protocol.Digest.parse(receipt.requestHash)
      const version = reader.read(Version, keys.version(orgID, receipt.artifactID, receipt.version))
      if (
        version.orgID !== orgID ||
        version.artifactID !== receipt.artifactID ||
        version.version !== receipt.version ||
        version.authorID !== accountID ||
        !reader.first(["artifact-publication", orgID, receipt.artifactID, String(receipt.version)], version)
      )
        bad("publication receipt changed its original version")
      reader.accept(row.key)
    }
    for (const row of reader.entries(["organization-artifacts", "versions"])) {
      const version = Version.parse(row.value)
      if (reader.first(["artifact-publication", version.orgID, version.artifactID, String(version.version)], version))
        bad("version has no original publication receipt")
    }
  }
  export function registerAuthorityHistory() {
    AuthorityJournal.register({
      id: "organization-artifact-authority",
      version: 1,
      prefixes: [["organization-artifacts", "items"]],
      project(_key, value) {
        const item = Item.parse(value)
        return {
          artifactID: item.artifactID,
          orgID: item.orgID,
          projectID: item.projectID,
          revision: item.revision,
          latestVersion: item.latestVersion,
        }
      },
    })
  }
  export async function publish(credentials: Credentials, value: Artifact.Publish) {
    const input = Artifact.Publish.parse(value)
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
    return History.credentials(credentials, "artifact.publish", async () => {
      const { account } = await authorize(credentials, "organization.read")
      const receiptKey = keys.receipt(account.orgID, account.accountID, input.requestID)
      const receipt = await read(Receipt, receiptKey)
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail("REVISION_CONFLICT", "Artifact publication request changed")
        const current = await item(credentials, receipt.artifactID, true)
        return view(credentials, await version(current, receipt.version))
      }
      const upload = await Publications.ready(credentials, input.uploadID, "artifact")
      if (upload.scope.kind !== "project" || !upload.sourceSessionID)
        fail("INVALID_REQUEST", "Artifact publication requires its source Session")
      const current = await read(Item, keys.item(account.orgID, input.artifactID))
      if (
        current &&
        (current.orgID !== account.orgID ||
          current.projectID !== upload.scope.projectID ||
          current.artifactID !== input.artifactID)
      )
        fail("REVISION_CONFLICT", "Artifact ownership cannot change")
      revision(input.expectedRevision, current?.revision ?? 0)
      const nextVersion = (current?.latestVersion ?? 0) + 1
      const next = Item.parse({
        schemaVersion: 1,
        artifactID: input.artifactID,
        orgID: account.orgID,
        projectID: upload.scope.projectID,
        title: input.title,
        revision: (current?.revision ?? 0) + 1,
        latestVersion: nextVersion,
      })
      const published = Version.parse({
        schemaVersion: 1,
        artifactID: input.artifactID,
        orgID: account.orgID,
        projectID: upload.scope.projectID,
        title: input.title,
        version: nextVersion,
        revision: next.revision,
        authorID: account.accountID,
        author: Publication.Author.parse({
          accountID: account.accountID,
          displayName: account.displayName,
          loginName: account.loginName,
        }),
        publishedAt: Date.now(),
        manifestHash: upload.manifestHash,
        fileCount: upload.fileCount,
        totalBytes: upload.totalBytes,
        sourceSessionID: upload.sourceSessionID,
        uploadID: input.uploadID,
      })
      await Storage.write(keys.item(account.orgID, input.artifactID), next)
      await Storage.write(keys.version(account.orgID, input.artifactID, nextVersion), published)
      await Storage.write([...keys.index(account.orgID, upload.scope.projectID), input.artifactID], {
        artifactID: input.artifactID,
      })
      await Storage.write(receiptKey, { requestHash, artifactID: input.artifactID, version: nextVersion })
      return view(credentials, published)
    })
  }

  export async function publicationReceipt(credentials: Credentials, value: Artifact.Publish) {
    const input = Artifact.Publish.parse(value)
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
    return Storage.snapshot(async () => {
      const { account } = await authorize(credentials, "organization.read")
      const receipt = await read(Receipt, keys.receipt(account.orgID, account.accountID, input.requestID))
      if (receipt) {
        const current = await item(credentials, receipt.artifactID)
        if (receipt.artifactID !== input.artifactID || receipt.requestHash !== requestHash)
          fail("REVISION_CONFLICT", "Artifact publication request changed")
        return Artifact.PublicationReceipt.parse({
          state: "published",
          version: await view(credentials, await version(current, receipt.version)),
        })
      }
      const upload = await Publications.status(credentials, input.uploadID)
      if (upload.purpose !== "artifact" || upload.state !== "sealed")
        fail("INVALID_REQUEST", "Artifact publication requires a sealed artifact upload")
      const current = await read(Item, keys.item(account.orgID, input.artifactID))
      if (current) await item(credentials, input.artifactID)
      return Artifact.PublicationReceipt.parse({ state: "missing" })
    })
  }

  export async function get(credentials: Credentials, artifactID: string, selectedVersion?: number) {
    return Storage.snapshot(async () =>
      view(credentials, await version(await item(credentials, artifactID), selectedVersion)),
    )
  }

  export async function list(credentials: Credentials, projectID: string, value: z.input<typeof Artifact.Query>) {
    const input = Artifact.Query.parse(value)
    return Storage.snapshot(async () => {
      const { account } = await authorize(credentials, "project.read", { projectID })
      const prefix = keys.index(account.orgID, projectID)
      const rows = await Storage.query({
        prefix,
        after: input.cursor ? [...prefix, input.cursor] : undefined,
        limit: input.limit + 1,
      })
      const selected = rows.slice(0, input.limit).map((row) => Identity.ID.parse(row.key.at(-1)))
      const records = await Storage.readMany<unknown>(selected.map((id) => keys.item(account.orgID, id)))
      const items: Artifact.Version[] = []
      for (let i = 0; i < records.length; i++) {
        const current = Item.parse(records[i])
        if (current.orgID !== account.orgID || current.projectID !== projectID || current.artifactID !== selected[i])
          fail("SERVICE_UNAVAILABLE", "Artifact catalog ownership is inconsistent")
        items.push(await view(credentials, await version(current)))
      }
      return Artifact.Page.parse({ items, cursor: rows.length > input.limit ? selected.at(-1) : undefined })
    })
  }

  export async function versions(
    credentials: Credentials,
    artifactID: string,
    value: z.input<typeof Artifact.VersionQuery>,
  ) {
    const input = Artifact.VersionQuery.parse(value)
    return Storage.snapshot(async () => {
      const current = await item(credentials, artifactID)
      const prefix = keys.versions(current.orgID, artifactID)
      const rows = await Storage.query({
        prefix,
        after: input.cursor ? keys.version(current.orgID, artifactID, input.cursor) : undefined,
        limit: input.limit + 1,
      })
      const items: Artifact.Version[] = []
      for (const row of rows.slice(0, input.limit)) {
        const record = Version.parse(row.value)
        if (
          record.orgID !== current.orgID ||
          record.artifactID !== current.artifactID ||
          record.projectID !== current.projectID
        )
          fail("SERVICE_UNAVAILABLE", "Artifact version ownership is inconsistent")
        items.push(await view(credentials, record))
      }
      return Artifact.VersionPage.parse({
        items,
        cursor: rows.length > input.limit ? items.at(-1)?.version : undefined,
      })
    })
  }

  export async function reference(
    credentials: Credentials,
    artifactID: string,
    selectedVersion: number,
    query: z.input<typeof Publication.PageQuery>,
  ) {
    return Storage.snapshot(async () => {
      const current = await item(credentials, artifactID)
      const published = await version(current, selectedVersion)
      const files = await Publications.page(published.uploadID, query)
      return Artifact.Reference.parse({
        artifactID,
        version: selectedVersion,
        manifestHash: published.manifestHash,
        projectID: current.projectID,
        files: files.items,
        cursor: files.cursor,
      })
    })
  }

  export async function content(
    credentials: Credentials,
    artifactID: string,
    selectedVersion: number,
    fileID: string,
    range?: string,
    signal?: AbortSignal,
  ) {
    const published = await Storage.snapshot(async () => version(await item(credentials, artifactID), selectedVersion))
    return Publications.content({
      uploadID: published.uploadID,
      fileID,
      range,
      signal,
      authorize: () => Storage.snapshot(async () => version(await item(credentials, artifactID), selectedVersion)),
    })
  }
}
