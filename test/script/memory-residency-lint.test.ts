import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../..")
const oxlint = path.join(repo, "node_modules/.bin/oxlint")
const ruleName = "memory-residency/no-restricted-syntax"

type Override = { files: string[]; rules: Record<string, unknown> }
type Restriction = { selector: string; message: string }

function readConfig(): { jsPlugins: string[]; overrides: Override[] } {
  return JSON.parse(readFileSync(path.join(repo, "oxlintrc.json"), "utf8")) as {
    jsPlugins: string[]
    overrides: Override[]
  }
}

function restrictions(config: { overrides: Override[] }, file: string): Restriction[] {
  const override = config.overrides.find((entry) => entry.files.includes(file))
  const rule = override?.rules[ruleName]
  if (!Array.isArray(rule)) throw new Error(`missing ${ruleName} for ${file}`)
  return rule.slice(1) as Restriction[]
}

function lint(root: string, configPath: string, files: string[]) {
  return spawnSync(oxlint, ["-c", configPath, "--deny-warnings", ...files], {
    cwd: root,
    encoding: "utf8",
  })
}

test("residency selectors reject deep clones and unbounded transcript reads", async () => {
  const config = readConfig()
  const boundary = restrictions(config, "apps/web/src/context/{sync,global-sync}.tsx")
  expect(boundary.map((item) => item.selector)).toEqual([
    "CallExpression[callee.name='structuredClone']",
    "CallExpression[callee.property.name='messages'][callee.object.property.name='session'], CallExpression[callee.property.name='messages'][callee.object.name='session']",
  ])
  const hot = restrictions(config, "apps/web/src/context/{streaming-token-event,message-arrival,part-arrival}.ts")
  expect(hot.map((item) => item.selector)).toEqual(["CallExpression[callee.name='structuredClone']"])

  const root = await mkdtemp(path.join(os.tmpdir(), "memory-residency-lint-"))
  try {
    const tempConfig = path.join(root, "oxlintrc.json")
    await Bun.write(
      tempConfig,
      JSON.stringify({
        jsPlugins: [path.join(repo, "script/oxlint/memory-residency.js")],
        rules: { [ruleName]: ["error", ...boundary] },
      }),
    )
    const cases: Array<{ name: string; code: string; ok: boolean; text?: string }> = [
      {
        name: "ordinary construction",
        ok: true,
        code: "const next = [1, 2].map((item) => item)\nconst table = new Map([['a', next]])\nexport { next, table }\n",
      },
      {
        name: "paged messages",
        ok: true,
        code: "const ids = [{ messages: [{ id: '1' }] }].flatMap((page) => page.messages.map((message) => message.id))\nexport { ids }\n",
      },
      {
        name: "structuredClone",
        ok: false,
        text: "structuredClone",
        code: "export const copy = structuredClone({ a: 1 })\n",
      },
      {
        name: "client session messages",
        ok: false,
        text: "session.messages",
        code: "type Client = { session: { messages: (input: object) => Promise<unknown> } }\nexport const load = (client: Client) => client.session.messages({})\n",
      },
      {
        name: "bare session messages",
        ok: false,
        text: "session.messages",
        code: "type Session = { messages: (input: object) => Promise<unknown> }\nexport const load = (session: Session) => session.messages({})\n",
      },
    ]
    for (const entry of cases) {
      const file = path.join(root, `${entry.name.replaceAll(" ", "-")}.ts`)
      await Bun.write(file, entry.code)
      const result = lint(root, tempConfig, [file])
      const output = `${result.stdout}\n${result.stderr}`
      if (entry.ok) expect(result.status, output).toBe(0)
      else {
        expect(result.status, output).not.toBe(0)
        expect(output).toContain(entry.text)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("overrides report clones on admission paths and ignore retained stores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-residency-scope-"))
  try {
    const config = readConfig()
    config.jsPlugins = [path.join(repo, "script/oxlint/memory-residency.js")]
    await Bun.write(path.join(root, "oxlintrc.json"), JSON.stringify(config))
    const samples = [
      { file: "apps/web/src/context/sync.tsx", ok: false },
      { file: "apps/web/src/context/streaming-token-event.ts", ok: false },
      { file: "apps/web/src/context/part-content-store.ts", ok: true },
      { file: "apps/web/src/utils/id.ts", ok: true },
    ]
    for (const sample of samples) {
      const file = path.join(root, sample.file)
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, "export const copy = structuredClone({ a: 1 })\n")
      const result = lint(root, path.join(root, "oxlintrc.json"), [file])
      const output = `${result.stdout}\n${result.stderr}`
      if (sample.ok) expect(result.status, output).toBe(0)
      else {
        expect(result.status, output).not.toBe(0)
        expect(output).toContain("structuredClone")
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("configured admission files pass the residency lint", () => {
  const config = readConfig()
  const files = config.overrides
    .filter((entry) => entry.rules[ruleName])
    .flatMap((entry) => entry.files)
    .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repo })])
  expect(files.length).toBeGreaterThan(0)
  const result = lint(repo, path.join(repo, "oxlintrc.json"), files)
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
