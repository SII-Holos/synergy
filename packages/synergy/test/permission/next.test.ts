import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { PermissionRules } from "../../src/permission/rules"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = PermissionNext.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = PermissionNext.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = PermissionNext.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = PermissionNext.fromConfig({})
  expect(result).toEqual([])
})

// merge tests

test("merge - simple concatenation", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = PermissionNext.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = PermissionNext.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  // Simulates: defaults have "*": "ask", config overrides bash: "allow"
  const defaults: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's bash allow should override default ask
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
  // Other permissions should still be ask (from defaults)
  expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  // Simulates: defaults have bash: "allow", config overrides bash: "ask"
  const defaults: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's ask should override default allow
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  // If more specific rule comes first, later wildcard overrides it
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = PermissionNext.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = PermissionNext.evaluate("edit", "etc/passwd", [
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = PermissionNext.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = PermissionNext.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = PermissionNext.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = PermissionNext.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - permission patterns sorted by length regardless of object order", () => {
  // specific permission listed before wildcard, but specific should still win
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  // With flat list, last matching rule wins - so "*" matches bash and wins
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionNext.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  // approved comes after config, so rm should be denied
  const result = PermissionNext.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = PermissionNext.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/patch/multiedit when edit denied", () => {
  const result = PermissionNext.disabled(
    ["edit", "write", "patch", "multiedit", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("patch")).toBe(true)
  expect(result.has("multiedit")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = PermissionNext.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  // Tool is NOT disabled because a specific allow after wildcard deny means
  // there's at least some usage allowed
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = PermissionNext.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

test("ask - resolves immediately when action is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - throws RejectedError when action is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("ask - returns pending promise when action is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      // Promise should be pending, not resolved
      expect(promise).toBeInstanceOf(Promise)
      // Don't await - just verify it returns a promise
    },
  })
})

// reply tests

test("reply - once resolves the pending ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_test1",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [],
      })

      await PermissionNext.reply({
        requestID: "permission_test1",
        reply: "once",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("reply - reject throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_test2",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [],
      })

      await PermissionNext.reply({
        requestID: "permission_test2",
        reply: "reject",
      })

      await expect(askPromise).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - reject cancels all pending for same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const askPromise1 = PermissionNext.ask({
        id: "permission_test4a",
        sessionID: "session_same",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [],
      })

      const askPromise2 = PermissionNext.ask({
        id: "permission_test4b",
        sessionID: "session_same",
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        ruleset: [],
      })

      // Catch rejections before they become unhandled
      const result1 = askPromise1.catch((e) => e)
      const result2 = askPromise2.catch((e) => e)

      // Reject the first one
      await PermissionNext.reply({
        requestID: "permission_test4a",
        reply: "reject",
      })

      // Both should be rejected
      expect(await result1).toBeInstanceOf(PermissionNext.RejectedError)
      expect(await result2).toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("ask - checks all patterns and stops on first deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("ask - allows all patterns when all match allow rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - unattended metadata auto-approves ask actions", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["ls"],
          metadata: { sessionInteractionMode: "unattended" },
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("sessionRuleset - unattended sessions deny question", () => {
  const result = PermissionNext.sessionRuleset({
    interaction: { mode: "unattended", source: "agenda" },
  })

  expect(PermissionNext.evaluate("question", "*", result).action).toBe("deny")
})

test("Reply schema accepts session and always approvals", () => {
  expect(PermissionNext.Reply.parse("session")).toBe("session")
  expect(PermissionNext.Reply.parse("always")).toBe("always")
})

test("reply - session approval records a session-scoped allow rule", async () => {
  PermissionRules.clearSessionRules()
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_session_allow",
        sessionID: "session_reply_session",
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      await PermissionNext.reply({ requestID: "permission_session_allow", reply: "session" })
      await expect(promise).resolves.toBeUndefined()

      expect(
        PermissionRules.evaluate("bash", "git status", PermissionRules.sessionRuleset("session_reply_session")).action,
      ).toBe("allow")
      expect(PermissionRules.sessionRuleset("other_session")).toHaveLength(0)
    },
  })
})

// === Workspace boundary / non-bypassable tests ===

test("ask - nonBypassable metadata stays pending for ask rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_nonbypass_1",
        sessionID: "session_test_nonbypass",
        permission: "bash",
        patterns: ["cat /etc/shadow"],
        metadata: { nonBypassable: true, workspaceBoundary: true },
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      expect(promise).toBeInstanceOf(Promise)

      const pending = await PermissionNext.list()
      const nonBypassableRequest = pending.find((r) => r.sessionID === "session_test_nonbypass")
      expect(nonBypassableRequest).toBeDefined()

      // Clean up
      if (nonBypassableRequest) {
        await PermissionNext.reply({ requestID: nonBypassableRequest.id, reply: "once" })
      }
      await expect(promise).resolves.toBeUndefined()
    },
  })
})

test("ask - workspaceBoundary context does not block unattended auto-approve", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test_workspace_boundary",
        permission: "bash",
        patterns: ["rm /outside/file"],
        metadata: {
          sessionInteractionMode: "unattended",
          workspaceBoundary: true,
          outsideWorkspace: true,
        },
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      expect(result).toBeUndefined()
      const request = await PermissionNext.list()
      expect(request.find((r) => r.sessionID === "session_test_workspace_boundary")).toBeUndefined()
    },
  })
})

test("ask - nonBypassable metadata keeps edit ask pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        sessionID: "session_test_nonbypass2",
        permission: "edit",
        patterns: ["/outside/workspace/file.ts"],
        metadata: { nonBypassable: true },
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
      })

      expect(promise).toBeInstanceOf(Promise)

      // Clean up
      const request = await PermissionNext.list()
      const pendingId = request.find((r) => r.sessionID === "session_test_nonbypass2")
      if (pendingId) {
        await PermissionNext.reply({ requestID: pendingId.id, reply: "once" })
      }
      await expect(promise).resolves.toBeUndefined()
    },
  })
})

test("ask - nonBypassable workspace boundary metadata keeps bash ask pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        sessionID: "session_test_nonbypass_base",
        permission: "bash",
        patterns: ["cat /outside/file"],
        metadata: { nonBypassable: true, workspaceBoundary: true },
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      expect(promise).toBeInstanceOf(Promise)

      const request = await PermissionNext.list()
      const pendingId = request.find((r) => r.sessionID === "session_test_nonbypass_base")
      if (pendingId) {
        await PermissionNext.reply({ requestID: pendingId.id, reply: "once" })
      }
      await expect(promise).resolves.toBeUndefined()
    },
  })
})

// === Rule ordering preservation ===

test("evaluate - rule ordering unchanged with nonBypassable metadata present", () => {
  const ruleset: PermissionNext.Ruleset = [
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ]

  // Verify the existing last-match-wins ordering is unchanged
  expect(PermissionNext.evaluate("edit", "src/secret/ok.ts", ruleset).action).toBe("allow")
  expect(PermissionNext.evaluate("edit", "src/secret/other.ts", ruleset).action).toBe("deny")
  expect(PermissionNext.evaluate("edit", "src/foo.ts", ruleset).action).toBe("allow")
})

test("evaluate - general allow followed by specific deny works with nonBypassable context", () => {
  // This pattern must remain: general allow then specific deny = deny (last match wins)
  const ruleset: PermissionNext.Ruleset = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm /outside/*", action: "deny" },
  ]

  expect(PermissionNext.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(PermissionNext.evaluate("bash", "rm /outside/passwd", ruleset).action).toBe("deny")
})

test("evaluate - wildcard permission ordering preserved with new permission types", () => {
  const ruleset: PermissionNext.Ruleset = [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ]

  // Wildcard permission fallback, then glob permission, then specific — last wins
  expect(PermissionNext.evaluate("mcp_dangerous", "anything", ruleset).action).toBe("deny")
  expect(PermissionNext.evaluate("mcp_safe", "anything", ruleset).action).toBe("allow")
  expect(PermissionNext.evaluate("bash", "anything", ruleset).action).toBe("ask")
})

test("evaluate - merge preserves rule ordering needed for workspace boundary rules", () => {
  const base: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const overlay: PermissionNext.Ruleset = [
    { permission: "bash", pattern: "/outside/*", action: "deny" },
    { permission: "bash", pattern: "/outside/safe/*", action: "allow" },
  ]

  const merged = PermissionNext.merge(base, overlay)

  // overlay's deny should win after merge (last match wins)
  expect(PermissionNext.evaluate("bash", "/outside/dangerous", merged).action).toBe("deny")
  // overlay's allow exception should win after merge
  expect(PermissionNext.evaluate("bash", "/outside/safe/ok.sh", merged).action).toBe("allow")
  // base's allow should apply for normal paths
  expect(PermissionNext.evaluate("bash", "src/build.sh", merged).action).toBe("allow")
})
