import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ApplyPatchTool } from "../../src/tools/apply-patch"
import { testRuntime } from "../support/runtime"
import corpus from "../fixtures/codex-apply-patch/scenarios.json"

const Entry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), content: z.string() }),
  z.object({ kind: z.literal("directory"), content: z.never().optional() }),
])
const State = z.record(z.string(), Entry)
type State = z.infer<typeof State>
const Scenario = z.object({
  name: z.string(),
  input: State,
  patch: z.string(),
  expected: State,
  sha256: z.record(z.string(), z.string()),
})
type Scenario = z.infer<typeof Scenario>

const scenarios = z.array(Scenario).parse(corpus.scenarios)
const partialFailure = "015_failure_after_partial_success_leaves_changes"
const terminalNewline = "014_update_file_appends_trailing_newline"
const rejections: Record<string, RegExp> = {
  "005_rejects_empty_patch": /no file sections/i,
  "006_rejects_missing_context": /no matching context/i,
  "007_rejects_missing_file_delete": /Patch target must be a regular UTF-8 text file: missing\.txt/,
  "008_rejects_empty_update_hunk": /An Update requires a hunk or Move to destination/,
  "009_requires_existing_file_for_update": /Patch target must be a regular UTF-8 text file: missing\.txt/,
  "012_delete_directory_fails": /Patch target must be a regular UTF-8 text file: dir/,
  "013_rejects_invalid_hunk_header": /Unexpected patch line: \*\*\* Frobnicate File: foo/,
  "015_failure_after_partial_success_leaves_changes": /Patch target must be a regular UTF-8 text file: missing\.txt/,
}

async function snapshot(directory: string): Promise<State> {
  const result: State = {}
  async function visit(parent: string) {
    for (const entry of (await fs.readdir(parent, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const filename = path.join(parent, entry.name)
      const relative = path.relative(directory, filename).split(path.sep).join("/")
      if (entry.isDirectory()) {
        result[relative] = { kind: "directory" }
        await visit(filename)
      } else if (entry.isFile()) {
        result[relative] = {
          kind: "file",
          content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.readFile(filename)),
        }
      } else throw new Error(`Unexpected non-regular scenario entry: ${relative}`)
    }
  }
  await visit(directory)
  return result
}

async function replay(scenario: Scenario) {
  await using runtime = await testRuntime()
  return await runtime.run(async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "scenario")
    await fs.mkdir(directory)
    for (const [relative, entry] of Object.entries(scenario.input)) {
      const filename = path.join(directory, relative)
      if (entry.kind === "directory") await fs.mkdir(filename, { recursive: true })
      else if (entry.kind === "file") {
        await fs.mkdir(path.dirname(filename), { recursive: true })
        await Bun.write(filename, entry.content)
      } else throw new Error(`Unsupported fixture entry: ${relative}`)
    }
    return await ScopeContext.provide({
      scope: (await Scope.fromDirectory(directory)).scope,
      fn: async () => {
        let asks = 0
        let captured: unknown
        const ctx: Tool.Context = {
          sessionID: `codex-${scenario.name}`,
          messageID: "msg_codex_patch",
          callID: "codex-patch",
          agent: "fixture",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {
            asks++
          },
          async captureResult(result) {
            captured = result
          },
        }
        for (const [relative, entry] of Object.entries(scenario.input)) {
          if (entry.kind !== "file") continue
          const filename = path.join(directory, relative)
          FileTime.read(ctx.sessionID, filename, await Bun.file(filename).bytes())
        }
        const tool = await ApplyPatchTool.init()
        let result: Awaited<ReturnType<typeof tool.execute>> | undefined
        let failure: unknown
        try {
          result = await tool.execute({ patch: scenario.patch }, ctx)
        } catch (error) {
          failure = error
        }
        return { actual: await snapshot(directory), result, failure, captured, asks }
      },
    })
  })
}

test("Codex scenario corpus retains all source bytes, hashes and attribution", async () => {
  expect(corpus.provenance.upstream.commit).toBe("160b2b1ef62114eeb41e41e5e3be0000d944b713")
  expect(corpus.provenance.upstream.tree).toBe("e63f926297ff92caecb6d014b59c2819d67dbf6d")
  expect(corpus.provenance.upstream.scenarioCount).toBe(25)
  expect(scenarios).toHaveLength(25)
  expect(new Set(scenarios.map((scenario) => scenario.name)).size).toBe(25)
  expect(Object.keys(rejections).every((name) => scenarios.some((scenario) => scenario.name === name))).toBe(true)
  for (const scenario of scenarios) {
    const hashes: Record<string, string> = {
      "patch.txt": createHash("sha256").update(scenario.patch).digest("hex"),
    }
    for (const kind of ["input", "expected"] as const) {
      for (const [relative, entry] of Object.entries(scenario[kind])) {
        if (entry.kind === "file")
          hashes[`${kind}/${relative}`] = createHash("sha256").update(entry.content).digest("hex")
      }
    }
    expect(hashes, scenario.name).toEqual(scenario.sha256)
    if (rejections[scenario.name] && scenario.name !== partialFailure)
      expect(scenario.expected, scenario.name).toEqual(scenario.input)
  }
  for (const name of ["LICENSE", "NOTICE"] as const) {
    const bytes = await Bun.file(new URL(`../fixtures/codex-apply-patch/${name}`, import.meta.url)).bytes()
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(corpus.provenance.upstream.licenseSha256[name])
  }
})

for (const scenario of scenarios) {
  test(`Codex ${scenario.name}${scenario.name === partialFailure ? " (Synergy whole-preflight protection)" : ""}`, async () => {
    const { actual, result, failure, captured, asks } = await replay(scenario)
    const expected = scenario.name === partialFailure ? scenario.input : scenario.expected
    const diagnostic = failure instanceof Error ? failure.stack : String(failure ?? "")
    expect(actual, `${scenario.name}\n${diagnostic}`).toEqual(expected)
    const rejection = rejections[scenario.name]
    if (rejection) {
      expect(failure, scenario.name).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(rejection)
    } else {
      if (failure) throw failure
      expect(result?.metadata.outcome).toBe("applied")
    }
    if (scenario.name === terminalNewline) {
      expect(scenario.input["no_newline.txt"].content).toBe("no newline at end\n")
      expect(actual["no_newline.txt"].content).toBe("first line\nsecond line\n")
    }
    if (scenario.name === partialFailure) {
      expect(scenario.expected["created.txt"]).toEqual({ kind: "file", content: "hello\n" })
      expect(actual).toEqual(scenario.input)
      expect(Object.hasOwn(actual, "created.txt")).toBe(false)
      expect(asks).toBe(0)
      expect(captured).toMatchObject({
        metadata: {
          outcome: "rejected",
          sections: [
            { source: "created.txt", state: "not_started", operations: [] },
            { source: "missing.txt", state: "not_started", operations: [] },
          ],
        },
      })
    }
  })
}

test("Synergy 014 variant preserves a missing terminal newline instead of appending LF", async () => {
  const original = scenarios.find((scenario) => scenario.name === terminalNewline)!
  const input = original.input["no_newline.txt"].content!
  const expected = original.expected["no_newline.txt"].content!
  expect(input.endsWith("\n")).toBe(true)
  expect(expected.endsWith("\n")).toBe(true)
  const scenario: Scenario = {
    ...original,
    input: { "no_newline.txt": { kind: "file", content: input.slice(0, -1) } },
  }
  const { actual, failure, result } = await replay(scenario)
  if (failure) throw failure
  expect(result?.metadata.outcome).toBe("applied")
  expect(actual).toEqual({ "no_newline.txt": { kind: "file", content: expected.slice(0, -1) } })
  expect(actual["no_newline.txt"].content?.endsWith("\n")).toBe(false)
})
