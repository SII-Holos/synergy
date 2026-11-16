import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { InstructionRegistry } from "@ericsanchezok/synergy-harness/instruction/registry"
import { Skill } from "@ericsanchezok/synergy-local-runtime/skill/skill"
import { SkillManifest } from "@ericsanchezok/synergy-local-runtime/skill/manifest"
import { skillEntry } from "@ericsanchezok/synergy-local-runtime/skill/register"
import { ActiveKnowledgeStore as ActiveStore } from "./knowledge-active"
import { KnowledgeCache } from "./knowledge-cache"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

export interface KnowledgeTransport {
  selection(query?: { cursor?: string; manifestHash?: string }, signal?: AbortSignal): Promise<Knowledge.ExecutionPage>
  files(
    reference: Knowledge.Reference,
    query?: { cursor?: string },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Publication.FilePage>>
  content(
    reference: Knowledge.Reference,
    fileID: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Knowledge.ContentChunk>
  activate?(
    selection: { manifestHash: string; revision: number },
    signal?: AbortSignal,
  ): Promise<Knowledge.ActivationReceipt>
  retained?(manifestHash: string): KnowledgeTransport
  failed?(signal?: AbortSignal): Promise<void>
}

const CachedRelease = ActiveStore.CachedRelease
const Active = ActiveStore.Header
export type ActiveKnowledge = ActiveStore.Header & { updateError?: string }
const key = {
  active: ActiveStore.key,
  release: (cacheID: string) => ["organization-knowledge", "cache", cacheID],
  files: (cacheID: string) => ["organization-knowledge", "cache-files", cacheID],
  file: (cacheID: string, fileID: string) => ["organization-knowledge", "cache-files", cacheID, fileID],
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

async function read<T>(schema: z.ZodType<T>, address: string[]) {
  const [value] = await Storage.readMany<unknown>([address])
  return value === undefined ? undefined : schema.parse(value)
}

const contained = KnowledgeCache.contained
const privateDirectory = KnowledgeCache.privateDirectory

async function* cachedFiles(cacheID: string) {
  const prefix = key.files(cacheID)
  let after: string[] | undefined
  while (true) {
    const rows = await Storage.query({ prefix, after, limit: 100 })
    for (const row of rows) yield Publication.File.parse(row.value)
    if (rows.length < 100) break
    after = rows.at(-1)!.key
  }
}

async function verifyDirectory(directory: string, cacheID: string, release: Knowledge.Release, signal?: AbortSignal) {
  return KnowledgeCache.verify(directory, release, cachedFiles(cacheID), signal)
}

function reference(release: Knowledge.Release): Knowledge.Reference {
  return { itemID: release.itemID, version: release.version, manifestHash: release.manifestHash }
}

async function prepareRelease(input: {
  root: string
  projectID: string
  release: Knowledge.Release
  transport: KnowledgeTransport
  signal?: AbortSignal
}) {
  const { release, transport, signal } = input
  const leaf = KnowledgeCache.leaf(release)
  const cacheID = hash(
    JSON.stringify([release.orgID, input.projectID, release.itemID, release.version, release.manifestHash]),
  )
  using lock = await Lock.write(`organization-knowledge-release:${cacheID}`)
  signal?.throwIfAborted()
  const previous = await read(CachedRelease, key.release(cacheID))
  if (previous) {
    if (JSON.stringify(previous.release) !== JSON.stringify(release))
      throw new Error("Knowledge cache identity changed")
    await verifyDirectory(previous.directory, cacheID, release, signal)
    return previous
  }
  const root = await privateDirectory(input.root, path.join(input.root, "data", "organization-knowledge"))
  const stagingRoot = await privateDirectory(input.root, path.join(root, "staging"))
  const cacheRoot = await privateDirectory(input.root, path.join(root, "releases"))
  const temporary = await fs.mkdtemp(path.join(stagingRoot, "release-"))
  const staging = path.join(temporary, leaf)
  const destination = path.join(cacheRoot, cacheID, leaf)
  await fs.mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    const manifest = createHash("sha256")
    let cursor: string | undefined
    let count = 0
    let total = 0
    let lastFileID = ""
    do {
      signal?.throwIfAborted()
      const page = Publication.FilePage.parse(await transport.files(reference(release), { cursor }, signal))
      for (const file of page.items) {
        if (file.fileID !== hash(file.path) || file.fileID <= lastFileID)
          throw new Error("Knowledge file manifest order or identity changed")
        lastFileID = file.fileID
        const filename = path.resolve(staging, file.path)
        if (!contained(staging, filename)) throw new Error("Knowledge file escaped its release directory")
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
        const output = await fs.open(filename, "wx", 0o600)
        const digest = createHash("sha256")
        try {
          for (let offset = 0; offset < file.bytes;) {
            signal?.throwIfAborted()
            const size = Math.min(128 * 1024, file.bytes - offset)
            const reply = Knowledge.ContentChunk.parse(
              await transport.content(reference(release), file.fileID, offset, size, signal),
            )
            const data = Buffer.from(reply.data, "base64url")
            if (
              reply.fileID !== file.fileID ||
              reply.sha256 !== file.sha256 ||
              reply.totalBytes !== file.bytes ||
              reply.offset !== offset ||
              data.length !== size ||
              data.toString("base64url") !== reply.data
            )
              throw new Error("Knowledge download did not match its declared file range")
            digest.update(data)
            let written = 0
            while (written < data.length) {
              const result = await output.write(data.subarray(written))
              if (!result.bytesWritten) throw new Error("Knowledge staging could not complete its file write")
              written += result.bytesWritten
            }
            offset += data.length
          }
          await output.sync()
        } finally {
          await output.close()
        }
        if (digest.digest("hex") !== file.sha256) throw new Error("Knowledge download checksum failed")
        await Storage.write(key.file(cacheID, file.fileID), file)
        manifest.update(Publication.manifestLine(file))
        count++
        total += file.bytes
      }
      if (page.cursor && (page.cursor !== lastFileID || page.cursor === cursor))
        throw new Error("Knowledge manifest pagination did not advance")
      cursor = page.cursor
    } while (cursor)
    if (count !== release.fileCount || total !== release.totalBytes || manifest.digest("hex") !== release.manifestHash)
      throw new Error("Knowledge download did not complete the release manifest")
    if (release.kind === "skill") {
      const normalized = await SkillManifest.normalizeFile({
        entryFile: path.join(staging, "SKILL.md"),
        source: "synergy",
        mode: "strict",
      })
      if (
        !normalized.value ||
        normalized.diagnostics.some((entry) => entry.severity === "error") ||
        normalized.value.name !== release.skill?.name
      )
        throw new Error("Published Skill format does not match its declared manifest")
    }
    await privateDirectory(input.root, path.dirname(destination))
    try {
      await fs.rename(staging, destination)
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      ))
        throw error
      await verifyDirectory(destination, cacheID, release, signal)
    }
    const cached = CachedRelease.parse({ release, directory: destination })
    await Storage.write(key.release(cacheID), cached)
    return cached
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

export async function activeKnowledge(sessionID: string): Promise<ActiveKnowledge | undefined> {
  return read(Active, key.active(Identity.ID.parse(sessionID)))
}

export async function syncKnowledgeSelection(
  input: Parameters<typeof stageKnowledgeSelection>[0],
): Promise<ActiveKnowledge> {
  const previous = await activeKnowledge(input.sessionID)
  let next: ActiveKnowledge | undefined
  try {
    next = await stageKnowledgeSelection(input)
    await input.transport.activate?.(next.selection, input.signal)
    return next
  } catch (error) {
    input.signal?.throwIfAborted()
    if (
      !previous ||
      previous.orgID !== input.orgID ||
      previous.projectID !== input.projectID ||
      !input.transport.retained
    )
      throw error
    if (next) {
      const attempted = next
      using held = await Lock.write(`organization-knowledge-session:${input.sessionID}`)
      await Storage.transaction(async () => {
        const current = await activeKnowledge(input.sessionID)
        if (
          current?.selection.manifestHash !== attempted.selection.manifestHash ||
          current.selection.revision !== attempted.selection.revision
        )
          throw error
        await Storage.write(key.active(input.sessionID), previous)
      })
    }
    const retained = await stageKnowledgeSelection({
      ...input,
      transport: input.transport.retained(previous.selection.manifestHash),
    })
    await input.transport.failed?.(input.signal)
    return {
      ...retained,
      updateError:
        "Knowledge update failed; the previous complete version remains active. Retry the explicit update after resolving the download or storage error.",
    }
  }
}

export async function knowledgeFiles(
  active: ActiveKnowledge,
  reference: Knowledge.Reference,
  query: { cursor?: string; limit?: number } = {},
) {
  const selected = await selectedKnowledge(active, reference.itemID)
  if (
    !selected ||
    selected.release.version !== reference.version ||
    selected.release.manifestHash !== reference.manifestHash
  )
    throw new Error("Knowledge version is not selected for this Session")
  const cacheID = hash(
    JSON.stringify([active.orgID, active.projectID, reference.itemID, reference.version, reference.manifestHash]),
  )
  const prefix = key.files(cacheID)
  const rows = await Storage.query({
    prefix,
    after: query.cursor ? key.file(cacheID, query.cursor) : undefined,
    limit: (query.limit ?? 50) + 1,
  })
  const items = rows.slice(0, query.limit ?? 50).map((row) => Publication.File.parse(row.value))
  return { items, ...(rows.length > items.length ? { cursor: items.at(-1)!.fileID } : {}) }
}

export async function stageKnowledgeSelection(
  input: {
    root: string
    orgID: string
    projectID: string
    sessionID: string
    sourceSessionID?: string
    transport: KnowledgeTransport
    signal?: AbortSignal
  },
  retained?: ActiveKnowledge,
): Promise<ActiveKnowledge> {
  const expected = retained ? Active.strip().parse(structuredClone(retained)) : undefined
  using lock = await Lock.write(`organization-knowledge-session:${input.sessionID}`)
  input.signal?.throwIfAborted()
  const original = expected ? ActiveStore.releases(expected) : undefined
  let preexisting = false
  let publicationStarted = false
  let cursor: string | undefined
  let metadata: Knowledge.ExecutionPage["selection"] | undefined
  let header: ActiveStore.Header | undefined
  let previousItemID: string | undefined
  let count = 0
  const digest = createHash("sha256").update("[")
  const sameSelection = (left: Knowledge.SelectionSummary, right: Knowledge.SelectionSummary) =>
    expected
      ? left.manifestHash === right.manifestHash && left.releaseCount === right.releaseCount
      : JSON.stringify(left) === JSON.stringify(right)
  try {
    do {
      input.signal?.throwIfAborted()
      const page = Knowledge.ExecutionPage.parse(
        await input.transport.selection({ cursor, manifestHash: metadata?.manifestHash }, input.signal),
      )
      if (
        page.orgID !== input.orgID ||
        page.projectID !== input.projectID ||
        page.sessionID !== (input.sourceSessionID ?? input.sessionID)
      )
        throw new Error("Knowledge selection belongs to another organization, project or Session")
      if (metadata && !sameSelection(metadata, page.selection))
        throw new Error("Knowledge selection changed during preparation")
      metadata = page.selection
      if (!header) {
        header = Active.parse({
          schemaVersion: 2,
          orgID: input.orgID,
          projectID: input.projectID,
          sessionID: input.sessionID,
          manifestID: hash(JSON.stringify([input.orgID, input.projectID, metadata.manifestHash])),
          selection: metadata,
        })
        preexisting = await ActiveStore.sealed(header)
        if (
          expected &&
          (!preexisting ||
            header.orgID !== expected.orgID ||
            header.projectID !== expected.projectID ||
            header.sessionID !== expected.sessionID ||
            header.manifestID !== expected.manifestID ||
            header.selection.manifestHash !== expected.selection.manifestHash ||
            header.selection.releaseCount !== expected.selection.releaseCount)
        )
          throw new Error("Knowledge load no longer matches its original verified manifest")
      }
      for (const release of page.items) {
        if (
          release.orgID !== input.orgID ||
          (release.scope.kind === "project" && release.scope.projectID !== input.projectID)
        )
          throw new Error("Knowledge release ownership is inconsistent")
        const selected = reference(release)
        if (count) digest.update(",")
        digest.update(JSON.stringify(selected))
        if (original) {
          const stored = await original.next()
          if (stored.done || JSON.stringify(stored.value.release) !== JSON.stringify(release))
            throw new Error("Knowledge load changed its original immutable release")
          await verifyDirectory(
            stored.value.directory,
            KnowledgeCache.id(release, input.projectID),
            release,
            input.signal,
          )
          count++
        } else {
          const cached = await prepareRelease({ ...input, release })
          await ActiveStore.put(header, count++, cached)
        }
        previousItemID = release.itemID
      }
      if (page.cursor && (page.cursor !== previousItemID || page.cursor === cursor || !page.items.length))
        throw new Error("Knowledge selection pagination did not advance")
      cursor = page.cursor
    } while (cursor)
    if (
      !metadata ||
      !header ||
      metadata.releaseCount !== count ||
      digest.update("]").digest("hex") !== metadata.manifestHash
    )
      throw new Error("Knowledge selection manifest is incomplete")
    input.signal?.throwIfAborted()
    const confirmed = Knowledge.ExecutionPage.parse(
      await input.transport.selection({ manifestHash: metadata.manifestHash }, input.signal),
    )
    if (
      confirmed.orgID !== input.orgID ||
      confirmed.projectID !== input.projectID ||
      confirmed.sessionID !== (input.sourceSessionID ?? input.sessionID) ||
      !sameSelection(confirmed.selection, metadata)
    )
      throw new Error("Knowledge selection changed before activation")
    if (expected) {
      if (!(await original?.next())?.done)
        throw new Error("Knowledge load did not verify its complete original manifest")
      return expected
    }
    const active = header
    await ActiveStore.seal(active)
    publicationStarted = true
    return await Storage.transaction(async () => {
      const previous = await activeKnowledge(input.sessionID)
      if (
        previous &&
        (previous.orgID !== input.orgID ||
          previous.projectID !== input.projectID ||
          previous.selection.revision > active.selection.revision ||
          (previous.selection.revision === active.selection.revision &&
            previous.selection.manifestHash !== active.selection.manifestHash))
      )
        throw new Error("A stale knowledge selection cannot replace the active manifest")
      await Storage.write(key.active(input.sessionID), active)
      return active
    })
  } catch (error) {
    if (original) throw error
    const current = header ? await activeKnowledge(input.sessionID) : undefined
    if (header && publicationStarted) {
      if (
        current?.manifestID === header.manifestID &&
        current.selection.revision === header.selection.revision &&
        current.selection.manifestHash === header.selection.manifestHash
      )
        return current
    }
    if (header && !preexisting && current?.manifestID !== header.manifestID)
      await Storage.removeTree(ActiveStore.root(header))
    throw error
  } finally {
    await original?.return(undefined)
  }
}

export function selectedKnowledge(active: ActiveKnowledge, itemID: string) {
  return ActiveStore.selected(active, itemID)
}
export function knowledgePage(active: ActiveKnowledge, query?: { cursor?: string; limit?: number }) {
  return ActiveStore.page(active, query)
}

export async function knowledgeSkills(
  active: ActiveKnowledge,
): Promise<Array<{ info: Skill.Info; release: Knowledge.Release }>> {
  const result: Array<{ info: Skill.Info; release: Knowledge.Release }> = []
  for await (const selected of ActiveStore.releases(active)) {
    if (selected.release.kind !== "skill") continue
    const entryFile = path.join(selected.directory, "SKILL.md")
    const parsed = await SkillManifest.normalizeFile({ entryFile, source: "synergy", mode: "strict" })
    if (!parsed.value || parsed.diagnostics.some((item) => item.severity === "error"))
      throw new Error("An applied Skill changed or is invalid")
    const normalized = parsed.value
    const info = Skill.Info.parse({
      name: normalized.name,
      description: normalized.description,
      declaredLicense: normalized.declaredLicense,
      declaredCompatibility: normalized.declaredCompatibility,
      invocation: normalized.invocation,
      diagnostics: parsed.diagnostics,
      origin: { kind: "plugin", pluginID: `organization-${active.orgID}`, contributionID: selected.release.itemID },
      backing: { kind: "file", baseDir: selected.directory, entryFile },
    })
    result.push({ info, release: selected.release })
  }
  return result
}

export async function knowledgeSkillEntries(active: ActiveKnowledge): Promise<InstructionRegistry.Entry[]> {
  return (await knowledgeSkills(active)).map(({ info, release }) => ({
    ...skillEntry(info),
    source: "organization",
    scope: release.scope.kind,
    directory: `organization://${active.orgID}/${release.itemID}/v${release.version}`,
    provenance: { itemID: release.itemID, version: release.version, manifestHash: release.manifestHash },
  }))
}
