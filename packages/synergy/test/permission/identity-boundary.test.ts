import { test, expect, describe } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

async function expectPending(input: Parameters<typeof PermissionNext.ask>[0], sessionID: string) {
  const promise = PermissionNext.ask(input)
  expect(promise).toBeInstanceOf(Promise)

  const pending = await PermissionNext.list()
  const found = pending.find((r) => r.sessionID === sessionID)
  expect(found).toBeDefined()

  if (found) {
    await PermissionNext.reply({ requestID: found.id, reply: "once" })
  }
  await expect(promise).resolves.toBeUndefined()
}

describe("session_send identity boundary", () => {
  test("identity_act with nonBypassable metadata stays pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expectPending(
          {
            sessionID: "ses_session_send_test_nonbypass",
            permission: "identity_act",
            patterns: ["session_send role=user to ses_target123"],
            metadata: {
              nonBypassable: true,
              action: "session_send",
              role: "user",
              target: "ses_target123",
            },
            ruleset: [{ permission: "identity_act", pattern: "*", action: "ask" }],
          },
          "ses_session_send_test_nonbypass",
        )
      },
    })
  })

  test("identity_act with nonBypassable metadata prevents unattended auto-approve", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expectPending(
          {
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
          },
          "ses_session_send_test_unattended",
        )
      },
    })
  })

  test("session_send role=assistant remains allowed where system agents need delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
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

describe("email_send communication boundary", () => {
  test("communication_email with nonBypassable metadata stays pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expectPending(
          {
            sessionID: "ses_email_send_test_nonbypass",
            permission: "communication_email",
            patterns: ["to: user@example.com"],
            metadata: {
              nonBypassable: true,
              action: "email_send",
              to: "user@example.com",
              subject: "Test email",
            },
            ruleset: [{ permission: "communication_email", pattern: "*", action: "ask" }],
          },
          "ses_email_send_test_nonbypass",
        )
      },
    })
  })

  test("communication_email with nonBypassable metadata prevents unattended auto-approve", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expectPending(
          {
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
          },
          "ses_email_send_test_unattended",
        )
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
})
