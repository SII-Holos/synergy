import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import ts from "typescript"
import { extractFromFile, writePo } from "./i18n-extract"

function source(text: string, fileName = "/tmp/example.tsx") {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

describe("runtime descriptor extraction", () => {
  test("extracts literal and locally resolvable static descriptors", () => {
    const result = extractFromFile(
      source(`
        const ID = "settings.general.language.label"
        const copy = { message: "Language" }
        const descriptor = {
          id: ID,
          message: copy.message,
        }
      `),
    )

    expect(result.errors).toEqual([])
    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "settings.general.language.label",
        message: "Language",
      }),
    ])
  })

  test("extracts both branches when a factory returns static descriptors", () => {
    const result = extractFromFile(
      source(`
        function stateLabel(active: boolean) {
          return active
            ? { id: "session.state.active", message: "Active" }
            : { id: "session.state.pending", message: "Pending" }
        }
      `),
    )

    expect(result.errors).toEqual([])
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(["session.state.active", "session.state.pending"])
  })

  test("accepts imported static descriptor references at translation sites", () => {
    const result = extractFromFile(
      source(`
        import { workspace as W } from "./messages"
        const text = i18n._({ id: W.empty.id, message: W.empty.message })
      `),
    )

    expect(result.errors).toEqual([])
    expect(result.entries).toEqual([])
  })

  test("ignores unrelated data objects with id and message fields", () => {
    const result = extractFromFile(
      source(`
        function transport(id: string, message: string) {
          return { id, message, timestamp: Date.now() }
        }
      `),
    )

    expect(result.errors).toEqual([])
    expect(result.entries).toEqual([])
  })

  test("rejects dynamic descriptors passed to translation", () => {
    const result = extractFromFile(
      source(`
        function label(id: string, message: string) {
          return i18n._({ id, message })
        }
      `),
    )

    expect(result.errors.map((error) => error.message)).toEqual([
      "ID must resolve to a static string",
      "Message must resolve to a static string",
    ])
  })

  test("rejects descriptor-shaped objects with static IDs and dynamic messages", () => {
    const result = extractFromFile(
      source(`
        function archiveConfirm(name: string) {
          return {
            id: "confirm.archive.description",
            message: \`Archive \${name}?\`,
            values: { name },
          }
        }
      `),
    )

    expect(result.entries).toEqual([])
    expect(result.errors.map((error) => error.message)).toEqual(["Message must resolve to a static string"])
  })

  test("preserves comments and line locations", () => {
    const result = extractFromFile(
      source(`
        /** Translator: language selector label. */
        const descriptor = {
          id: "settings.general.language.label",
          message: "Language",
        }
      `),
    )

    expect(result.entries[0]).toMatchObject({
      line: 3,
      translatorComment: "Translator: language selector label.",
    })
  })

  test("deduplicates matching IDs and rejects conflicting defaults", () => {
    const matching = extractAllFromSources([
      ["/tmp/a.ts", `const a = { id: "shared.action.close", message: "Close" }`],
      ["/tmp/b.ts", `const b = { id: "shared.action.close", message: "Close" }`],
    ])
    expect(matching.errors).toEqual([])

    const conflicting = extractAllFromSources([
      ["/tmp/a.ts", `const a = { id: "shared.action.close", message: "Close" }`],
      ["/tmp/b.ts", `const b = { id: "shared.action.close", message: "Dismiss" }`],
    ])
    expect(conflicting.errors).toHaveLength(1)
    expect(conflicting.errors[0]?.message).toContain('Duplicate ID "shared.action.close"')
  })
})

test("writes catalogs with exactly one trailing newline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-i18n-extract-"))
  try {
    writePo(root, "en", new Map([["shared.action.close", { id: "shared.action.close", message: "Close" }]]), new Map())
    const catalog = await readFile(path.join(root, "en", "messages.po"), "utf8")
    expect(catalog.endsWith("\n")).toBe(true)
    expect(catalog.endsWith("\n\n")).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("preserves escaped translations across repeated catalog writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-i18n-extract-"))
  const locale = "zh-CN"
  const id = "shared.path.open"
  const translation = '打开 "C:\\tmp"\n下一行'
  const encodedTranslation = JSON.stringify(translation).slice(1, -1)

  try {
    await mkdir(path.join(root, locale), { recursive: true })
    await writeFile(
      path.join(root, locale, "messages.po"),
      `msgid ""\nmsgstr ""\n\nmsgid "${id}"\nmsgstr "${encodedTranslation}"\n`,
    )

    const entries = new Map([[id, { id, message: "Open path" }]])
    writePo(root, locale, entries, new Map())
    const firstWrite = await readFile(path.join(root, locale, "messages.po"), "utf8")
    writePo(root, locale, entries, new Map())
    const secondWrite = await readFile(path.join(root, locale, "messages.po"), "utf8")

    expect(firstWrite).toContain(`msgstr "${encodedTranslation}"`)
    expect(secondWrite).toBe(firstWrite)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
function extractAllFromSources(entries: Array<[string, string]>) {
  const sourceFiles = entries.map(([fileName, text]) => source(text, fileName))
  const extracted = sourceFiles.map(extractFromFile)
  const errors = extracted.flatMap((result) => result.errors)
  const descriptors = extracted.flatMap((result) => result.entries)

  const seen = new Map<string, (typeof descriptors)[number]>()
  for (const descriptor of descriptors) {
    const previous = seen.get(descriptor.id)
    if (previous && previous.message !== descriptor.message) {
      errors.push({
        file: descriptor.file,
        line: descriptor.line,
        message: `Duplicate ID "${descriptor.id}" — "${previous.message}" vs "${descriptor.message}"`,
      })
    } else if (!previous) {
      seen.set(descriptor.id, descriptor)
    }
  }

  return { entries: descriptors, errors }
}
