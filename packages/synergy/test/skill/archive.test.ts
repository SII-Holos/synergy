import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  type ZipWriterAddDataOptions,
} from "@zip.js/zip.js"
import { SkillArchive } from "../../src/skill/archive"
import { tmpdir } from "../fixture/fixture"

const standardManifest = (name: string, extra = "") => `---
name: ${name}
description: ${name} description.
${extra}---

# ${name}
`

type ArchiveEntry = {
  name: string
  content?: string | Uint8Array
  options?: ZipWriterAddDataOptions
}

async function archive(entries: readonly ArchiveEntry[]) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const entry of entries) {
    const content = entry.content ?? ""
    await writer.add(
      entry.name,
      typeof content === "string" ? new TextReader(content) : new Uint8ArrayReader(content),
      entry.options,
    )
  }
  return writer.close()
}

function patchAsiExtraField(bytes: Uint8Array) {
  const patched = bytes.slice()
  for (let offset = 0; offset <= patched.length - 8; offset++) {
    if (patched[offset] !== 0x6e || patched[offset + 1] !== 0 || patched[offset + 2] !== 4 || patched[offset + 3] !== 0)
      continue
    patched[offset + 1] = 0x75
  }
  return patched
}

async function names(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    return (await reader.getEntries()).map((entry) => entry.filename)
  } finally {
    await reader.close()
  }
}

async function stagingEntries(destination: string) {
  const roots = [destination, path.dirname(destination)]
  const entries = await Promise.all(roots.map((root) => fs.readdir(root).catch(() => [])))
  return entries.flat().filter((entry) => entry.startsWith(".skill-import-"))
}

describe("skill archive", () => {
  test.each([
    {
      label: "root manifest",
      entries: [
        { name: "SKILL.md", content: standardManifest("root-skill") },
        { name: "references/guide.txt", content: "root bytes\n" },
      ],
      name: "root-skill",
    },
    {
      label: "single top-level directory",
      entries: [
        { name: "nested-skill/SKILL.md", content: standardManifest("nested-skill") },
        { name: "nested-skill/assets/data.bin", content: new Uint8Array([0, 1, 2, 255]) },
      ],
      name: "nested-skill",
    },
  ])("imports $label transactionally", async ({ entries, name }) => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "skills")
    const result = await SkillArchive.install({ bytes: await archive(entries), destination })

    expect(result).toEqual({ name, directory: path.join(destination, name) })
    expect(await Bun.file(path.join(destination, name, "SKILL.md")).exists()).toBe(true)
    expect((await stagingEntries(destination)).filter((entry) => entry.startsWith(".skill-import-"))).toEqual([])
  })

  test.each([
    { label: "empty archive", entries: [], code: "skill.archive_empty" },
    {
      label: "missing canonical manifest",
      entries: [{ name: "skill/Skill.md", content: standardManifest("skill") }],
      code: "skill.archive_manifest_missing",
    },
    {
      label: "multiple roots",
      entries: [
        { name: "one/SKILL.md", content: standardManifest("one") },
        { name: "two/SKILL.md", content: standardManifest("two") },
      ],
      code: "skill.archive_multiple_roots",
    },
    {
      label: "absolute path",
      entries: [
        { name: "/absolute.txt", content: "escape" },
        { name: "SKILL.md", content: standardManifest("absolute-skill") },
      ],
      code: "skill.archive_path_invalid",
    },
    {
      label: "parent traversal",
      entries: [
        { name: "../escape.txt", content: "escape" },
        { name: "SKILL.md", content: standardManifest("traversal-skill") },
      ],
      code: "skill.archive_path_invalid",
    },
    {
      label: "normalized duplicate",
      entries: [
        { name: "SKILL.md", content: standardManifest("duplicate-skill") },
        { name: "references/./guide.txt", content: "one" },
        { name: "references/guide.txt", content: "two" },
      ],
      code: "skill.archive_path_duplicate",
    },
    {
      label: "symlink",
      entries: [
        { name: "SKILL.md", content: standardManifest("symlink-skill") },
        {
          name: "link",
          content: "target",
          options: { externalFileAttributes: (0o120777 << 16) >>> 0 },
        },
      ],
      code: "skill.archive_entry_type_invalid",
    },
    {
      label: "non-regular unix entry",
      entries: [
        { name: "SKILL.md", content: standardManifest("special-skill") },
        {
          name: "device",
          content: "device",
          options: { externalFileAttributes: (0o060644 << 16) >>> 0 },
        },
      ],
      code: "skill.archive_entry_type_invalid",
    },
    {
      label: "strict manifest failure",
      entries: [{ name: "SKILL.md", content: standardManifest("Bad Name") }],
      code: "skill.archive_not_standard",
    },
  ])("rejects $label and cleans staging", async ({ entries, code }) => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "skills")

    await expect(SkillArchive.install({ bytes: await archive(entries), destination })).rejects.toMatchObject({
      data: { code },
    })
    expect((await stagingEntries(destination)).filter((entry) => entry.startsWith(".skill-import-"))).toEqual([])
  })

  test("rejects ASi hardlink metadata and cleans staging", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "skills")
    const bytes = await archive([
      { name: "SKILL.md", content: standardManifest("hardlink-skill") },
      {
        name: "hardlink",
        content: "target",
        options: { extraField: new Map([[0x006e, new Uint8Array([0, 0, 0, 0])]]) },
      },
    ])

    await expect(SkillArchive.install({ bytes: patchAsiExtraField(bytes), destination })).rejects.toMatchObject({
      data: { code: "skill.archive_entry_type_invalid" },
    })
    expect((await stagingEntries(destination)).filter((entry) => entry.startsWith(".skill-import-"))).toEqual([])
  })

  test.each([
    {
      label: "archive bytes",
      policy: { maxArchiveBytes: 32 },
      entries: [{ name: "SKILL.md", content: standardManifest("archive-limit") }],
      code: "skill.archive_size_limit",
    },
    {
      label: "entry count",
      policy: { maxEntries: 1 },
      entries: [
        { name: "SKILL.md", content: standardManifest("count-limit") },
        { name: "guide.txt", content: "guide" },
      ],
      code: "skill.archive_entry_count_limit",
    },
    {
      label: "per-file expanded bytes",
      policy: { maxEntryBytes: 8 },
      entries: [{ name: "SKILL.md", content: standardManifest("file-limit") }],
      code: "skill.archive_entry_size_limit",
    },
    {
      label: "total expanded bytes",
      policy: { maxExpandedBytes: 32 },
      entries: [{ name: "SKILL.md", content: standardManifest("expanded-limit") }],
      code: "skill.archive_expanded_size_limit",
    },
    {
      label: "inflation ratio",
      policy: { maxInflationRatio: 1 },
      entries: [{ name: "SKILL.md", content: standardManifest("ratio-limit") + "x".repeat(1_000) }],
      code: "skill.archive_inflation_limit",
    },
  ])("enforces the centralized $label policy", async ({ policy, entries, code }) => {
    await using tmp = await tmpdir()
    await expect(
      SkillArchive.install({
        bytes: await archive(entries),
        destination: path.join(tmp.path, "skills"),
        policy: { ...SkillArchive.Policy, ...policy },
      }),
    ).rejects.toMatchObject({ data: { code } })
  })

  test("returns a structured conflict without changing the existing target", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "skills")
    const target = path.join(destination, "conflict-skill")
    await Bun.write(path.join(target, "existing.txt"), "keep")

    await expect(
      SkillArchive.install({
        bytes: await archive([{ name: "SKILL.md", content: standardManifest("conflict-skill") }]),
        destination,
      }),
    ).rejects.toBeInstanceOf(SkillArchive.ConflictError)
    expect(await Bun.file(path.join(target, "existing.txt")).text()).toBe("keep")
    expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false)
    expect(await stagingEntries(destination)).toEqual([])
  })

  test("preserves an install lock owned by another importer", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "skills")
    const lock = path.join(destination, ".locked-skill.skill-install.lock")
    await fs.mkdir(lock, { recursive: true })

    await expect(
      SkillArchive.install({
        bytes: await archive([{ name: "SKILL.md", content: standardManifest("locked-skill") }]),
        destination,
      }),
    ).rejects.toBeInstanceOf(SkillArchive.ConflictError)
    expect((await fs.stat(lock)).isDirectory()).toBe(true)
    expect(await Bun.file(path.join(destination, "locked-skill", "SKILL.md")).exists()).toBe(false)
    expect(await stagingEntries(destination)).toEqual([])
  })

  test("exports strict file-backed skills unchanged under one top-level directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const baseDir = path.join(tmp.path, ".synergy", "skill", "export-skill")
    const manifest = standardManifest("export-skill", "compatibility: Requires git.\n")
    const asset = new Uint8Array([0, 255, 4, 9])
    await Bun.write(path.join(baseDir, "SKILL.md"), manifest)
    await Bun.write(path.join(baseDir, "assets", "data.bin"), asset)

    const result = await SkillArchive.createExport({
      skill: {
        name: "export-skill",
        description: "export-skill description.",
        declaredCompatibility: "Requires git.",
        invocation: { user: true, model: true },
        origin: { kind: "filesystem", source: "synergy", scope: "project" },
        backing: { kind: "file", baseDir, entryFile: path.join(baseDir, "SKILL.md") },
        diagnostics: [],
      },
      instanceDirectory: tmp.path,
    })

    expect(await names(result.bytes)).toEqual([
      "export-skill/",
      "export-skill/assets/",
      "export-skill/assets/data.bin",
      "export-skill/SKILL.md",
    ])

    const destination = path.join(tmp.path, "roundtrip")
    await SkillArchive.install({ bytes: result.bytes, destination })
    expect(await Bun.file(path.join(destination, "export-skill", "SKILL.md")).text()).toBe(manifest)
    expect(await Bun.file(path.join(destination, "export-skill", "assets", "data.bin")).bytes()).toEqual(asset)
  })

  test.each([
    {
      label: "lenient-only vendor skill",
      expected: SkillArchive.ExportNotStandardError,
      skill: (baseDir: string) => ({
        name: "vendor-skill",
        description: "Vendor skill.",
        invocation: { user: true, model: true },
        origin: { kind: "filesystem" as const, source: "claude" as const, scope: "project" as const },
        backing: { kind: "file" as const, baseDir, entryFile: path.join(baseDir, "SKILL.md") },
        diagnostics: [],
      }),
      manifest: standardManifest("vendor-skill", "vendor-only: true\n"),
    },
    {
      label: "memory builtin",
      expected: SkillArchive.ExportUnavailableError,
      skill: () => ({
        name: "memory-skill",
        description: "Memory skill.",
        invocation: { user: true, model: true },
        origin: { kind: "builtin" as const },
        backing: { kind: "memory" as const, content: "# Memory" },
        diagnostics: [],
      }),
      manifest: undefined,
    },
  ])("rejects export for $label", async ({ skill, manifest, expected }) => {
    await using tmp = await tmpdir({ git: true })
    const baseDir = path.join(tmp.path, ".claude", "skills", "vendor-skill")
    if (manifest) await Bun.write(path.join(baseDir, "SKILL.md"), manifest)

    await expect(
      SkillArchive.createExport({ skill: skill(baseDir), instanceDirectory: tmp.path }),
    ).rejects.toBeInstanceOf(expected)
  })

  test("exports a strict-valid vendor skill without rewriting vendor bytes", async () => {
    await using tmp = await tmpdir({ git: true })
    const baseDir = path.join(tmp.path, ".claude", "skills", "vendor-standard")
    const manifest = standardManifest("vendor-standard")
    await Bun.write(path.join(baseDir, "SKILL.md"), manifest)

    const result = await SkillArchive.createExport({
      skill: {
        name: "vendor-standard",
        description: "vendor-standard description.",
        invocation: { user: true, model: true },
        origin: { kind: "filesystem", source: "claude", scope: "project" },
        backing: { kind: "file", baseDir, entryFile: path.join(baseDir, "SKILL.md") },
        diagnostics: [],
      },
      instanceDirectory: tmp.path,
    })
    const destination = path.join(tmp.path, "vendor-roundtrip")
    await SkillArchive.install({ bytes: result.bytes, destination })
    expect(await Bun.file(path.join(destination, "vendor-standard", "SKILL.md")).text()).toBe(manifest)
  })
})
