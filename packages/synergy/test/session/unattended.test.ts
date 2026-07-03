import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { PermissionNext } from "../../src/permission/next"
import { Question } from "../../src/question"
import { AppChannel } from "../../src/channel/app"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("session stores unattended interaction metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({
        interaction: SessionInteraction.unattended("agenda"),
      })

      expect(session.interaction).toEqual({
        mode: "unattended",
        source: "agenda",
      })
    },
  })
})

test("sessionRuleset denies question for unattended sessions", async () => {
  const ruleset = PermissionNext.sessionRuleset({
    interaction: SessionInteraction.unattended("channel:feishu"),
  })

  expect(PermissionNext.evaluate("question", "*", ruleset).action).toBe("deny")
})

test("unattended permission ask remains pending for ask actions", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_unattended_session_ask",
        sessionID: "ses_unattended",
        permission: "bash",
        patterns: ["ls"],
        metadata: { sessionInteractionMode: "unattended" },
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })

      const pending = await PermissionNext.list()
      expect(pending.find((r) => r.id === "permission_unattended_session_ask")).toBeDefined()

      await PermissionNext.reply({ requestID: "permission_unattended_session_ask", reply: "once" })
      await expect(promise).resolves.toBeUndefined()
    },
  })
})

test("unattended permission ask still rejects explicit deny rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "ses_unattended",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: { sessionInteractionMode: "unattended" },
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("question ask rejects immediately for unattended sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({
        interaction: SessionInteraction.unattended("agenda"),
      })

      await expect(
        Question.ask({
          sessionID: session.id,
          questions: [
            {
              question: "What should I do?",
              header: "Action",
              options: [{ label: "Proceed", description: "Continue" }],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(Question.UnattendedError)

      await expect(Question.list()).resolves.toEqual([])
    },
  })
})

test("getOrCreateForEndpoint applies explicit unattended interaction", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.getOrCreateForEndpoint(
        SessionEndpoint.fromChannel({
          type: "feishu",
          accountId: "acct_1",
          chatId: "chat_1",
        }),
        undefined,
        SessionInteraction.unattended("channel:feishu"),
      )

      expect(session.interaction).toEqual({
        mode: "unattended",
        source: "channel:feishu",
      })
    },
  })
})

test("app channel sessions remain interactive", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await AppChannel.session()
      expect(session.interaction).toEqual(SessionInteraction.interactive("channel:app"))
    },
  })
})

test("child sessions inherit unattended interaction from parent", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const parent = await Session.create({
        interaction: SessionInteraction.unattended("holos"),
      })
      const child = await Session.create({
        parentID: parent.id,
      })

      expect(child.interaction).toEqual(parent.interaction)
    },
  })
})

test("child sessions can override inherited interaction explicitly", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const parent = await Session.create({
        interaction: SessionInteraction.interactive("channel:app"),
      })
      const child = await Session.create({
        parentID: parent.id,
        interaction: SessionInteraction.unattended("chronicler"),
      })

      expect(child.interaction).toEqual(SessionInteraction.unattended("chronicler"))
    },
  })
})
