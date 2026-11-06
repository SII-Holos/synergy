import { expect, test } from "bun:test"
import { SkillTool } from "@ericsanchezok/synergy-local-runtime/tools/skill"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { InstructionRegistry } from "@ericsanchezok/synergy-harness/instruction/registry"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"

test("Skill catalog retains late exclusions and multiline descriptions, with ordered accessible loading", async () => {
  const longDescription =
    "Create and update custom agents through validated configuration writes, including model selection, prompt text, permissions, visibility, and default-agent settings. Do not use for built-in agent source changes; load add-agent instead."
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
        ? longDescription
        : index === 1
          ? "  Design   agent-facing tools, MCP servers, and CLIs.\nLoad details for contract design.\r\n\tDo not use for connecting existing MCP servers; use synergy-config.  "
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
          `z-last: ${longDescription}`,
          "category/helper: Design agent-facing tools, MCP servers, and CLIs. Load details for contract design. Do not use for connecting existing MCP servers; use synergy-config.",
          ...accessible.slice(2).map((entry) => `${entry.name}: ${entry.description}`),
        ]
        expect(
          definition.description.split("<available_skills>\n")[1]?.split("\n</available_skills>")[0]?.split("\n"),
        ).toEqual(rows.toSorted((a, b) => a.split(":")[0]!.localeCompare(b.split(":")[0]!)))
        entries.reverse()
        expect((await SkillTool.init({ agent })).description).toBe(definition.description)
        entries.reverse()
        expect(definition.description).not.toContain("blocked")
        expect(definition.description).not.toContain("not-model")
        const unfiltered = await SkillTool.init()
        expect(
          unfiltered.description.split("<available_skills>\n")[1]?.split("\n</available_skills>")[0]?.split("\n"),
        ).toEqual(
          [...rows, "blocked: Instructions for blocked."].sort((a, b) =>
            a.split(":")[0]!.localeCompare(b.split(":")[0]!),
          ),
        )
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
          expect(loaded.output).toContain("references/detail.txt")
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
