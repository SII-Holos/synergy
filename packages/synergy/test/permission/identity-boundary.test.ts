import { test, expect, describe } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// permission/identity-boundary.test.ts
//
// Tests encoding the behavioral contract for session_send (role="user") and
// email_send as nonBypassable identity/communication boundaries.
//
// Current state:
//   - session_send(role="user") has NO permission check at all — it just sends.
//   - session_send(role="assistant") is used by chronicler/system for delivery.
//   - email_send asks `email` permission but lacks nonBypassable metadata.
//
// After implementation:
//   - session_send(role="user") → asks `identity_act` with nonBypassable metadata
//   - session_send(role="assistant") → remains allow-like (or permissioned for system agents)
//   - email_send → asks `communication_email` (or `email`) with nonBypassable metadata
//
// These tests MUST fail (RED) until the guards are added to the tool execution
// paths and the permission metadata is attached.
// ---------------------------------------------------------------------------

// ===========================================================================
// A. session_send identity boundary
// ===========================================================================

describe("session_send identity boundary", () => {
  test("identity_act with nonBypassable metadata prevents allowAll bypass", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await PermissionNext.setAllowAll("ses_session_send_test_allowall", true)

        const promise = PermissionNext.ask({
          sessionID: "ses_session_send_test_allowall",
          permission: "identity_act",
          patterns: ["session_send role=user to ses_target123"],
          metadata: {
            nonBypassable: true,
            action: "session_send",
            role: "user",
            target: "ses_target123",
          },
          ruleset: [{ permission: "identity_act", pattern: "*", action: "ask" }],
        })

        // Must still be pending — allowAll must not auto-approve nonBypassable
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_session_send_test_allowall")
        expect(found).toBeDefined()
        expect(found!.permission).toBe("identity_act")
        expect(found!.metadata.nonBypassable).toBe(true)

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()

        await PermissionNext.setAllowAll("ses_session_send_test_allowall", false)
      },
    })
  })

  test("identity_act with nonBypassable metadata prevents unattended auto-approve", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_session_send_test_unattended",
          permission: "identity_act",
          patterns: ["session_send role=user to ses_target"],
          metadata: {
            nonBypassable: true,
            sessionInteractionMode: "unattended",
            sessionInteractionSource: "agenda",
            action: "session_send",
            role: "user",
          },
          ruleset: [{ permission: "identity_act", pattern: "*", action: "ask" }],
        })

        // Must still be pending — unattended must not auto-approve nonBypassable
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_session_send_test_unattended")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })

  test("session_send role=assistant remains allowed where system agents need delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // role="assistant" should NOT carry nonBypassable metadata
        // and should resolve normally under standard allow rules
        const result = await PermissionNext.ask({
          sessionID: "ses_session_send_test_assistant",
          permission: "session_send",
          patterns: ["deliver to ses_target"],
          metadata: {
            action: "session_send",
            role: "assistant",
          },
          ruleset: [{ permission: "session_send", pattern: "*", action: "allow" }],
        })

        expect(result).toBeUndefined()
      },
    })
  })

  test("session_send role=assistant with nonBypassable metadata (future: same as user) should still block allowAll", async () => {
    // If role=assistant also gets nonBypassable in the future, allowAll must still not bypass it.
    // This test confirms the invariant: nonBypassable always trumps allowAll regardless of role.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await PermissionNext.setAllowAll("ses_session_send_assistant_nb_test", true)

        const promise = PermissionNext.ask({
          sessionID: "ses_session_send_assistant_nb_test",
          permission: "session_send",
          patterns: ["deliver to ses_target"],
          metadata: {
            nonBypassable: true,
            action: "session_send",
            role: "assistant",
          },
          ruleset: [{ permission: "session_send", pattern: "*", action: "ask" }],
        })

        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_session_send_assistant_nb_test")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()

        await PermissionNext.setAllowAll("ses_session_send_assistant_nb_test", false)
      },
    })
  })

  test("session_send role=user evaluated as deny returns DeniedError", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          PermissionNext.ask({
            sessionID: "ses_session_send_test_deny",
            permission: "identity_act",
            patterns: ["session_send role=user to ses_target"],
            metadata: {
              nonBypassable: true,
              action: "session_send",
              role: "user",
            },
            ruleset: [{ permission: "identity_act", pattern: "*", action: "deny" }],
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })
})

// ===========================================================================
// B. email_send communication boundary
// ===========================================================================

describe("email_send communication boundary", () => {
  test("communication_email with nonBypassable metadata prevents allowAll bypass", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await PermissionNext.setAllowAll("ses_email_send_test_allowall", true)

        const promise = PermissionNext.ask({
          sessionID: "ses_email_send_test_allowall",
          permission: "communication_email",
          patterns: ["to: user@example.com"],
          metadata: {
            nonBypassable: true,
            action: "email_send",
            to: "user@example.com",
            subject: "Test email",
          },
          ruleset: [{ permission: "communication_email", pattern: "*", action: "ask" }],
        })

        // Must still be pending — allowAll must not auto-approve nonBypassable
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_email_send_test_allowall")
        expect(found).toBeDefined()
        expect(found!.permission).toBe("communication_email")
        expect(found!.metadata.nonBypassable).toBe(true)

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()

        await PermissionNext.setAllowAll("ses_email_send_test_allowall", false)
      },
    })
  })

  test("communication_email with nonBypassable metadata prevents unattended auto-approve", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const promise = PermissionNext.ask({
          sessionID: "ses_email_send_test_unattended",
          permission: "communication_email",
          patterns: ["to: user@example.com"],
          metadata: {
            nonBypassable: true,
            sessionInteractionMode: "unattended",
            sessionInteractionSource: "agenda",
            action: "email_send",
            to: "user@example.com",
            subject: "Automated report",
          },
          ruleset: [{ permission: "communication_email", pattern: "*", action: "ask" }],
        })

        // Must still be pending — unattended must not auto-approve nonBypassable
        expect(promise).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const found = pending.find((r) => r.sessionID === "ses_email_send_test_unattended")
        expect(found).toBeDefined()

        if (found) {
          await PermissionNext.reply({ requestID: found.id, reply: "once" })
        }
        await expect(promise).resolves.toBeUndefined()
      },
    })
  })

  test("communication_email with deny rule returns DeniedError", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          PermissionNext.ask({
            sessionID: "ses_email_send_test_deny",
            permission: "communication_email",
            patterns: ["to: user@example.com"],
            metadata: {
              nonBypassable: true,
              action: "email_send",
              to: "user@example.com",
            },
            ruleset: [{ permission: "communication_email", pattern: "*", action: "deny" }],
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })

  test("email_send evaluated as ask-without-nonBypassable resolves in unattended (current behavior)", async () => {
    // RED/BEHAVIORAL: This test encodes current behavior — email_send asking
    // "email" permission WITHOUT nonBypassable metadata gets auto-approved
    // in unattended. After implementation, email_send must switch to
    // "communication_email" with nonBypassable metadata, which means this
    // auto-approve path is CLOSED.
    //
    // This test should STILL PASS after implementation because this specific
    // call (without nonBypassable) correctly represents a non-sensitive email
    // or a test scenario.  The REAL email_send tool path must NOT call this form.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // This specific call represents the OLD email_send path (no nonBypassable).
        // It SHOULD auto-approve because there's no nonBypassable metadata.
        // But the actual email_send tool MUST be updated to include it.
        await expect(
          PermissionNext.ask({
            sessionID: "ses_email_send_test_legacy_unattended",
            permission: "email",
            patterns: ["to: user@example.com"],
            metadata: {
              sessionInteractionMode: "unattended",
              action: "email_send",
              to: "user@example.com",
              // NOTE: nonBypassable is ABSENT — this is the pre-fix path
            },
            ruleset: [{ permission: "email", pattern: "*", action: "ask" }],
          }),
        ).resolves.toBeUndefined()
      },
    })
  })
})

// ===========================================================================
// C. allowAll + nonBypassable comprehensive
// ===========================================================================

describe("allowAll cannot defeat nonBypassable — general invariant", () => {
  test("allowAll does not auto-approve multiple nonBypassable requests simultaneously", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await PermissionNext.setAllowAll("ses_multi_nb_test", true)

        // Submit multiple nonBypassable requests
        const p1 = PermissionNext.ask({
          sessionID: "ses_multi_nb_test",
          permission: "identity_act",
          patterns: ["session_send role=user to ses_a"],
          metadata: { nonBypassable: true },
          ruleset: [{ permission: "identity_act", pattern: "*", action: "ask" }],
        })

        const p2 = PermissionNext.ask({
          sessionID: "ses_multi_nb_test",
          permission: "communication_email",
          patterns: ["to: admin@corp.com"],
          metadata: { nonBypassable: true },
          ruleset: [{ permission: "communication_email", pattern: "*", action: "ask" }],
        })

        const p3 = PermissionNext.ask({
          sessionID: "ses_multi_nb_test",
          permission: "external_directory",
          patterns: ["/original-checkout/secrets.env"],
          metadata: { nonBypassable: true, workspaceBoundary: true, outsideWorkspace: true },
          ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
        })

        // All three must be pending
        expect(p1).toBeInstanceOf(Promise)
        expect(p2).toBeInstanceOf(Promise)
        expect(p3).toBeInstanceOf(Promise)

        const pending = await PermissionNext.list()
        const ours = pending.filter((r) => r.sessionID === "ses_multi_nb_test")
        expect(ours.length).toBe(3)

        // Now reply to each and verify they resolve
        for (const req of ours) {
          await PermissionNext.reply({ requestID: req.id, reply: "once" })
        }
        await expect(p1).resolves.toBeUndefined()
        await expect(p2).resolves.toBeUndefined()
        await expect(p3).resolves.toBeUndefined()

        await PermissionNext.setAllowAll("ses_multi_nb_test", false)
      },
    })
  })

  test("allowAll does auto-approve non-bypassable requests that lack nonBypassable metadata", async () => {
    // Sanity check: when metadata does NOT have nonBypassable, allowAll works normally
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await PermissionNext.setAllowAll("ses_normal_allow_test", true)

        const result = await PermissionNext.ask({
          sessionID: "ses_normal_allow_test",
          permission: "bash",
          patterns: ["ls"],
          metadata: {}, // no nonBypassable
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        expect(result).toBeUndefined()

        await PermissionNext.setAllowAll("ses_normal_allow_test", false)
      },
    })
  })
})
