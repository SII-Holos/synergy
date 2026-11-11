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
import { KnowledgeSelections as Selections } from "./knowledge-selection"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationAuthorityHistory as History } from "./authority-history"

const Item = Knowledge.Item.extend({ schemaVersion: z.literal(1) })
const Release = Knowledge.Release.extend({ schemaVersion: z.literal(1), uploadID: Identity.ID })
const Receipt = z.strictObject({ requestHash: z.string(), itemID: Identity.ID, version: z.number().int().positive() })
const Selection = Selections.Header
const SelectionUpdate = Knowledge.SelectionUpdate.extend({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  accountID: Identity.ID,
  projectID: Identity.ID,
  requestHash: z.string(),
  pointer: z.array(z.string()),
})
const updateKey = (orgID: string, accountID: string, updateID: string) => [
  "organization-knowledge",
  "updates",
  orgID,
  accountID,
  Identity.ID.parse(updateID),
]
const updateRequestKey = (orgID: string, accountID: string, requestID: string) => [
  "organization-knowledge",
  "update-requests",
  orgID,
  accountID,
  requestID,
]
const updateReferences = (update: z.infer<typeof SelectionUpdate>) => [
  ...updateKey(update.orgID, update.accountID, update.updateID),
  "references",
]
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

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
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

async function validateReference(credentials: Credentials, projectID: string, reference: Knowledge.Reference) {
  const current = await item(credentials, reference.itemID)
  if (current.state !== "published" || (current.scope.kind === "project" && current.scope.projectID !== projectID))
    fail("NOT_FOUND", "Knowledge is not available to this project")
  const release = await getRelease(current, reference.version)
  if (release.manifestHash !== reference.manifestHash) fail("REVISION_CONFLICT", "Knowledge version hash changed")
  return reference
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
  export function registerAuthorityHistory() {
    AuthorityJournal.register({
      id: "organization-knowledge-authority",
      version: 1,
      prefixes: [
        ["organization-knowledge", "items"],
        ["organization-knowledge", "applied"],
        ["organization-knowledge", "sessions"],
      ],
      project(key, value) {
        if (key[1] !== "items") return Selections.authority(value)
        const item = Item.parse(value)
        return {
          itemID: item.itemID,
          orgID: item.orgID,
          scope: item.scope,
          kind: item.kind,
          state: item.state,
          revision: item.revision,
          latestVersion: item.latestVersion,
        }
      },
    })
  }
  export async function publish(credentials: Credentials, value: Knowledge.Publish) {
    const input = Knowledge.Publish.parse(value)
    const upload = await Storage.snapshot(() => Publications.ready(credentials, input.uploadID, "knowledge"))
    const skill = input.kind === "skill" ? await validateSkill(input.uploadID) : undefined
    return History.credentials(credentials, "knowledge.publish", async () => {
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
    return History.credentials(credentials, "knowledge.withdraw", async () => {
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

  async function appliedHeader(credentials: Credentials, projectID: string) {
    const { account } = await authorize(credentials, "project.read", { projectID })
    return (
      (await Selections.read(keys.applied(account.orgID, account.accountID, projectID))) ??
      Selections.empty(account.orgID, projectID, account.accountID)
    )
  }

  export async function appliedPage(
    credentials: Credentials,
    projectID: string,
    query: z.input<typeof Knowledge.SelectionPageQuery>,
  ) {
    return Storage.snapshot(async () => Selections.page(await appliedHeader(credentials, projectID), query))
  }

  export async function appliedReferences(
    credentials: Credentials,
    projectID: string,
    query: z.infer<typeof Knowledge.SelectionReferences>,
  ) {
    return Storage.snapshot(async () => Selections.selected(await appliedHeader(credentials, projectID), query))
  }

  async function updateTarget(credentials: Credentials, target: Knowledge.SelectionTarget) {
    if (target.kind === "member") {
      const { account } = await authorize(credentials, "project.execute", { projectID: target.projectID })
      return {
        account,
        projectID: target.projectID,
        pointer: keys.applied(account.orgID, account.accountID, target.projectID),
      }
    }
    const { account, session } = await authorize(credentials, "session.execute", { sessionID: target.sessionID })
    const runtime = await OrganizationRecord.read(
      OrganizationRecord.RuntimeRegistration,
      OrganizationKeys.runtime(session.driverRuntimeID),
    )
    if (!runtime || runtime.orgID !== session.orgID)
      fail("SERVICE_UNAVAILABLE", "Knowledge Runtime ownership is unavailable")
    if (runtime.runtimeKind === "member")
      fail("INVALID_REQUEST", "Member Runtime Sessions use their owner's project applied collection")
    return { account, projectID: session.projectID, pointer: keys.session(session.sessionID) }
  }

  function updateView(update: z.infer<typeof SelectionUpdate>) {
    return Knowledge.SelectionUpdate.parse(Knowledge.SelectionUpdate.strip().parse(update))
  }

  async function loadUpdate(credentials: Credentials, updateID: string) {
    const { account } = await authorize(credentials, "organization.read")
    const update = await read(SelectionUpdate, updateKey(account.orgID, account.accountID, updateID))
    if (!update || update.orgID !== account.orgID || update.accountID !== account.accountID)
      fail("NOT_FOUND", "Knowledge update not found")
    const authorized = await updateTarget(credentials, update.target)
    if (
      authorized.projectID !== update.projectID ||
      JSON.stringify(authorized.pointer) !== JSON.stringify(update.pointer)
    )
      fail("STALE_BINDING", "Knowledge update target changed")
    return update
  }

  export async function beginSelectionUpdate(
    credentials: Credentials,
    value: z.infer<typeof Knowledge.BeginSelectionUpdate>,
  ) {
    const input = Knowledge.BeginSelectionUpdate.parse(value)
    return Storage.transaction(async () => {
      const target = await updateTarget(credentials, input.target)
      const requestHash = digest(input)
      const requestKey = updateRequestKey(target.account.orgID, target.account.accountID, input.requestID)
      const [existing] = await Storage.readMany([requestKey])
      if (existing !== undefined) {
        const receipt = z.strictObject({ updateID: Identity.ID, requestHash: z.string() }).parse(existing)
        if (receipt.requestHash !== requestHash) fail("REVISION_CONFLICT", "Knowledge update request changed")
        return updateView(await loadUpdate(credentials, receipt.updateID))
      }
      const previous =
        (await Selections.read(target.pointer)) ??
        Selections.empty(target.account.orgID, target.projectID, target.account.accountID)
      revision(input.expectedRevision, previous.revision)
      const update = SelectionUpdate.parse({
        schemaVersion: 1,
        updateID: crypto.randomUUID(),
        orgID: target.account.orgID,
        accountID: target.account.accountID,
        projectID: target.projectID,
        pointer: target.pointer,
        requestHash,
        target: input.target,
        baseRevision: previous.revision,
        nextSequence: 0,
        state: "draft",
      })
      for await (const reference of Selections.references(previous))
        await Storage.write([...updateReferences(update), reference.itemID], reference)
      await Storage.write(updateKey(update.orgID, update.accountID, update.updateID), update)
      await Storage.write(requestKey, { updateID: update.updateID, requestHash })
      return updateView(update)
    })
  }

  export async function selectionUpdate(credentials: Credentials, updateID: string) {
    return Storage.snapshot(async () => updateView(await loadUpdate(credentials, updateID)))
  }

  export async function patchSelectionUpdate(
    credentials: Credentials,
    updateID: string,
    value: z.infer<typeof Knowledge.PatchSelectionUpdate>,
  ) {
    const input = Knowledge.PatchSelectionUpdate.parse(value)
    return Storage.transaction(async () => {
      const update = await loadUpdate(credentials, updateID)
      const pageKey = [...updateKey(update.orgID, update.accountID, updateID), "pages", String(input.sequence)]
      const requestHash = digest(input)
      const [existing] = await Storage.readMany([pageKey])
      if (existing !== undefined) {
        if (existing !== requestHash) fail("REVISION_CONFLICT", "Knowledge update page changed")
        return updateView(update)
      }
      if (update.state !== "draft") fail("REVISION_CONFLICT", "Knowledge update is already committed")
      revision(input.sequence, update.nextSequence)
      for (const change of input.changes) {
        const key = [...updateReferences(update), change.itemID]
        if (!change.reference) await Storage.remove(key)
        else {
          await validateReference(credentials, update.projectID, change.reference)
          await Storage.write(key, change.reference)
        }
      }
      const next = SelectionUpdate.parse({ ...update, nextSequence: update.nextSequence + 1 })
      await Storage.write(pageKey, requestHash)
      await Storage.write(updateKey(update.orgID, update.accountID, updateID), next)
      return updateView(next)
    })
  }

  export async function commitSelectionUpdate(
    credentials: Credentials,
    updateID: string,
    value: z.infer<typeof Knowledge.CommitSelectionUpdate>,
  ) {
    const input = Knowledge.CommitSelectionUpdate.parse(value)
    return History.credentials(credentials, "knowledge.select", async () => {
      const update = await loadUpdate(credentials, updateID)
      revision(input.expectedSequence, update.nextSequence)
      if (update.state === "committed") {
        if (!update.committed) fail("SERVICE_UNAVAILABLE", "Knowledge update receipt is incomplete")
        return update.committed
      }
      const previous = await Selections.read(update.pointer)
      revision(update.baseRevision, previous?.revision ?? 0)
      const hash = createHash("sha256").update("[")
      let count = 0
      const base = Selections.Header.parse({
        schemaVersion: 2,
        orgID: update.orgID,
        projectID: update.projectID,
        manifestID: update.updateID,
        revision: update.baseRevision + 1,
        manifestHash: "0".repeat(64),
        releaseCount: 0,
        updatedBy: update.accountID,
        updatedAt: Date.now(),
      })
      for await (const row of Storage.records({ prefix: updateReferences(update), limit: 100 })) {
        const reference = Knowledge.Reference.parse(row.value)
        if (row.key.at(-1) !== reference.itemID) fail("SERVICE_UNAVAILABLE", "Knowledge update item identity changed")
        await validateReference(credentials, update.projectID, reference)
        if (count) hash.update(",")
        hash.update(JSON.stringify(reference))
        await Selections.put(base, count++, reference)
      }
      const header = Selections.Header.parse({
        ...base,
        manifestHash: hash.update("]").digest("hex"),
        releaseCount: count,
      })
      const committed = Selections.summary(header)
      await Storage.write(update.pointer, header)
      await Storage.write(
        updateKey(update.orgID, update.accountID, updateID),
        SelectionUpdate.parse({ ...update, state: "committed", committed }),
      )
      return committed
    })
  }

  export async function inheritSession(sessionID: string) {
    const session = await OrganizationRecord.read(
      OrganizationRecord.SessionDirectory,
      OrganizationKeys.session(sessionID),
    )
    if (!session) fail("NOT_FOUND", "Session not found")
    const existing = await Selections.read(keys.session(sessionID))
    if (existing) return Selections.summary(existing)
    const applied = await Selections.read(keys.applied(session.orgID, session.creatorID, session.projectID))
    const selected = Selection.parse({
      ...(applied ?? Selections.empty(session.orgID, session.projectID, session.creatorID)),
      revision: 0,
    })
    await Storage.write(keys.session(sessionID), selected)
    return Selections.summary(selected)
  }

  export async function sessionSelectionPage(
    credentials: Credentials,
    sessionID: string,
    query: z.input<typeof Knowledge.SelectionPageQuery>,
  ) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      return Selections.page(await desiredSelection(session), query)
    })
  }

  export async function sessionSelectionReferences(
    credentials: Credentials,
    sessionID: string,
    query: z.infer<typeof Knowledge.SelectionReferences>,
  ) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      return Selections.selected(await desiredSelection(session), query)
    })
  }

  export async function status(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      const desired = await desiredSelection(session)
      const current = await read(ActivationStatus, keys.status(sessionID))
      const observed = current?.bindingEpoch === session.bindingEpoch ? current : undefined
      const failed = observed?.failedManifestHash === desired.manifestHash
      return Knowledge.Status.parse({
        orgID: session.orgID,
        projectID: session.projectID,
        sessionID,
        desired: Selections.summary(desired),
        activated: observed?.activated,
        state: failed ? "failed" : observed?.activated?.manifestHash === desired.manifestHash ? "active" : "pending",
        error: failed ? "update_failed" : undefined,
      })
    })
  }

  async function desiredSelection(session: z.infer<typeof OrganizationRecord.SessionDirectory>) {
    const runtime = await OrganizationRecord.read(
      OrganizationRecord.RuntimeRegistration,
      OrganizationKeys.runtime(session.driverRuntimeID),
    )
    if (!runtime || runtime.orgID !== session.orgID)
      fail("SERVICE_UNAVAILABLE", "Knowledge Runtime ownership is unavailable")
    const selected = await Selections.read(
      runtime.runtimeKind === "member"
        ? keys.applied(session.orgID, runtime.accountID, session.projectID)
        : keys.session(session.sessionID),
    )
    if (selected && (selected.orgID !== session.orgID || selected.projectID !== session.projectID))
      fail("SERVICE_UNAVAILABLE", "Knowledge selection ownership is inconsistent")
    return (
      selected ??
      Selections.empty(
        session.orgID,
        session.projectID,
        runtime.runtimeKind === "member" ? runtime.accountID : session.creatorID,
      )
    )
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
    const selected = await Selections.read(keys.activated(grant.sessionID, activatedManifestHash))
    if (!selected) fail("PERMISSION_DENIED", "Knowledge manifest was never activated for this Session")
    if (
      selected.orgID !== grant.orgID ||
      selected.projectID !== grant.projectID ||
      selected.manifestHash !== activatedManifestHash
    )
      fail("SERVICE_UNAVAILABLE", "Knowledge selection ownership is inconsistent")
    return selected
  }

  async function executionRelease(
    grant: Execution.Grant,
    reference: Knowledge.Reference,
    activatedManifestHash?: string,
  ) {
    const selected = await executionSelection(grant, activatedManifestHash)
    const chosen = await Selections.reference(selected, reference.itemID)
    if (!chosen || chosen.version !== reference.version || chosen.manifestHash !== reference.manifestHash)
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
      const page = await Selections.page(selection, value)
      const items: Knowledge.Release[] = []
      for (const reference of page.items)
        items.push(releaseView(await executionRelease(grant, reference, activatedManifestHash)))
      return Knowledge.ExecutionPage.parse({
        orgID: grant.orgID,
        projectID: grant.projectID,
        sessionID: grant.sessionID,
        selection: page.selection,
        items,
        cursor: page.cursor,
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
        for await (const reference of Selections.references(selection)) await executionRelease(grant, reference)
        await Storage.write(keys.activated(grant.sessionID, selection.manifestHash), selection)
        await Storage.write(
          keys.status(grant.sessionID),
          ActivationStatus.parse({
            schemaVersion: 1,
            bindingEpoch: grant.bindingEpoch,
            activated: Selections.summary(selection),
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
