import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generate as generateCli, parseCommandBlocks, collectCommandSources } from "../../script/gen/gen-cli-reference"
import { generate as generateConfig, parseDefCall, parseDomainObject } from "../../script/gen/gen-config-reference"
import { generate as generateTools, parseTaxonomy, schemaFields } from "../../script/gen/gen-tool-catalog"
import {
  createWorkspaceModuleResolver,
  findBlock,
  isFresh,
  matchClose,
  parseObjectFields,
  stringLiteral,
  templateLiteral,
  zodTypeOf,
} from "../../script/gen/shared"

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
    const skill = first.split("## skill\n")[1]?.split("\n## ")[0]
    expect(skill).toContain("| `name` | string | yes |")
    expect(skill).toContain("| `reference` | string |  |")
    expect(skill).not.toContain("| `sha256`")
  })
})

describe("workspace manifest reuse", () => {
  test("one operation reads each manifest once for concurrent and repeated resolution", async () => {
    const root = await fixture()
    const cli = path.join(root, "cli")
    await mkdir(cli)
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["cli"] } }))
    await writeFile(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "@fixture/cli",
        exports: {
          ".": { bun: "./command.ts", types: "./types.ts", import: "./import.ts" },
          "./commands/*": "./*.ts",
        },
      }),
    )
    for (const name of ["command", "types", "import"]) await writeFile(path.join(cli, `${name}.ts`), "")
    const reads = spyOn(fs, "readFile")
    try {
      const resolve = createWorkspaceModuleResolver(root)
      expect(
        await Promise.all([resolve(root, "@fixture/cli"), resolve(root, "@fixture/cli/commands/command")]),
      ).toEqual([path.join(cli, "command.ts"), path.join(cli, "command.ts")])
      expect(await resolve(root, "@fixture/cli")).toBe(path.join(cli, "command.ts"))
      expect(await resolve(root, "@fixture/cli/missing")).toBeNull()
      expect(await resolve(root, "node:fs")).toBeNull()
      expect(await resolve(root, "external-package")).toBeNull()
      for (const manifest of [path.join(root, "package.json"), path.join(cli, "package.json")])
        expect(reads.mock.calls.filter(([file]) => file === manifest)).toHaveLength(1)
    } finally {
      reads.mockRestore()
    }
  })

  test("independent CLI generations reread manifests while sharing registration and source discovery reads", async () => {
    const root = await fixture()
    const cli = path.join(root, "packages/cli/src/cli")
    await mkdir(cli, { recursive: true })
    const manifest = path.join(root, "packages/cli/package.json")
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/cli"] } }))
    await writeFile(
      path.join(cli, "commands.ts"),
      'export const commands = [{ command: "fixture", load: () => import("@fixture/cli/command") }]',
    )
    await writeFile(path.join(cli, "runtime-commands.ts"), "")
    await writeFile(
      path.join(cli, "first.ts"),
      'import "@fixture/cli/nested"; export const Command = cmd({ command: "fixture", describe: "first generation" })',
    )
    await writeFile(
      path.join(cli, "second.ts"),
      'import "@fixture/cli/nested"; export const Command = cmd({ command: "fixture", describe: "second generation" })',
    )
    await writeFile(
      path.join(cli, "nested.ts"),
      'throw new Error("must remain static"); export const Nested = cmd({ command: "nested", describe: "nested command" })',
    )
    const exports = { "./command": "./src/cli/first.ts", "./nested": "./src/cli/nested.ts" }
    await writeFile(manifest, JSON.stringify({ name: "@fixture/cli", exports }))
    const reads = spyOn(fs, "readFile")
    try {
      const first = await generateCli(root)
      expect(first).toContain("| `fixture` | first generation |")
      expect(first).toContain("## nested")
      await writeFile(
        manifest,
        JSON.stringify({ name: "@fixture/cli", exports: { ...exports, "./command": "./src/cli/second.ts" } }),
      )
      const second = await generateCli(root)
      expect(second).toContain("| `fixture` | second generation |")
      expect(second).not.toContain("first generation")
      expect(second).toContain("## nested")
      for (const file of [path.join(root, "package.json"), manifest])
        expect(reads.mock.calls.filter(([filename]) => filename === file)).toHaveLength(2)
    } finally {
      reads.mockRestore()
    }
  })

  test("manifest failures reject and a new operation observes repaired files", async () => {
    const root = await fixture()
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["cli"] } }))
    const resolve = createWorkspaceModuleResolver(root)
    await expect(resolve(root, "external-package")).rejects.toMatchObject({ code: "ENOENT" })
    await mkdir(path.join(root, "cli"))
    const manifest = path.join(root, "cli/package.json")
    await writeFile(manifest, "invalid JSON")
    await expect(resolve(root, "external-package")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(createWorkspaceModuleResolver(root)(root, "external-package")).rejects.toBeInstanceOf(SyntaxError)
    await writeFile(manifest, JSON.stringify({ name: "@fixture/cli" }))
    expect(await createWorkspaceModuleResolver(root)(root, "@fixture/cli")).toBeNull()
  })
})

describe("generated catalog completeness", () => {
  test("reaction-only documentation keeps its empty input separate from execution results", async () => {
    const body = (await generateTools()).split("## channel_reaction_only\n")[1]!.split("\n## ")[0]!
    expect(body).toContain("End the turn with only a reaction")
    expect(body).not.toContain("| Parameter |")
    for (const field of ["title", "output", "metadata"]) expect(body).not.toContain(`| \`${field}\` |`)
  })

  test("named input schemas retain extended fields and imported field defaults", async () => {
    const output = await generateTools()
    const extend = output.split("## clarus_extend_task\n")[1]!.split("\n## ")[0]!
    expect(extend).toContain("| `extend_seconds` | number | yes | How many seconds")
    expect(extend).toContain("| `progress` | string |  | Optional concise progress")
    expect(extend).toContain("| `payload` | record |  | Optional bounded structured")
    const image = output.split("## openai_image_gen\n")[1]!.split("\n## ")[0]!
    expect(image).toContain("| `prompt` | string | yes |")
    expect(image).toContain("| `size` | string |  | Image size.")
    expect(image).toContain('| `quality` | "auto" \\| "low" \\| "medium" \\| "high" |  |')
    expect(image).not.toContain("| `method` |")
    const memory = output.split("## memory_write\n")[1]!.split("\n## ")[0]!
    expect(memory).toContain("Memory category: user, self, relationship")
  })

  test("observe documentation lists its imported schema instead of the execution command", async () => {
    const body = (await generateTools()).split("## computer_observe\n")[1]!.split("\n## ")[0]!
    expect(body).toContain("| `pid` | number | yes |")
    expect(body).toContain("| `windowId` | number | yes |")
    expect(body).not.toContain("| `type` |")
  })
  test("cli catalog lists top-level commands with option tables", async () => {
    const body = await generateCli()
    expect(body).toContain("## Commands")
    expect(body).toContain("| `config` |")
    expect(body).toContain("| `session` |")
    // Real command modules carry yargs .option() calls; the generator must
    // surface them as option tables rather than an empty options column.
    expect(body).toContain("| Option | Description |")
    expect(body).toContain("| `--cwd`")
    expect(body).toContain("## build [path]")
    expect(body).toContain("build a plugin definition into an installable package")
  })

  test("config catalog lists every config domain", async () => {
    const body = await generateConfig()
    for (const domain of [
      "general",
      "models",
      "providers",
      "library",
      "anima",
      "mcp",
      "plugins",
      "agents",
      "commands",
      "permissions",
      "channels",
      "holos",
      "email",
      "runtime",
      "skills",
    ]) {
      expect(body).toContain(`| \`${domain}\` |`)
    }
    expect(body).toContain("| `00-general.jsonc` |")
    expect(body).toContain("| `55-skills.jsonc` |")
    expect(body).toContain("| `35-anima.jsonc` |")
    for (const key of ["embedding", "library", "channel", "plugin", "voice", "mcp", "theme", "skills", "boss"]) {
      expect(body).toContain(`| \`${key}\` |`)
      expect(body).not.toContain(`| \`${key}\` | - |`)
    }
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
test("required object aliases do not inherit their children's modifiers or descriptions", async () => {
  const root = await fixture()
  const file = path.join(root, "schema.ts")
  await writeFile(
    file,
    `
      const Artifact = z.object({ note: z.string().optional().describe("Child note"), count: z.number().default(1) })
      const parameters = z.object({ artifact: Artifact, described: Artifact.describe("Required artifact"), maybe: Artifact.optional() })
    `,
  )
  const fields = await schemaFields(file, "parameters")
  expect(fields.map(({ name, optional, description }) => ({ name, optional, description }))).toEqual([
    { name: "artifact", optional: false, description: null },
    { name: "described", optional: false, description: "Required artifact" },
    { name: "maybe", optional: true, description: null },
  ])
})

test("schema extensions retain inherited fields while replacing overrides", async () => {
  const root = await fixture()
  const file = path.join(root, "schema.ts")
  await writeFile(
    file,
    `
      const Base = z.object({ kept: z.string(), changed: z.string().optional() })
      const parameters = Base.extend({ changed: z.number().describe("Final number"), added: z.boolean().default(false) })
    `,
  )
  expect(
    (await schemaFields(file, "parameters")).map(({ name, type, optional }) => ({ name, type, optional })),
  ).toEqual([
    { name: "kept", type: "string", optional: false },
    { name: "changed", type: "number", optional: false },
    { name: "added", type: "boolean", optional: true },
  ])
})

describe("parser behavior", () => {
  test("multiline coercion preserves the public number type, optionality and description", () => {
    const [field] = parseObjectFields(`
      limit: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Maximum lines")
        .optional(),
    `)
    expect(field).toMatchObject({ name: "limit", type: "number", optional: true, description: "Maximum lines" })
  })

  test("CLI source discovery follows lazy nested contributions without importing their runtime", async () => {
    const root = await fixture()
    const cli = path.join(root, "cli")
    await mkdir(cli)
    await writeFile(path.join(cli, "data.ts"), 'export const load = async () => (await import("./move")).MoveCommand')
    await writeFile(
      path.join(cli, "move.ts"),
      'throw new Error("must remain static"); export const MoveCommand = cmd({ command: "move", describe: "move data" })',
    )
    const files = await collectCommandSources([path.join(cli, "data.ts")])
    expect(files).toContain(path.join(cli, "move.ts"))
  })

  test("CLI catalog includes grouped data imports without replacing the migrate alias with its nested command", async () => {
    const output = await generateCli()
    expect(output).toContain("| `data` | manage synergy data location and storage |")
    expect(output).toContain("| `migrate` | move synergy data to a new location (alias for 'data move') |")
    expect(output).toContain("## snapshots")
    expect(output).toContain("## pack [output]")
    expect(output).toContain("## merge <source>")
    expect(output).toContain("## move <target>")
    expect(output).toContain("## lsp")
  })

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

  test("parseDomainObject parses object-literal domain entries", () => {
    const domain = parseDomainObject(
      `{
        id: "skills",
        filename: "55-skills.jsonc",
        label: "Skills",
        ownedKeys: ["skills"],
        mergePolicy: "merge",
        reloadTargets: ["config", "skill"],
        uiSection: "skills",
        importable: true,
      }`,
    )
    expect(domain).toEqual({
      id: "skills",
      filename: "55-skills.jsonc",
      label: "Skills",
      ownedKeys: ["skills"],
      mergePolicy: "merge",
    })
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

  test("parseObjectFields attributes a describe to the field that owns it", () => {
    const fields = parseObjectFields(`
    parent: z
      .object({
        child: z.number().optional().describe("child description"),
      })
      .optional()
      .describe("parent description"),
    sibling: z.string().optional().describe("sibling description"),
  `)
    expect(fields.find((field) => field.name === "parent")?.description).toBe("parent description")
    expect(fields.find((field) => field.name === "sibling")?.description).toBe("sibling description")
  })

  test("parseObjectFields reaches a large object's own describe and outermost type", () => {
    const inner = Array.from(
      { length: 40 },
      (_, index) => `        field${index}: z.number().optional().describe("inner ${index}"),`,
    ).join("\n")
    const fields = parseObjectFields(`
    big: z
      .object({
${inner}
      })
      .strict()
      .optional()
      .describe("big description"),
  `)
    const big = fields.find((field) => field.name === "big")
    expect(big?.description).toBe("big description")
    expect(big?.type).toBe("object")
  })

  test("zodTypeOf reports the outermost constructor rather than a nested one", () => {
    expect(zodTypeOf('z.object({ level: z.enum(["error", "warning"]).optional() })')).toBe("object")
    expect(zodTypeOf('z.enum(["error", "warning"])')).toBe('"error" | "warning"')
    expect(zodTypeOf("z.record(z.string(), z.string())")).toBe("record")
    expect(zodTypeOf("z.array(z.string())")).toBe("array")
    expect(zodTypeOf("z\n      .number()\n      .int()\n      .optional()")).toBe("number")
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
