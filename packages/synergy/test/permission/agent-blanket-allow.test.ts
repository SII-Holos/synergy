import { test, expect, describe } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// permission/agent-blanket-allow.test.ts
//
// Tests encoding the behavioral contract that internal agent blanket `allow`
// permissions cannot bypass explicit nonBypassable boundaries.
//
// Background:
//   - `anima` has `external_directory: {"*":"allow"}`
//   - `multimodal-looker` has `external_directory: {"*":"allow"}`
//   - These blanket allows are appended via PermissionNext.merge() and
//     evaluated by findLast(), so they can override earlier "ask" rules.
//
// Problem:
//   Dangerous operations carry explicit nonBypassable metadata. Blanket allow
//   rules must not resolve those requests without surfacing the ask.
//
// After implementation:
//   - nonBypassable must defeat blanket allow rules
// ---------------------------------------------------------------------------

// ===========================================================================
// A. nonBypassable defeats blanket allow
// ===========================================================================

describe("nonBypassable defeats blanket external_directory allow", () => {
  test("external_directory ask with nonBypassable stays pending despite allow rule", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // This simulates the anima agent: blanket external_directory "allow"
        // ... but ControlProfile inserts nonBypassable: true
        const promise = PermissionNext.ask({
          sessionID: "ses_anima_nonbypass_test",
          permission: "external_directory",
          patterns: ["/original-checkout/secrets.json"],
          metadata: {
            nonBypassable: true,
            workspaceBoundary: true,
            outsideWorkspace: true,
            targetPath: "/original-checkout/secrets.json",
          },
          ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
        })

        // Blanket allow rule SHOULD auto-resolve... but nonBypassable prevents it
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_anima_nonbypass_test")
        expect(found).toBeDefined()
        expect(found!.permission).toBe("external_directory")
        expect(found!.metadata.nonBypassable).toBe(true)

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })

  test("external_directory allow rule resolves when no nonBypassable metadata", async () => {
    // Sanity: without nonBypassable, blanket allow works normally
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await PermissionNext.ask({
          sessionID: "ses_anima_normal_test",
          permission: "external_directory",
          patterns: ["/some/external/path"],
          metadata: {}, // no nonBypassable
          ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
        })

        expect(result).toBeUndefined() // auto-resolved
      },
    })
  })

  test("nonBypassable metadata defeats blanket allow rules", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_anima_unattended_test",
          permission: "external_directory",
          patterns: ["/original-checkout/data.db"],
          metadata: {
            nonBypassable: true,
            workspaceBoundary: true,
            outsideWorkspace: true,
            sessionInteractionMode: "unattended",
            sessionInteractionSource: "agenda",
          },
          ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
        })

        // nonBypassable boundaries must remain pending even with blanket allow rules.
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_anima_unattended_test")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })
})

// ===========================================================================
// B. blanket allow must not bypass nonBypassable across different permissions
// ===========================================================================

describe("blanket allow vs nonBypassable across permission types", () => {
  test("bash blanket allow does not defeat nonBypassable workspace boundary cross", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_bash_nonbypass_test",
          permission: "bash",
          patterns: ["cat /original-checkout/secrets"],
          metadata: {
            nonBypassable: true,
            workspaceBoundary: true,
            outsideWorkspace: true,
          },
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })

        // nonBypassable beats blanket allow
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_bash_nonbypass_test")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })

  test("read blanket allow does not defeat nonBypassable workspace boundary cross", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_read_nonbypass_test",
          permission: "read",
          patterns: ["/original-checkout/synergy.jsonc"],
          metadata: {
            nonBypassable: true,
            workspaceBoundary: true,
            outsideWorkspace: true,
          },
          ruleset: [
            { permission: "read", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
          ],
        })

        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_read_nonbypass_test")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })

  test("write blanket allow does not defeat nonBypassable workspace boundary cross", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_write_nonbypass_test",
          permission: "write",
          patterns: ["/original-checkout/config.ts"],
          metadata: {
            nonBypassable: true,
            workspaceBoundary: true,
            outsideWorkspace: true,
          },
          ruleset: [{ permission: "write", pattern: "*", action: "allow" }],
        })

        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_write_nonbypass_test")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })
})

// ===========================================================================
// C. current behavior: blanket allow resolves when nonBypassable is absent
// ===========================================================================

describe("blanket allow resolves when nonBypassable absent — sanity checks", () => {
  test("external_directory blanket allow auto-resolves in-workspace read", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Without nonBypassable metadata, blanket allow works as before
        const result = await PermissionNext.ask({
          sessionID: "ses_anima_normal_read",
          permission: "read",
          patterns: [tmp.path + "/src/app.ts"],
          metadata: {},
          ruleset: [{ permission: "read", pattern: "*", action: "allow" }],
        })

        expect(result).toBeUndefined()
      },
    })
  })

  test("bash blanket allow auto-resolves in-workspace command", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await PermissionNext.ask({
          sessionID: "ses_bash_normal_test",
          permission: "bash",
          patterns: ["ls -la"],
          metadata: {},
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })

        expect(result).toBeUndefined()
      },
    })
  })
})

// ===========================================================================
// D. isNonBypassableMetadata behavior with metadata combinations
// ===========================================================================

describe("isNonBypassableMetadata detection", () => {
  test("recognizes nonBypassable flag alone", async () => {
    const { isNonBypassableMetadata } = await import("../../src/enforcement/capability")

    expect(isNonBypassableMetadata({ nonBypassable: true })).toBe(true)
    expect(isNonBypassableMetadata({ nonBypassable: false })).toBe(false)
    expect(isNonBypassableMetadata({})).toBe(false)
    expect(isNonBypassableMetadata(undefined)).toBe(false)
  })

  test("workspace boundary context alone is bypassable", async () => {
    const { isNonBypassableMetadata } = await import("../../src/enforcement/capability")

    expect(isNonBypassableMetadata({ workspaceBoundary: true })).toBe(false)
    expect(isNonBypassableMetadata({ workspaceBoundary: false })).toBe(false)
  })

  test("outside workspace context alone is bypassable", async () => {
    const { isNonBypassableMetadata } = await import("../../src/enforcement/capability")

    expect(isNonBypassableMetadata({ outsideWorkspace: true })).toBe(false)
    expect(isNonBypassableMetadata({ outsideWorkspace: false })).toBe(false)
  })

  test("only explicit nonBypassable triggers nonBypassable", async () => {
    const { isNonBypassableMetadata } = await import("../../src/enforcement/capability")

    expect(isNonBypassableMetadata({ nonBypassable: true, workspaceBoundary: true })).toBe(true)
    expect(isNonBypassableMetadata({ nonBypassable: true, workspaceBoundary: false })).toBe(true)
    expect(isNonBypassableMetadata({ nonBypassable: false, workspaceBoundary: true })).toBe(false)
  })

  test("irrelevant metadata does not trigger nonBypassable", async () => {
    const { isNonBypassableMetadata } = await import("../../src/enforcement/capability")

    expect(isNonBypassableMetadata({ action: "session_send", role: "user" })).toBe(false)
    expect(isNonBypassableMetadata({ to: "user@example.com", subject: "hi" })).toBe(false)
    expect(isNonBypassableMetadata({ sessionInteractionMode: "unattended" })).toBe(false)
  })
})
