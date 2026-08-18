import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generate as generateCli, parseCommandBlocks } from "../../script/gen/gen-cli-reference"
import { generate as generateConfig, parseDefCall } from "../../script/gen/gen-config-reference"
import { generate as generateTools, parseTaxonomy } from "../../script/gen/gen-tool-catalog"
import { findBlock, isFresh, matchClose, stringLiteral, templateLiteral } from "../../script/gen/shared"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-gen-catalogs-"))
  roots.push(root)
  return root
}

describe("catalog determinism", () => {
  test("cli catalog is byte-stable across runs", async () => {
    const first = await generateCli()
    const second = await generateCli()
    expect(second).toBe(first)
  })

  test("config catalog is byte-stable across runs", async () => {
    const first = await generateConfig()
    const second = await generateConfig()
    expect(second).toBe(first)
  })

  test("tools catalog is byte-stable across runs", async () => {
    const first = await generateTools()
    const second = await generateTools()
    expect(second).toBe(first)
  })
})

describe("generated catalog completeness", () => {
  test("cli catalog lists top-level commands with option tables", async () => {
    const body = await generateCli()
    expect(body).toContain("## Commands")
    expect(body).toContain("| `config` |")
    expect(body).toContain("| `session` |")
    // Real command modules carry yargs .option() calls; the generator must
    // surface them as option tables rather than an empty options column.
    expect(body).toContain("| Option | Description |")
    expect(body).toContain("| `--cwd`")
  })

  test("config catalog lists every config domain", async () => {
    const body = await generateConfig()
    for (const domain of [
      "general",
      "models",
      "providers",
      "library",
      "mcp",
      "plugins",
      "agents",
      "commands",
      "permissions",
      "channels",
      "holos",
      "email",
      "runtime",
    ]) {
      expect(body).toContain(`| \`${domain}\` |`)
    }
    expect(body).toContain("| `00-general.jsonc` |")
  })

  test("tools catalog carries kind and description for builtin tools", async () => {
    const body = await generateTools()
    expect(body).toContain("| Tool | Kind | Description |")
    expect(body).toContain("## bash")
    expect(body).toContain("Kind: `code.execute`")
    expect(body).toContain("## worktree_list")
    expect(body).toContain("List all git worktrees")
  })
})

describe("parser behavior", () => {
  test("parseCommandBlocks extracts describe and options from cmd blocks", () => {
    const source = `export const FooCommand = cmd({
  command: "foo",
  describe: "do a foo",
  builder: (yargs) =>
    yargs
      .option("bar", {
        type: "string",
        describe: "the bar value",
      })
      .option("baz", {
        type: "boolean",
        describe: "enable baz",
      }),
  async handler() {},
})`
    const blocks = parseCommandBlocks(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe("foo")
    expect(blocks[0]!.describe).toBe("do a foo")
    expect(blocks[0]!.options).toEqual([
      { flag: "bar", describe: "the bar value", type: "string" },
      { flag: "baz", describe: "enable baz", type: "boolean" },
    ])
  })

  test("parseDefCall parses id, filename, label, owned keys, and merge policy", () => {
    const domain = parseDefCall('"general", "00-general.jsonc", "General", ["$schema", "theme"], "replace-domain"')
    expect(domain).toEqual({
      id: "general",
      filename: "00-general.jsonc",
      label: "General",
      ownedKeys: ["$schema", "theme"],
      mergePolicy: "replace-domain",
    })
    const defaulted = parseDefCall('"library", "30-library.jsonc", "Library", ["library"]')
    expect(defaulted?.mergePolicy).toBe("merge")
  })

  test("parseTaxonomy resolves exact, pattern fallback, and default kinds", () => {
    const source = `const REGISTRY = {
  bash: entry("code.execute"),
}
const PATTERN_FALLBACKS = [
  { pattern: /^note[-_]/i, kind: "knowledge.note" },
  { pattern: /^search/i, kind: "search.web" },
]
const DEFAULT_ENTRY = entry("platform.external")
`
    const classify = parseTaxonomy(source)
    expect(classify("bash")).toBe("code.execute")
    expect(classify("note_read")).toBe("knowledge.note")
    expect(classify("search_tools")).toBe("search.web")
    expect(classify("mystery_tool")).toBe("platform.external")
  })

  test("stringLiteral and templateLiteral normalize escapes and newlines", () => {
    expect(stringLiteral('"a\\"b"')).toBe('a"b')
    expect(stringLiteral('"line1\\nline2"')).toBe("line1 line2")
    expect(templateLiteral("`one\ntwo`", 0)).toBe("one two")
    expect(templateLiteral("`a\\`b`", 0)).toBe("a`b")
  })

  test("matchClose and findBlock skip string and template contents", () => {
    const source = `const x = { value: "}", nested: { deep: true } }`
    const block = findBlock(source, "x = ", "{", "}")
    expect(block).toContain(`value: "}"`)
    expect(matchClose('({ a: ")" }, b)', 0, "(", ")")).toBe('({ a: ")" }, b)'.length - 1)
  })

  test("isFresh detects drift from generated content", async () => {
    const root = await fixture()
    const file = path.join(root, "generated.md")
    await writeFile(
      file,
      "<!-- GENERATED BY g — DO NOT EDIT BY HAND. Run `bun script/gen/g` to regenerate. -->\n\n# Body\n",
    )
    expect(await isFresh(file, "g", "# Body")).toBe(true)
    await writeFile(file, "stale content")
    expect(await isFresh(file, "g", "# Body")).toBe(false)
    expect(await isFresh(path.join(root, "missing.md"), "g", "# Body")).toBe(false)
  })
})
