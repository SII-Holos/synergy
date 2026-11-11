import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ConfigMarkdown } from "@ericsanchezok/synergy-harness/config/markdown"
import { SkillManifest } from "@ericsanchezok/synergy-local-runtime/skill/manifest"
import {
  OrganizationIdentity as Identity,
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { authorizePublicationScope, publicationScopeKey } from "./publication-access"
import { OrganizationPublications as Publications } from "./publications"
import { OrganizationStoragePath as OrganizationKeys } from "./storage/path"
import { OrganizationRecord } from "./storage/records"
import { fail, revision } from "./error"
import { searchPublication } from "./publication-search"

const Item = Knowledge.Item.extend({ schemaVersion: z.literal(1) })
const Release = Knowledge.Release.extend({ schemaVersion: z.literal(1), uploadID: Identity.ID })
const Receipt = z.strictObject({ requestHash: z.string(), itemID: Identity.ID, version: z.number().int().positive() })
const Selection = Knowledge.Selection.extend({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  projectID: Identity.ID,
})
const ActivationStatus = z.strictObject({
  schemaVersion: z.literal(1),
  bindingEpoch: z.number().int().positive(),
  activated: Knowledge.SelectionSummary.optional(),
  failedManifestHash: z.string().optional(),
})
const keys = {
  item: (orgID: string, itemID: string) => ["organization-knowledge", "items", orgID, itemID],
  index: (orgID: string, scope: Publication.Scope) => [
    "organization-knowledge",
    "index",
    orgID,
    publicationScopeKey(scope),
  ],
  releases: (orgID: string, itemID: string) => ["organization-knowledge", "releases", orgID, itemID],
  release: (orgID: string, itemID: string, version: number) => [
    "organization-knowledge",
    "releases",
    orgID,
    itemID,
    String(version).padStart(16, "0"),
  ],
  receipt: (orgID: string, accountID: string, requestID: string) => [
    "organization-knowledge",
    "receipts",
    orgID,
    accountID,
    requestID,
  ],
  applied: (orgID: string, accountID: string, projectID: string) => [
    "organization-knowledge",
    "applied",
    orgID,
    accountID,
    projectID,
  ],
  session: (sessionID: string) => ["organization-knowledge", "sessions", sessionID],
  activated: (sessionID: string, manifestHash: string) => [
    "organization-knowledge",
    "activated",
    sessionID,
    manifestHash,
  ],
  status: (sessionID: string) => ["organization-knowledge", "activation-status", sessionID],
}

async function read<T>(schema: z.ZodType<T>, key: string[]) {
  const [value] = await Storage.readMany<unknown>([key])
  return value === undefined ? undefined : schema.parse(value)
}

function itemView(value: z.infer<typeof Item>) {
  return Knowledge.Item.parse(Knowledge.Item.strip().parse(value))
}

function releaseView(value: z.infer<typeof Release>) {
  return Knowledge.Release.parse(Knowledge.Release.strip().parse(value))
}

function selectionView(value: z.infer<typeof Selection>) {
  return Knowledge.Selection.parse(Knowledge.Selection.strip().parse(value))
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function emptySelection(accountID: string): Knowledge.Selection {
  return { revision: 0, releases: [], manifestHash: digest([]), updatedBy: accountID, updatedAt: 0 }
}

async function item(credentials: Credentials, itemID: string, write = false) {
  const { account } = await authorize(credentials, "organization.read")
  const value = await read(Item, keys.item(account.orgID, Identity.ID.parse(itemID)))
  if (!value || value.orgID !== account.orgID || value.itemID !== itemID)
    fail("NOT_FOUND", "Published knowledge not found")
  await authorizePublicationScope(credentials, value.scope, write)
  return value
}

async function getRelease(current: z.infer<typeof Item>, version = current.latestVersion) {
  const result = await read(
    Release,
    keys.release(current.orgID, current.itemID, z.number().int().positive().parse(version)),
  )
  if (!result || result.orgID !== current.orgID || result.itemID !== current.itemID || result.version !== version)
    fail("NOT_FOUND", "Published knowledge version not found")
  return result
}

async function validateSelection(credentials: Credentials, projectID: string, input: Knowledge.Apply) {
  const releases = [...input.releases].sort((a, b) => a.itemID.localeCompare(b.itemID))
  for (const reference of releases) {
    const current = await item(credentials, reference.itemID)
    if (current.state !== "published" || (current.scope.kind === "project" && current.scope.projectID !== projectID))
      fail("NOT_FOUND", "Knowledge is not available to this project")
    const release = await getRelease(current, reference.version)
    if (release.manifestHash !== reference.manifestHash) fail("REVISION_CONFLICT", "Knowledge version hash changed")
  }
  return releases
}

async function validateSkill(uploadID: string) {
  let descriptor: Publication.File | undefined
  for await (const file of Publications.allFiles(uploadID)) if (file.path === "SKILL.md") descriptor = file
  if (!descriptor) fail("INVALID_REQUEST", "A Skill release must contain SKILL.md")
  let header = ""
  const decoder = new TextDecoder("utf-8", { fatal: true })
  try {
    for (let offset = 0; offset < descriptor.bytes; offset += 16 * 1024) {
      header += decoder.decode(
        await Publications.readRange(uploadID, descriptor, offset, Math.min(16 * 1024, descriptor.bytes - offset)),
        { stream: true },
      )
      const boundary = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(header)
      if (boundary) {
        header = boundary[0]
        break
      }
      if (!header.startsWith("---") || header.length > 1024 * 1024)
        fail("INVALID_REQUEST", "Skill frontmatter is missing or exceeds its format limit")
    }
    const document = ConfigMarkdown.parseContent(header, "SKILL.md")
    const manifest = SkillManifest.Schema.parse(document.data)
    return Knowledge.Skill.parse({
      name: manifest.name,
      description: manifest.description,
      license: manifest.license,
      compatibility: manifest.compatibility,
    })
  } catch {
    fail("INVALID_REQUEST", "Skill frontmatter is invalid")
  }
}

export namespace OrganizationKnowledge {
  export async function publish(credentials: Credentials, value: Knowledge.Publish) {
    const input = Knowledge.Publish.parse(value)
    const upload = await Storage.snapshot(() => Publications.ready(credentials, input.uploadID, "knowledge"))
    const skill = input.kind === "skill" ? await validateSkill(input.uploadID) : undefined
    return Storage.transaction(async () => {
      const ready = await Publications.ready(credentials, input.uploadID, "knowledge")
      const account = await authorizePublicationScope(credentials, ready.scope, true)
      const requestHash = digest(input)
      const receiptKey = keys.receipt(account.orgID, account.accountID, input.requestID)
      const receipt = await read(Receipt, receiptKey)
      const current = await read(Item, keys.item(account.orgID, input.itemID))
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail("REVISION_CONFLICT", "Knowledge publication request changed")
        if (!current) fail("SERVICE_UNAVAILABLE", "Knowledge publication receipt is incomplete")
        return releaseView(await getRelease(current, receipt.version))
      }
      if (
        current &&
        (current.orgID !== account.orgID ||
          current.itemID !== input.itemID ||
          current.kind !== input.kind ||
          publicationScopeKey(current.scope) !== publicationScopeKey(ready.scope))
      )
        fail("REVISION_CONFLICT", "Knowledge ownership and kind cannot change")
      revision(input.expectedRevision, current?.revision ?? 0)
      const now = Date.now()
      const version = (current?.latestVersion ?? 0) + 1
      const release = Release.parse({
        schemaVersion: 1,
        itemID: input.itemID,
        orgID: account.orgID,
        scope: ready.scope,
        kind: input.kind,
        title: input.title,
        version,
        authorID: account.accountID,
        author: Publication.Author.parse({
          accountID: account.accountID,
          displayName: account.displayName,
          loginName: account.loginName,
        }),
        publishedAt: now,
        manifestHash: upload.manifestHash!,
        fileCount: upload.fileCount,
        totalBytes: upload.totalBytes,
        uploadID: upload.uploadID,
        skill,
      })
      const next = Item.parse({
        schemaVersion: 1,
        itemID: input.itemID,
        orgID: account.orgID,
        scope: ready.scope,
        kind: input.kind,
        title: input.title,
        authorID: current?.authorID ?? account.accountID,
        state: "published",
        revision: (current?.revision ?? 0) + 1,
        latestVersion: version,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      })
      await Storage.write(keys.item(account.orgID, input.itemID), next)
      await Storage.write(keys.release(account.orgID, input.itemID, version), release)
      await Storage.write([...keys.index(account.orgID, ready.scope), input.itemID], { itemID: input.itemID })
      await Storage.write(receiptKey, { requestHash, itemID: input.itemID, version })
      return releaseView(release)
    })
  }

  export async function get(credentials: Credentials, itemID: string, version?: number) {
    return Storage.snapshot(async () => releaseView(await getRelease(await item(credentials, itemID), version)))
  }

  async function catalog(
    credentials: Credentials,
    value: z.input<typeof Knowledge.Query>,
    q?: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    const input = Knowledge.Query.parse(value)
    const page = await Storage.snapshot(async () => {
      const { account } = await authorize(credentials, "organization.read")
      if (input.projectID) await authorize(credentials, "project.read", { projectID: input.projectID })
      const scopes: Publication.Scope[] = [
        { kind: "organization" },
        ...(input.projectID ? [{ kind: "project" as const, projectID: input.projectID }] : []),
      ]
      const pages = await Promise.all(
        scopes.map(async (scope) => {
          const prefix = keys.index(account.orgID, scope)
          return Storage.query({
            prefix,
            after: input.cursor ? [...prefix, input.cursor] : undefined,
            limit: input.limit + 1,
          })
        }),
      )
      const candidates = [...new Set(pages.flat().map((row) => Identity.ID.parse(row.key.at(-1))))]
        .sort()
        .slice(0, input.limit + 1)
      const values = await Storage.readMany<unknown>(
        candidates.slice(0, input.limit).map((id) => keys.item(account.orgID, id)),
      )
      const items: Knowledge.Item[] = []
      for (let i = 0; i < values.length; i++) {
        if (values[i] === undefined) fail("SERVICE_UNAVAILABLE", "Knowledge catalog index is incomplete")
        const current = Item.parse(values[i])
        if (current.orgID !== account.orgID || current.itemID !== candidates[i])
          fail("SERVICE_UNAVAILABLE", "Knowledge catalog ownership is inconsistent")
        await authorizePublicationScope(credentials, current.scope)
        if (current.state !== "published" || (input.kind && current.kind !== input.kind)) continue
        items.push(itemView(current))
      }
      return Knowledge.Page.parse({
        items,
        cursor: candidates.length > input.limit ? candidates[input.limit - 1] : undefined,
      })
    })
    if (!q) return page
    const items: Knowledge.Item[] = []
    for (const candidate of page.items) {
      const release = await Storage.snapshot(async () => getRelease(await item(credentials, candidate.itemID)))
      const needle = q.toLocaleLowerCase()
      if (
        !release.title.toLocaleLowerCase().includes(needle) &&
        !release.skill?.description.toLocaleLowerCase().includes(needle) &&
        !(await searchPublication(
          release.uploadID,
          q,
          () => Storage.snapshot(() => item(credentials, candidate.itemID)),
          signal,
        ))
      )
        continue
      await Storage.snapshot(() => item(credentials, candidate.itemID))
      items.push(candidate)
    }
    return Knowledge.Page.parse({ items, cursor: page.cursor })
  }

  export function list(credentials: Credentials, input: z.input<typeof Knowledge.Query>) {
    return catalog(credentials, input)
  }

  export function search(credentials: Credentials, value: z.input<typeof Knowledge.Search>, signal?: AbortSignal) {
    const input = Knowledge.Search.parse(value)
    const { q, ...query } = input
    return catalog(credentials, query, q, signal)
  }

  export async function versions(
    credentials: Credentials,
    itemID: string,
    value: z.input<typeof Knowledge.VersionQuery>,
  ) {
    const input = Knowledge.VersionQuery.parse(value)
    return Storage.snapshot(async () => {
      const current = await item(credentials, itemID)
      const prefix = keys.releases(current.orgID, itemID)
      const rows = await Storage.query({
        prefix,
        after: input.cursor ? keys.release(current.orgID, itemID, input.cursor) : undefined,
        limit: input.limit + 1,
      })
      const items = rows.slice(0, input.limit).map((row) => releaseView(Release.parse(row.value)))
      return Knowledge.VersionPage.parse({
        items,
        cursor: rows.length > input.limit ? items.at(-1)?.version : undefined,
      })
    })
  }

  export async function files(
    credentials: Credentials,
    itemID: string,
    version: number,
    query: z.input<typeof Publication.PageQuery>,
  ) {
    return Storage.snapshot(async () => {
      const release = await getRelease(await item(credentials, itemID), version)
      return Publications.page(release.uploadID, query)
    })
  }

  export async function content(
    credentials: Credentials,
    itemID: string,
    version: number,
    fileID: string,
    range?: string,
    signal?: AbortSignal,
  ) {
    const release = await Storage.snapshot(async () => getRelease(await item(credentials, itemID), version))
    return Publications.content({
      uploadID: release.uploadID,
      fileID,
      range,
      signal,
      authorize: () => Storage.snapshot(async () => getRelease(await item(credentials, itemID), version)),
    })
  }

  export async function withdraw(credentials: Credentials, itemID: string, expectedRevision: number) {
    return Storage.transaction(async () => {
      const current = await item(credentials, itemID, true)
      revision(expectedRevision, current.revision)
      const updated = Item.parse({
        ...current,
        state: "withdrawn",
        revision: current.revision + 1,
        updatedAt: Date.now(),
      })
      await Storage.write(keys.item(current.orgID, itemID), updated)
      await Storage.remove([...keys.index(current.orgID, current.scope), itemID])
      return itemView(updated)
    })
  }

  export async function applied(credentials: Credentials, projectID: string) {
    return Storage.snapshot(async () => {
      const { account } = await authorize(credentials, "project.read", { projectID })
      const selected = await read(Selection, keys.applied(account.orgID, account.accountID, projectID))
      return selected ? selectionView(selected) : emptySelection(account.accountID)
    })
  }

  export async function apply(credentials: Credentials, projectID: string, value: Knowledge.Apply) {
    const input = Knowledge.Apply.parse(value)
    return Storage.transaction(async () => {
      const { account } = await authorize(credentials, "project.execute", { projectID })
      const key = keys.applied(account.orgID, account.accountID, projectID)
      const previous = await read(Selection, key)
      revision(input.expectedRevision, previous?.revision ?? 0)
      const releases = await validateSelection(credentials, projectID, input)
      const selection = Selection.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        projectID,
        revision: (previous?.revision ?? 0) + 1,
        releases,
        manifestHash: digest(releases),
        updatedBy: account.accountID,
        updatedAt: Date.now(),
      })
      await Storage.write(key, selection)
      return selectionView(selection)
    })
  }

  export async function inheritSession(sessionID: string) {
    const session = await OrganizationRecord.read(
      OrganizationRecord.SessionDirectory,
      OrganizationKeys.session(sessionID),
    )
    if (!session) fail("NOT_FOUND", "Session not found")
    const existing = await read(Selection, keys.session(sessionID))
    if (existing) return selectionView(existing)
    const applied = await read(Selection, keys.applied(session.orgID, session.creatorID, session.projectID))
    const selected = Selection.parse({
      schemaVersion: 1,
      orgID: session.orgID,
      projectID: session.projectID,
      ...(applied ? selectionView(applied) : emptySelection(session.creatorID)),
      revision: 0,
    })
    await Storage.write(keys.session(sessionID), selected)
    return selectionView(selected)
  }

  export async function sessionSelection(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      return desiredSelection(session)
    })
  }

  export async function status(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      const desired = await desiredSelection(session)
      const current = await read(ActivationStatus, keys.status(sessionID))
      const observed = current?.bindingEpoch === session.bindingEpoch ? current : undefined
      const { releases, ...summary } = desired
      const failed = observed?.failedManifestHash === desired.manifestHash
      return Knowledge.Status.parse({
        orgID: session.orgID,
        projectID: session.projectID,
        sessionID,
        desired: { ...summary, releaseCount: releases.length },
        activated: observed?.activated,
        state: failed ? "failed" : observed?.activated?.manifestHash === desired.manifestHash ? "active" : "pending",
        error: failed ? "update_failed" : undefined,
      })
    })
  }

  export async function setSessionSelection(credentials: Credentials, sessionID: string, value: Knowledge.Apply) {
    const input = Knowledge.Apply.parse(value)
    return Storage.transaction(async () => {
      const { account, session } = await authorize(credentials, "session.execute", { sessionID })
      const runtime = await OrganizationRecord.read(
        OrganizationRecord.RuntimeRegistration,
        OrganizationKeys.runtime(session.driverRuntimeID),
      )
      if (runtime?.runtimeKind === "member")
        fail("INVALID_REQUEST", "Member Runtime Sessions use their owner's project applied collection")
      const previous = await read(Selection, keys.session(sessionID))
      revision(input.expectedRevision, previous?.revision ?? 0)
      const releases = await validateSelection(credentials, session.projectID, input)
      const selected = Selection.parse({
        schemaVersion: 1,
        orgID: session.orgID,
        projectID: session.projectID,
        revision: (previous?.revision ?? 0) + 1,
        releases,
        manifestHash: digest(releases),
        updatedBy: account.accountID,
        updatedAt: Date.now(),
      })
      await Storage.write(keys.session(sessionID), selected)
      return selectionView(selected)
    })
  }

  async function desiredSelection(session: z.infer<typeof OrganizationRecord.SessionDirectory>) {
    const runtime = await OrganizationRecord.read(
      OrganizationRecord.RuntimeRegistration,
      OrganizationKeys.runtime(session.driverRuntimeID),
    )
    if (!runtime || runtime.orgID !== session.orgID)
      fail("SERVICE_UNAVAILABLE", "Knowledge Runtime ownership is unavailable")
    const selected = await read(
      Selection,
      runtime.runtimeKind === "member"
        ? keys.applied(session.orgID, runtime.accountID, session.projectID)
        : keys.session(session.sessionID),
    )
    if (selected && (selected.orgID !== session.orgID || selected.projectID !== session.projectID))
      fail("SERVICE_UNAVAILABLE", "Knowledge selection ownership is inconsistent")
    return selected
      ? selectionView(selected)
      : emptySelection(runtime.runtimeKind === "member" ? runtime.accountID : session.creatorID)
  }

  async function executionSelection(grant: Execution.Grant, activatedManifestHash?: string) {
    const session = await OrganizationRecord.read(
      OrganizationRecord.SessionDirectory,
      OrganizationKeys.session(grant.sessionID),
    )
    if (
      !session ||
      session.orgID !== grant.orgID ||
      session.projectID !== grant.projectID ||
      session.driverRuntimeID !== grant.runtimeID ||
      session.bindingEpoch !== grant.bindingEpoch
    )
      fail("STALE_BINDING", "Knowledge execution binding changed")
    if (!activatedManifestHash) return desiredSelection(session)
    const selected = await read(Selection, keys.activated(grant.sessionID, activatedManifestHash))
    if (!selected) fail("PERMISSION_DENIED", "Knowledge manifest was never activated for this Session")
    if (
      selected.orgID !== grant.orgID ||
      selected.projectID !== grant.projectID ||
      selected.manifestHash !== activatedManifestHash
    )
      fail("SERVICE_UNAVAILABLE", "Knowledge selection ownership is inconsistent")
    return selectionView(selected)
  }

  async function executionRelease(
    grant: Execution.Grant,
    reference: Knowledge.Reference,
    activatedManifestHash?: string,
  ) {
    const selected = await executionSelection(grant, activatedManifestHash)
    if (
      !selected.releases.some(
        (current) =>
          current.itemID === reference.itemID &&
          current.version === reference.version &&
          current.manifestHash === reference.manifestHash,
      )
    )
      fail("PERMISSION_DENIED", "Knowledge version is not selected by this Session")
    const current = await read(Item, keys.item(grant.orgID, reference.itemID))
    if (
      !current ||
      current.state !== "published" ||
      current.orgID !== grant.orgID ||
      (current.scope.kind === "project" && current.scope.projectID !== grant.projectID)
    )
      fail("NOT_FOUND", "Knowledge is not available to this Session")
    const release = await getRelease(current, reference.version)
    if (release.manifestHash !== reference.manifestHash)
      fail("REVISION_CONFLICT", "Knowledge reference checksum changed")
    return release
  }

  export async function executionPage(
    grant: Execution.Grant,
    value: Omit<z.infer<typeof Knowledge.ExecutionQuery>, "authority">,
  ) {
    return executionPageFor(grant, value)
  }

  async function executionPageFor(
    grant: Execution.Grant,
    value: { limit: number; cursor?: string; manifestHash?: string },
    activatedManifestHash?: string,
  ) {
    return Storage.snapshot(async () => {
      const selection = await executionSelection(grant, activatedManifestHash)
      if (value.manifestHash && selection.manifestHash !== value.manifestHash)
        fail("REVISION_CONFLICT", "Session knowledge selection changed during preparation")
      const selected = selection.releases.filter((reference) => !value.cursor || reference.itemID > value.cursor)
      const items: Knowledge.Release[] = []
      for (const reference of selected.slice(0, value.limit))
        items.push(releaseView(await executionRelease(grant, reference, activatedManifestHash)))
      const { releases, ...metadata } = selection
      return Knowledge.ExecutionPage.parse({
        orgID: grant.orgID,
        projectID: grant.projectID,
        sessionID: grant.sessionID,
        selection: { ...metadata, releaseCount: releases.length },
        items,
        cursor: selected.length > value.limit ? items.at(-1)?.itemID : undefined,
      })
    })
  }

  export async function activate(
    grant: Execution.Grant,
    input: { manifestHash: string; revision: number; outcome?: "activated" | "failed" },
  ) {
    return Storage.transaction(async () => {
      const selection = await executionSelection(grant)
      if (selection.manifestHash !== input.manifestHash || selection.revision !== input.revision)
        fail("REVISION_CONFLICT", "Knowledge selection changed before activation")
      const previous = await read(ActivationStatus, keys.status(grant.sessionID))
      if (input.outcome === "failed")
        await Storage.write(
          keys.status(grant.sessionID),
          ActivationStatus.parse({
            schemaVersion: 1,
            bindingEpoch: grant.bindingEpoch,
            activated: previous?.bindingEpoch === grant.bindingEpoch ? previous.activated : undefined,
            failedManifestHash: selection.manifestHash,
          }),
        )
      else {
        for (const reference of selection.releases) await executionRelease(grant, reference)
        await Storage.write(
          keys.activated(grant.sessionID, selection.manifestHash),
          Selection.parse({ schemaVersion: 1, orgID: grant.orgID, projectID: grant.projectID, ...selection }),
        )
        const { releases, ...summary } = selection
        await Storage.write(
          keys.status(grant.sessionID),
          ActivationStatus.parse({
            schemaVersion: 1,
            bindingEpoch: grant.bindingEpoch,
            activated: { ...summary, releaseCount: releases.length },
          }),
        )
      }
      return Knowledge.ActivationReceipt.parse({
        orgID: grant.orgID,
        projectID: grant.projectID,
        sessionID: grant.sessionID,
        manifestHash: selection.manifestHash,
        revision: selection.revision,
      })
    })
  }

  export function activated(grant: Execution.Grant, input: { manifestHash: string; limit: number; cursor?: string }) {
    return executionPageFor(grant, input, input.manifestHash)
  }

  export async function executionFiles(
    grant: Execution.Grant,
    reference: Knowledge.Reference,
    query: z.input<typeof Publication.PageQuery>,
    activatedManifestHash?: string,
  ) {
    return Storage.snapshot(async () =>
      Publications.page((await executionRelease(grant, reference, activatedManifestHash)).uploadID, query),
    )
  }

  export async function executionContent(
    grant: Execution.Grant,
    reference: Knowledge.Reference,
    fileID: string,
    offset: number,
    length: number,
    activatedManifestHash?: string,
  ) {
    const release = await Storage.snapshot(() => executionRelease(grant, reference, activatedManifestHash))
    const file = await Publications.file(release.uploadID, fileID)
    const count = Math.min(length, Math.max(0, file.bytes - offset))
    const bytes = await Publications.readRange(release.uploadID, file, offset, count)
    await Storage.snapshot(() => executionRelease(grant, reference, activatedManifestHash))
    return Knowledge.ContentChunk.parse({
      fileID,
      sha256: file.sha256,
      offset,
      totalBytes: file.bytes,
      data: Buffer.from(bytes).toString("base64url"),
    })
  }
}
