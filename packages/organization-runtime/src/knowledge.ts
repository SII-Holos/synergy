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
}

const CachedRelease = z.strictObject({ release: Knowledge.Release, directory: z.string() })
const Active = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  projectID: Identity.ID,
  sessionID: Identity.ID,
  selection: Knowledge.Selection,
  releases: z.array(CachedRelease),
})
export type ActiveKnowledge = z.infer<typeof Active>
const key = {
  active: (sessionID: string) => ["organization-knowledge", "active", sessionID],
  release: (cacheID: string) => ["organization-knowledge", "cache", cacheID],
  files: (cacheID: string) => ["organization-knowledge", "cache-files", cacheID],
  file: (cacheID: string, fileID: string) => ["organization-knowledge", "cache-files", cacheID, fileID],
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

async function read<T>(schema: z.ZodType<T>, address: string[]) {
  const [value] = await Storage.readMany<unknown>([address])
  return value === undefined ? undefined : schema.parse(value)
}

function contained(directory: string, candidate: string) {
  const relative = path.relative(directory, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function privateDirectory(root: string, directory: string) {
  const canonicalRoot = await fs.realpath(root)
  const expected = contained(path.resolve(root), path.resolve(directory))
    ? path.resolve(canonicalRoot, path.relative(root, directory))
    : path.resolve(directory)
  if (!contained(canonicalRoot, expected)) throw new Error("Knowledge cache cannot use an external directory")
  let current = canonicalRoot
  for (const segment of path.relative(canonicalRoot, expected).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Knowledge cache cannot use a symbolic-link directory")
  }
  return expected
}

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
  const manifest = createHash("sha256")
  let count = 0
  let bytes = 0
  for await (const file of cachedFiles(cacheID)) {
    signal?.throwIfAborted()
    const filename = path.resolve(directory, Publication.Path.parse(file.path))
    const stat = await fs.lstat(filename)
    const canonical = await fs.realpath(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || !contained(directory, canonical) || stat.size !== file.bytes)
      throw new Error("A cached knowledge file changed; preserve local edits before retrying")
    const digest = createHash("sha256")
    for await (const part of Bun.file(canonical).stream()) {
      signal?.throwIfAborted()
      digest.update(part)
    }
    if (digest.digest("hex") !== file.sha256)
      throw new Error("A cached knowledge file changed; preserve local edits before retrying")
    manifest.update(Publication.manifestLine(file))
    count++
    bytes += file.bytes
  }
  let physicalCount = 0
  async function visit(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) throw new Error("Knowledge releases cannot contain symbolic links")
      if (entry.isDirectory()) await visit(path.join(current, entry.name))
      else if (entry.isFile()) physicalCount++
      else throw new Error("Knowledge releases can only contain regular files")
    }
  }
  await visit(directory)
  if (
    count !== release.fileCount ||
    physicalCount !== count ||
    bytes !== release.totalBytes ||
    manifest.digest("hex") !== release.manifestHash
  )
    throw new Error("Knowledge release manifest is incomplete or changed")
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
  const leaf = release.kind === "skill" ? release.skill?.name : "material"
  if (!leaf) throw new Error("Published Skill metadata is missing")
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

export async function knowledgeFiles(
  active: ActiveKnowledge,
  reference: Knowledge.Reference,
  query: { cursor?: string; limit?: number } = {},
) {
  const selected = active.releases.find(
    ({ release }) =>
      release.itemID === reference.itemID &&
      release.version === reference.version &&
      release.manifestHash === reference.manifestHash,
  )
  if (!selected) throw new Error("Knowledge version is not selected for this Session")
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

export async function stageKnowledgeSelection(input: {
  root: string
  orgID: string
  projectID: string
  sessionID: string
  sourceSessionID?: string
  transport: KnowledgeTransport
  signal?: AbortSignal
}): Promise<ActiveKnowledge> {
  using lock = await Lock.write(`organization-knowledge-session:${input.sessionID}`)
  input.signal?.throwIfAborted()
  const releases: Knowledge.Release[] = []
  let cursor: string | undefined
  let metadata: Knowledge.ExecutionPage["selection"] | undefined
  let previousItemID = ""
  do {
    const page = Knowledge.ExecutionPage.parse(
      await input.transport.selection({ cursor, manifestHash: metadata?.manifestHash }, input.signal),
    )
    if (
      page.orgID !== input.orgID ||
      page.projectID !== input.projectID ||
      page.sessionID !== (input.sourceSessionID ?? input.sessionID)
    )
      throw new Error("Knowledge selection belongs to another organization, project or Session")
    if (metadata && JSON.stringify(metadata) !== JSON.stringify(page.selection))
      throw new Error("Knowledge selection changed during preparation")
    metadata = page.selection
    for (const release of page.items) {
      if (
        release.orgID !== input.orgID ||
        (release.scope.kind === "project" && release.scope.projectID !== input.projectID) ||
        release.itemID <= previousItemID
      )
        throw new Error("Knowledge release ownership or ordering is inconsistent")
      previousItemID = release.itemID
      releases.push(release)
    }
    if (page.cursor && (page.cursor !== previousItemID || page.cursor === cursor))
      throw new Error("Knowledge selection pagination did not advance")
    cursor = page.cursor
  } while (cursor)
  if (
    !metadata ||
    metadata.releaseCount !== releases.length ||
    hash(JSON.stringify(releases.map(reference))) !== metadata.manifestHash
  )
    throw new Error("Knowledge selection manifest is incomplete")
  const { releaseCount: _, ...selection } = metadata
  const prepared: z.infer<typeof CachedRelease>[] = []
  for (const release of releases) prepared.push(await prepareRelease({ ...input, release }))
  input.signal?.throwIfAborted()
  const confirmed = Knowledge.ExecutionPage.parse(
    await input.transport.selection({ manifestHash: metadata.manifestHash }, input.signal),
  )
  if (
    confirmed.orgID !== input.orgID ||
    confirmed.projectID !== input.projectID ||
    confirmed.sessionID !== (input.sourceSessionID ?? input.sessionID) ||
    JSON.stringify(confirmed.selection) !== JSON.stringify(metadata)
  )
    throw new Error("Knowledge selection changed before activation")
  return await Storage.transaction(async () => {
    const previous = await activeKnowledge(input.sessionID)
    if (
      previous &&
      (previous.orgID !== input.orgID ||
        previous.projectID !== input.projectID ||
        previous.selection.revision > selection.revision ||
        (previous.selection.revision === selection.revision &&
          previous.selection.manifestHash !== selection.manifestHash))
    )
      throw new Error("A stale knowledge selection cannot replace the active manifest")
    const active = Active.parse({
      schemaVersion: 1,
      orgID: input.orgID,
      projectID: input.projectID,
      sessionID: input.sessionID,
      selection: { ...selection, releases: releases.map(reference) },
      releases: prepared,
    })
    await Storage.write(key.active(input.sessionID), active)
    return active
  })
}

export async function knowledgeSkills(
  active: ActiveKnowledge,
): Promise<Array<{ info: Skill.Info; release: Knowledge.Release }>> {
  const result: Array<{ info: Skill.Info; release: Knowledge.Release }> = []
  for (const selected of active.releases) {
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
