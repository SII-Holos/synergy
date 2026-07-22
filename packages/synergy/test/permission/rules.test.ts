import { describe, test, expect, beforeEach } from "bun:test"
import { PermissionRules } from "@/permission/rules"

describe("PermissionRules.extractPattern", () => {
  test("extracts bash command prefix", () => {
    expect(PermissionRules.extractPattern("bash", { command: "git commit -m test" })).toBe("git commit *")
    expect(PermissionRules.extractPattern("bash", { command: "npm run build" })).toBe("npm run *")
  })

  test("strips wrappers before extracting prefix", () => {
    expect(PermissionRules.extractPattern("bash", { command: "sudo git push" })).toBe("git push *")
    expect(PermissionRules.extractPattern("bash", { command: "timeout 10 rm -rf /tmp" })).toBe("rm -rf *")
  })

  test("extracts path glob for file tools", () => {
    expect(PermissionRules.extractPattern("edit", { path: "src/foo.ts" })).toBe("src/*")
    expect(PermissionRules.extractPattern("save_file", { filePath: "docs/readme.md" })).toBe("docs/*")
    expect(PermissionRules.extractPattern("openai_image_gen", { output_path: "assets/generated/star.png" })).toBe(
      "assets/generated/*",
    )
    expect(PermissionRules.extractPattern("openai_image_gen", { outputPath: "images/star.png" })).toBe("images/*")
    expect(
      PermissionRules.extractPattern("openai_image_edit", {
        input_paths: ["assets/input/source.png"],
        output_path: "assets/generated/source-edit.png",
      }),
    ).toBe("assets/input/*")
  })

  test("extracts the first valid path from file_path arrays", () => {
    expect(PermissionRules.extractPattern("attach", { file_path: ["reports/a.pdf", "reports/b.pdf"] })).toBe(
      "reports/*",
    )
    expect(PermissionRules.extractPattern("look_at", { file_path: ["images/a.png", "images/b.png"] })).toBe("images/*")
  })

  test("returns wildcard for unknown tool shapes", () => {
    expect(PermissionRules.extractPattern("webfetch", { url: "https://example.com" })).toBe("*")
    expect(PermissionRules.extractPattern("unknown", {})).toBe("*")
  })

  test("handles empty bash command", () => {
    expect(PermissionRules.extractPattern("bash", {})).toBe("*")
    expect(PermissionRules.extractPattern("bash", { command: "" })).toBe("*")
  })
})

describe("PermissionRules.evaluate", () => {
  const userRules: PermissionRules.Rule[] = [
    { permission: "bash", pattern: "git *", action: "allow", scope: "user" },
    { permission: "bash", pattern: "rm *", action: "deny", scope: "user" },
    { permission: "edit", pattern: "src/*", action: "allow", scope: "user" },
  ]

  test("allow rule matches", () => {
    const r = PermissionRules.evaluate("bash", "git commit *", userRules)
    expect(r.action).toBe("allow")
    expect(r.rule?.pattern).toBe("git *")
  })

  test("deny rule takes priority over allow", () => {
    const r = PermissionRules.evaluate("bash", "rm -rf *", userRules)
    expect(r.action).toBe("deny")
  })

  test("deny wins even if allow also matches", () => {
    const conflicting: PermissionRules.Rule[] = [
      { permission: "bash", pattern: "*", action: "allow", scope: "user" },
      { permission: "bash", pattern: "rm *", action: "deny", scope: "user" },
    ]
    const r = PermissionRules.evaluate("bash", "rm -rf /", conflicting)
    expect(r.action).toBe("deny")
  })

  test("no match returns ask", () => {
    const r = PermissionRules.evaluate("bash", "curl https://example.com", userRules)
    expect(r.action).toBe("ask")
  })

  test("wildcard permission matches any tool", () => {
    const wildcard: PermissionRules.Rule[] = [{ permission: "*", pattern: "*", action: "allow", scope: "user" }]
    expect(PermissionRules.evaluate("anything", "anything", wildcard).action).toBe("allow")
  })

  test("merges multiple rulesets", () => {
    const session: PermissionRules.Rule[] = [
      { permission: "bash", pattern: "npm *", action: "allow", scope: "session" },
    ]
    const r = PermissionRules.evaluate("bash", "npm run test", session, userRules)
    expect(r.action).toBe("allow")
  })
})

describe("PermissionRules session rules", () => {
  beforeEach(() => {
    PermissionRules.clearSessionRules()
  })

  test("addSessionRule adds to session ruleset", () => {
    PermissionRules.addSessionRule("session_test", { permission: "bash", pattern: "git *", action: "allow" })
    const rules = PermissionRules.sessionRuleset("session_test")
    expect(rules).toHaveLength(1)
    expect(rules[0].permission).toBe("bash")
    expect(rules[0].scope).toBe("session")
  })

  test("clearSessionRules empties the session ruleset", () => {
    PermissionRules.addSessionRule("session_test", { permission: "bash", pattern: "*", action: "allow" })
    PermissionRules.clearSessionRules()
    expect(PermissionRules.sessionRuleset("session_test")).toHaveLength(0)
  })

  test("session rules are scoped to one session", () => {
    PermissionRules.addSessionRule("session_one", { permission: "bash", pattern: "git *", action: "allow" })
    expect(PermissionRules.sessionRuleset("session_one")).toHaveLength(1)
    expect(PermissionRules.sessionRuleset("session_two")).toHaveLength(0)
  })
})
