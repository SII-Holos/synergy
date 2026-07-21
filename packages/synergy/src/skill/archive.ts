import fs from "fs/promises"
import path from "path"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, type Entry, type FileEntry } from "@zip.js/zip.js"
import { z } from "zod"
import { ConfigMarkdown } from "../config/markdown"
import { isPathContained } from "../util/path-contain"
import { SkillManifest } from "./manifest"
import { SkillSourceProfile } from "./source-profile"
import type { Skill } from "./skill"

export namespace SkillArchive {
  export const Policy = {
    maxArchiveBytes: 20 * 1024 * 1024,
    maxRequestBytes: 21 * 1024 * 1024,
    maxEntries: 1_000,
    maxEntryBytes: 10 * 1024 * 1024,
    maxExpandedBytes: 100 * 1024 * 1024,
    maxInflationRatio: 100,
  } as const
  export type Policy = {
    maxArchiveBytes: number
    maxRequestBytes: number
    maxEntries: number
    maxEntryBytes: number
    maxExpandedBytes: number
    maxInflationRatio: number
  }

  const ErrorData = z.object({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
    limit: z.number().optional(),
    actual: z.number().optional(),
  })

  export const InvalidError = NamedError.create("SkillArchiveInvalidError", ErrorData)
  export const LimitError = NamedError.create("SkillArchiveLimitError", ErrorData)
  export const ConflictError = NamedError.create(
    "SkillArchiveConflictError",
    z.object({
      code: z.literal("skill.archive_conflict"),
      message: z.string(),
      name: z.string(),
      path: z.string(),
    }),
  )
  export const ExportNotStandardError = NamedError.create(
    "SkillExportNotStandardError",
    z.object({
      code: z.literal("skill.export_not_standard"),
      message: z.string(),
      name: z.string(),
      diagnostics: SkillManifest.Diagnostic.array(),
    }),
  )
  export const ExportUnavailableError = NamedError.create(
    "SkillExportUnavailableError",
    z.object({
      code: z.literal("skill.export_unavailable"),
      message: z.string(),
      name: z.string(),
    }),
  )
  export const NotFoundError = NamedError.create(
    "SkillExportNotFoundError",
    z.object({
      code: z.literal("skill.export_not_found"),
      message: z.string(),
      name: z.string(),
    }),
  )

  export const ImportError = z.union([InvalidError.Schema, LimitError.Schema, ConflictError.Schema])
  export const ExportError = z.union([
    ExportNotStandardError.Schema,
    ExportUnavailableError.Schema,
    NotFoundError.Schema,
  ])

  type ValidEntry = {
    entry: Entry
    archivePath: string
    relativePath: string
  }

  type ArchiveShape = {
    prefix?: string
    entries: ValidEntry[]
  }

  function invalid(code: string, message: string, filepath?: string): never {
    throw new InvalidError({ code, message, path: filepath })
  }

  function limit(code: string, message: string, value: { limit: number; actual: number; path?: string }): never {
    throw new LimitError({ code, message, ...value })
  }

  function archiveBytes(bytes: ArrayBuffer | Uint8Array) {
    if (bytes instanceof Uint8Array) return bytes
    return new Uint8Array(bytes)
  }

  function normalizedArchivePath(filename: string) {
    if (!filename || filename.includes("\0") || filename.includes("\\")) {
      invalid("skill.archive_path_invalid", "Archive entry path is invalid", filename)
    }
    if (filename.startsWith("/") || /^[a-zA-Z]:/.test(filename)) {
      invalid("skill.archive_path_invalid", "Archive entry path must be relative", filename)
    }
    const segments = filename.split("/").filter((segment) => segment !== "")
    if (segments.some((segment) => segment === "..")) {
      invalid("skill.archive_path_invalid", "Archive entry path cannot contain parent traversal", filename)
    }
    const normalized = path.posix.normalize(filename).replace(/^\.\//, "").replace(/\/$/, "")
    if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      invalid("skill.archive_path_invalid", "Archive entry path is invalid", filename)
    }
    return normalized
  }

  function assertRegularEntry(entry: Entry, archivePath: string) {
    const unixType = (entry.unixMode ?? 0) & 0o170000
    const expected = entry.directory ? 0o040000 : 0o100000
    if (unixType !== 0 && unixType !== expected) {
      invalid("skill.archive_entry_type_invalid", "Archive contains a non-regular entry", archivePath)
    }
    if (entry.extraField?.has(0x756e)) {
      invalid("skill.archive_entry_type_invalid", "Archive contains unsupported link metadata", archivePath)
    }
  }

  function validateEntries(entries: Entry[], policy: Policy): ArchiveShape {
    if (entries.length === 0) invalid("skill.archive_empty", "Archive is empty")
    if (entries.length > policy.maxEntries) {
      limit("skill.archive_entry_count_limit", "Archive contains too many entries", {
        limit: policy.maxEntries,
        actual: entries.length,
      })
    }

    const seen = new Set<string>()
    const validated: Array<{ entry: Entry; archivePath: string }> = []
    let expandedBytes = 0
    let compressedBytes = 0

    for (const entry of entries) {
      const archivePath = normalizedArchivePath(entry.filename)
      if (seen.has(archivePath)) {
        invalid("skill.archive_path_duplicate", "Archive contains duplicate normalized paths", archivePath)
      }
      seen.add(archivePath)
      assertRegularEntry(entry, archivePath)
      if (entry.encrypted)
        invalid("skill.archive_entry_type_invalid", "Encrypted archive entries are not supported", archivePath)
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        invalid("skill.archive_entry_type_invalid", "Archive entry has an invalid expanded size", archivePath)
      }
      if (!entry.directory && entry.uncompressedSize > policy.maxEntryBytes) {
        limit("skill.archive_entry_size_limit", "Archive entry exceeds the expanded size limit", {
          limit: policy.maxEntryBytes,
          actual: entry.uncompressedSize,
          path: archivePath,
        })
      }
      expandedBytes += entry.uncompressedSize
      compressedBytes += entry.compressedSize
      if (expandedBytes > policy.maxExpandedBytes) {
        limit("skill.archive_expanded_size_limit", "Archive exceeds the total expanded size limit", {
          limit: policy.maxExpandedBytes,
          actual: expandedBytes,
        })
      }
      validated.push({ entry, archivePath })
    }

    const inflationRatio = expandedBytes / Math.max(compressedBytes, 1)
    if (inflationRatio > policy.maxInflationRatio) {
      limit("skill.archive_inflation_limit", "Archive exceeds the inflation ratio limit", {
        limit: policy.maxInflationRatio,
        actual: inflationRatio,
      })
    }

    const manifestPaths = validated
      .filter(
        ({ entry, archivePath }) =>
          !entry.directory && (archivePath === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(archivePath)),
      )
      .map(({ archivePath }) => archivePath)
    if (manifestPaths.length === 0) {
      invalid("skill.archive_manifest_missing", "Archive must contain a canonical SKILL.md")
    }
    if (manifestPaths.length > 1) {
      invalid("skill.archive_multiple_roots", "Archive contains multiple Skill roots")
    }

    const manifestPath = manifestPaths[0]!
    const prefix = manifestPath === "SKILL.md" ? undefined : manifestPath.split("/")[0]!
    const shaped = validated.map(({ entry, archivePath }): ValidEntry => {
      if (!prefix) return { entry, archivePath, relativePath: archivePath }
      if (archivePath !== prefix && !archivePath.startsWith(`${prefix}/`)) {
        invalid("skill.archive_multiple_roots", "Archive contains entries outside its single Skill root", archivePath)
      }
      return {
        entry,
        archivePath,
        relativePath: archivePath === prefix ? "" : archivePath.slice(prefix.length + 1),
      }
    })
    return { prefix, entries: shaped }
  }

  async function extractFile(input: {
    entry: FileEntry
    target: string
    archivePath: string
    policy: Policy
    expanded: { total: number }
  }) {
    await fs.mkdir(path.dirname(input.target), { recursive: true })
    const file = await fs.open(input.target, "wx")
    let entryBytes = 0
    try {
      await input.entry.getData(
        new WritableStream<Uint8Array>({
          write: async (chunk) => {
            entryBytes += chunk.byteLength
            input.expanded.total += chunk.byteLength
            if (entryBytes > input.policy.maxEntryBytes) {
              limit(
                "skill.archive_entry_size_limit",
                "Archive entry exceeds the expanded size limit while extracting",
                {
                  limit: input.policy.maxEntryBytes,
                  actual: entryBytes,
                  path: input.archivePath,
                },
              )
            }
            if (input.expanded.total > input.policy.maxExpandedBytes) {
              limit(
                "skill.archive_expanded_size_limit",
                "Archive exceeds the total expanded size limit while extracting",
                {
                  limit: input.policy.maxExpandedBytes,
                  actual: input.expanded.total,
                },
              )
            }
            await file.write(chunk)
          },
        }),
      )
      if (entryBytes !== input.entry.uncompressedSize) {
        invalid(
          "skill.archive_entry_size_mismatch",
          "Archive entry expanded size does not match its declaration",
          input.archivePath,
        )
      }
    } finally {
      await file.close()
    }
  }

  async function extract(shape: ArchiveShape, staging: string, policy: Policy) {
    const root = path.join(staging, shape.prefix ?? "payload")
    await fs.mkdir(root, { recursive: true })
    const expanded = { total: 0 }
    for (const item of shape.entries) {
      if (!item.relativePath) continue
      const target = path.resolve(root, item.relativePath)
      if (!isPathContained(root, target) || target === root) {
        invalid("skill.archive_path_escape", "Archive entry escapes the staging directory", item.archivePath)
      }
      if (item.entry.directory) {
        await fs.mkdir(target, { recursive: true })
        continue
      }
      await extractFile({ entry: item.entry, target, archivePath: item.archivePath, policy, expanded })
    }
    return root
  }

  async function strictName(entryFile: string) {
    try {
      const document = await ConfigMarkdown.parse(entryFile)
      return SkillManifest.Schema.parse(document.data).name
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new InvalidError({
        code: "skill.archive_not_standard",
        message: `Skill manifest is not strict-standard: ${message}`,
        path: entryFile,
      })
    }
  }

  async function validateStrict(root: string, expectedName?: string) {
    const entryFile = path.join(root, "SKILL.md")
    const normalized = await SkillManifest.normalizeFile({ entryFile, source: "synergy", mode: "strict" })
    if (
      !normalized.value ||
      normalized.diagnostics.length > 0 ||
      (expectedName && normalized.value.name !== expectedName)
    ) {
      throw new InvalidError({
        code: "skill.archive_not_standard",
        message: normalized.diagnostics[0]?.message ?? "Skill manifest is not strict-standard",
        path: entryFile,
      })
    }
    return normalized.value
  }

  export async function install(input: {
    bytes: ArrayBuffer | Uint8Array
    destination: string
    policy?: Policy
  }): Promise<{ name: string; directory: string }> {
    const policy = input.policy ?? Policy
    const bytes = archiveBytes(input.bytes)
    if (bytes.byteLength > policy.maxArchiveBytes) {
      limit("skill.archive_size_limit", "Skill archive exceeds the compressed size limit", {
        limit: policy.maxArchiveBytes,
        actual: bytes.byteLength,
      })
    }

    await fs.mkdir(input.destination, { recursive: true })
    const staging = await fs.mkdtemp(path.join(path.dirname(input.destination), ".skill-import-"))
    let reader: ZipReader<Uint8Array> | undefined
    let lock: string | undefined
    try {
      reader = new ZipReader(new Uint8ArrayReader(bytes), {
        useWebWorkers: false,
        checkOverlappingEntry: true,
      })
      let entries: Entry[]
      try {
        entries = await reader.getEntries()
      } catch (error) {
        invalid("skill.archive_invalid_zip", error instanceof Error ? error.message : "Invalid ZIP archive")
      }
      const shape = validateEntries(entries!, policy)
      let stagedRoot = await extract(shape, staging, policy)
      const parsedName = await strictName(path.join(stagedRoot, "SKILL.md"))
      if (!shape.prefix) {
        const namedRoot = path.join(staging, parsedName)
        await fs.rename(stagedRoot, namedRoot)
        stagedRoot = namedRoot
      }
      const normalized = await validateStrict(stagedRoot, parsedName)
      const target = path.join(input.destination, normalized.name)
      const lockPath = path.join(input.destination, `.${normalized.name}.skill-install.lock`)
      try {
        await fs.mkdir(lockPath)
        lock = lockPath
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConflictError({
            code: "skill.archive_conflict",
            message: `Skill '${normalized.name}' is already being installed`,
            name: normalized.name,
            path: target,
          })
        }
        throw error
      }
      if (
        await fs
          .stat(target)
          .then(() => true)
          .catch(() => false)
      ) {
        throw new ConflictError({
          code: "skill.archive_conflict",
          message: `Skill '${normalized.name}' already exists`,
          name: normalized.name,
          path: target,
        })
      }
      try {
        await fs.rename(stagedRoot, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST" || code === "ENOTEMPTY") {
          throw new ConflictError({
            code: "skill.archive_conflict",
            message: `Skill '${normalized.name}' already exists`,
            name: normalized.name,
            path: target,
          })
        }
        throw error
      }
      return { name: normalized.name, directory: target }
    } catch (error) {
      if (error instanceof InvalidError || error instanceof LimitError || error instanceof ConflictError) {
        throw error
      }
      throw new InvalidError({
        code: "skill.archive_invalid_zip",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (reader) await reader.close().catch(() => {})
      if (lock) await fs.rm(lock, { recursive: true, force: true }).catch(() => {})
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function trustedFileBacking(skill: Skill.Info, instanceDirectory: string) {
    if (skill.backing.kind !== "file") return false
    const baseDir = path.resolve(skill.backing.baseDir)
    const entryFile = path.resolve(skill.backing.entryFile)
    if (entryFile !== path.join(baseDir, "SKILL.md")) return false
    const [realBase, realEntry] = await Promise.all([
      fs.realpath(baseDir).catch(() => undefined),
      fs.realpath(entryFile).catch(() => undefined),
    ])
    if (!realBase || !realEntry || !isPathContained(realBase, realEntry)) return false
    return SkillSourceProfile.containsCanonicalPath(realBase, instanceDirectory)
  }

  async function strictExportValidation(skill: Skill.Info, instanceDirectory: string) {
    if (!(await trustedFileBacking(skill, instanceDirectory))) {
      throw new ExportUnavailableError({
        code: "skill.export_unavailable",
        message: `Skill '${skill.name}' is not file-backed within a trusted Skill root`,
        name: skill.name,
      })
    }
    const entryFile = skill.backing.kind === "file" ? skill.backing.entryFile : ""
    const normalized = await SkillManifest.normalizeFile({ entryFile, source: "synergy", mode: "strict" })
    if (!normalized.value || normalized.value.name !== skill.name || normalized.diagnostics.length > 0) {
      throw new ExportNotStandardError({
        code: "skill.export_not_standard",
        message: `Skill '${skill.name}' does not satisfy the strict Skill standard`,
        name: skill.name,
        diagnostics: normalized.diagnostics,
      })
    }
    return skill.backing.kind === "file" ? skill.backing.baseDir : ""
  }

  export async function exportable(skill: Skill.Info, instanceDirectory: string) {
    try {
      await strictExportValidation(skill, instanceDirectory)
      return true
    } catch {
      return false
    }
  }

  async function tree(root: string) {
    const result: Array<{ relative: string; directory: boolean }> = []
    async function visit(directory: string, relative: string) {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name
        const absolute = path.join(directory, entry.name)
        const stat = await fs.lstat(absolute)
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
          throw new ExportNotStandardError({
            code: "skill.export_not_standard",
            message: `Skill contains a non-regular path: ${childRelative}`,
            name: path.basename(root),
            diagnostics: [],
          })
        }
        result.push({ relative: childRelative, directory: stat.isDirectory() })
        if (stat.isDirectory()) await visit(absolute, childRelative)
      }
    }
    await visit(root, "")
    return result
  }

  export async function createExport(input: {
    skill: Skill.Info
    instanceDirectory: string
  }): Promise<{ bytes: Uint8Array }> {
    const baseDir = await strictExportValidation(input.skill, input.instanceDirectory)
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
    const prefix = `${input.skill.name}/`
    await writer.add(prefix, undefined, { directory: true })
    for (const item of await tree(baseDir)) {
      const archivePath = `${prefix}${item.relative}${item.directory ? "/" : ""}`
      if (item.directory) {
        await writer.add(archivePath, undefined, { directory: true })
        continue
      }
      await writer.add(archivePath, new Uint8ArrayReader(await Bun.file(path.join(baseDir, item.relative)).bytes()))
    }
    return { bytes: await writer.close() }
  }
}
