import { describe, expect, test } from "bun:test"
import { SkillTool, truncateSkillDescription } from "@ericsanchezok/synergy-local-runtime/tools/skill"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { InstructionRegistry } from "@ericsanchezok/synergy-harness/instruction/registry"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"

describe("truncateSkillDescription", () => {
  test("empty input returns an empty string", () => {
    expect(truncateSkillDescription("")).toBe("")
  })

  test("whitespace-only input returns an empty string", () => {
    expect(truncateSkillDescription("   \n\t\t  ")).toBe("")
  })

  test("keeps a short description unchanged apart from collapsing internal whitespace", () => {
    expect(truncateSkillDescription("  Route   changes to the   focused owner.  ")).toBe(
      "Route changes to the focused owner.",
    )
  })

  test("a description of exactly 100 characters passes through without an ellipsis", () => {
    const description = "a".repeat(100)
    expect(truncateSkillDescription(description)).toBe(description)
  })

  test("keeps only the first line of a multi-line description", () => {
    const firstLine = "Route the change to the owning skill."
    const description = `${firstLine}\nSecond line with many hundreds of characters that must never appear in the result.`
    const result = truncateSkillDescription(description)
    expect(result).toBe(firstLine)
    expect(result).not.toContain("\n")
  })

  test("truncates a long description to one line, at most 104 chars, ending with an ellipsis at a word boundary", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`)
    const description = words.join(" ")
    const result = truncateSkillDescription(description)
    expect(result.length).toBeLessThanOrEqual(104)
    expect(result).not.toContain("\n")
    expect(result.endsWith("…")).toBe(true)
    const content = result.slice(0, -1)
    expect(content.length).toBeLessThanOrEqual(100)
    expect(description.startsWith(content)).toBe(true)
    expect(description[content.length]).toBe(" ")
  })

  test("hard-cuts a single unbroken word longer than 100 characters at the cap", () => {
    const description = "x".repeat(300)
    expect(truncateSkillDescription(description)).toBe(`${"x".repeat(100)}…`)
  })
})

test("Skill catalog keeps every accessible name in source order with the existing truncated description", async () => {
  const entries: InstructionRegistry.Entry[] = [
    "z-last",
    "category/helper",
    "blocked",
    "not-model",
    ...Array.from({ length: 12 }, (_, index) => `skill-${index}`),
  ].map((name, index) => ({
    name,
    description:
      index === 0
        ? "  Route   changes to the focused owner.  \nDetails are loaded separately."
        : index === 1
          ? "x".repeat(120)
          : `Instructions for ${name}.`,
    source: "fixture",
    scope: "project",
    compatibility: "native",
    directory: `/skills/${name}`,
    model: name !== "not-model",
    warnings: [],
    unsupported: [],
    async content() {
      return `Main content for ${name}.`
    },
    async references() {
      return ["references/detail.txt"]
    },
    async reference(reference) {
      return reference === "references/detail.txt" ? `Reference content for ${name}.` : undefined
    },
  }))
  const agent = Agent.Info.parse({
    name: "catalog-fixture",
    mode: "primary",
    options: {},
    permission: PermissionNext.fromConfig({
      "*": "allow",
      skill: { "*": "allow", blocked: "deny", "category/helper": "ask" },
    }),
  })
  await using runtime = await testRuntime({
    register() {
      InstructionRegistry.register({
        kind: "skill",
        async render({ template }) {
          return [template]
        },
        hints: () => [],
        entries: async () => entries,
        entry: async (name) => entries.find((entry) => entry.name === name),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const accessible = entries.filter((entry) => entry.name !== "blocked" && entry.model)
        const definition = await SkillTool.init({ agent })
        const rows = [
          "z-last: Route changes to the focused owner.",
          `category/helper: ${"x".repeat(100)}…`,
          ...accessible.slice(2).map((entry) => `${entry.name}: ${entry.description}`),
        ]
        expect(
          definition.description.split("<available_skills>\n")[1]?.split("\n</available_skills>")[0]?.split("\n"),
        ).toEqual(rows)
        expect(definition.description).not.toContain("blocked")
        expect(definition.description).not.toContain("not-model")
        const unfiltered = await SkillTool.init()
        expect(
          unfiltered.description.split("<available_skills>\n")[1]?.split("\n</available_skills>")[0]?.split("\n"),
        ).toEqual([...rows.slice(0, 2), "blocked: Instructions for blocked.", ...rows.slice(2)])
        expect(definition.parameters.parse({ name: "category/helper", reference: "references/detail.txt" })).toEqual({
          name: "category/helper",
          reference: "references/detail.txt",
        })
        const requests: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const context: Tool.Context = {
          sessionID: "ses_skill_catalog",
          messageID: "msg_skill_catalog",
          agent: agent.name,
          abort: new AbortController().signal,
          metadata() {},
          async ask(request) {
            requests.push(request)
            if (PermissionNext.evaluate(request.permission, request.patterns[0]!, agent.permission).action === "deny")
              throw new Error("Skill permission denied")
          },
        }
        for (const entry of accessible) {
          const loaded = await definition.execute({ name: entry.name }, context)
          expect(loaded.metadata.name).toBe(entry.name)
          expect(loaded.output).toContain(`Main content for ${entry.name}.`)
        }
        expect(requests).toEqual(
          accessible.map((entry) => ({ permission: "skill", patterns: [entry.name], metadata: {} })),
        )
        const reference = await definition.execute(
          { name: "category/helper", reference: "references/detail.txt" },
          context,
        )
        expect(reference.output).toBe("Reference content for category/helper.")
        await expect(definition.execute({ name: "blocked" }, context)).rejects.toThrow("Skill permission denied")
        await expect(definition.execute({ name: "not-model" }, context)).rejects.toThrow(
          "not available for model invocation",
        )
      },
    }),
  )
})
