import { describe, expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { PermissionNext } from "../../src/permission/next"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

function action(agent: ReturnType<typeof createBuiltinMaxSubagents>[string], permission: string) {
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

describe("synergy-max subagents", () => {
  const agents = createBuiltinMaxSubagents(ctx)

  test("does not expose workflow-designer", () => {
    expect(agents["workflow-designer"]).toBeUndefined()
  })

  test("all max subagents receive the base utility and read tool bundles", () => {
    for (const agent of Object.values(agents)) {
      for (const permission of [
        "bash",
        "process",
        "skill",
        "websearch",
        "webfetch",
        "look_at",
        "glob",
        "read",
        "grep",
        "ast_grep",
        "view_file",
        "scan_files",
        "parse_code",
      ]) {
        expect(action(agent, permission)).toBe("allow")
      }
    }
  })

  test("anchored write agents can read broadly but write through the anchored file harness", () => {
    const anchoredWriters = [
      "implementation-engineer",
      "refactoring-engineer",
      "integration-engineer",
      "documentation-engineer",
      "test-strategist",
      "regression-reproducer",
      "fixture-builder",
      "property-test-engineer",
      "type-test-engineer",
    ]

    for (const name of anchoredWriters) {
      const agent = agents[name]
      expect(agent, name).toBeDefined()
      expect(action(agent, "view_file")).toBe("allow")
      expect(action(agent, "scan_files")).toBe("allow")
      expect(action(agent, "parse_code")).toBe("allow")
      expect(action(agent, "revise_file")).toBe("ask")
      expect(action(agent, "save_file")).toBe("ask")
      expect(action(agent, "read")).toBe("allow")
      expect(action(agent, "grep")).toBe("allow")
      expect(action(agent, "ast_grep")).toBe("allow")
      expect(action(agent, "edit")).toBe("deny")
      expect(action(agent, "write")).toBe("deny")
    }
  })

  test("classic read agents do not receive anchored write tools", () => {
    const classicReaders = [
      "intent-analyst",
      "requirements-engineer",
      "code-cartographer",
      "dependency-tracer",
      "solution-architect",
      "api-contract-designer",
      "migration-architect",
      "quality-gatekeeper",
      "python-quality-engineer",
      "rust-quality-engineer",
      "typescript-quality-engineer",
      "maintainability-reviewer",
      "security-reviewer",
      "performance-reviewer",
      "api-compatibility-reviewer",
      "documentation-reviewer",
      "docs-researcher",
      "research-methodologist",
    ]

    for (const name of classicReaders) {
      const agent = agents[name]
      expect(agent, name).toBeDefined()
      expect(action(agent, "read")).toBe("allow")
      expect(action(agent, "grep")).toBe("allow")
      expect(action(agent, "ast_grep")).toBe("allow")
      expect(action(agent, "view_file")).toBe("allow")
      expect(action(agent, "scan_files")).toBe("allow")
      expect(action(agent, "parse_code")).toBe("allow")
      expect(action(agent, "revise_file")).toBe("deny")
      expect(action(agent, "save_file")).toBe("deny")
    }
  })

  test("knowledge agents keep their specialized bundles", () => {
    expect(action(agents["memory-curator"], "memory_search")).toBe("allow")
    expect(action(agents["memory-curator"], "memory_write")).toBe("allow")
    expect(action(agents["note-librarian"], "note_search")).toBe("allow")
    expect(action(agents["note-librarian"], "note_write")).toBe("allow")
    expect(action(agents["session-historian"], "session_search")).toBe("allow")
    expect(action(agents["session-historian"], "session_control")).toBe("deny")
  })
})
