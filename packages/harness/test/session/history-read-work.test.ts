import { afterAll, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function history(fn: (session: Session.Info) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      for (let index = 0; index < 8; index++) {
        const rootID = Identifier.ascending("message")
        const root = await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID,
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: index * 2 },
        })
        const reply = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: root.id,
          rootID,
          agent: "test",
          mode: "test",
          modelID: "test",
          providerID: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: index * 2 + 1, completed: index * 2 + 1 },
          finish: "stop",
        })
        for (const message of [root, reply])
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: message.id,
            type: "text",
            text: `body ${index} ${message.role}`,
          })
      }
      await fn(session)
    },
  })
}

test.each([false, true])("finite history hydrates only its window and referenced roots (raw=%s)", (raw) =>
  runtime.run(() =>
    history(async (session) => {
      const all = await SessionHistory.messages({ sessionID: session.id, raw })
      const window = all.slice(-3)
      const ids = new Set(window.flatMap(({ info }) => [info.id, info.rootID]))
      const expected = all.filter(({ info }) => ids.has(info.id))
      using parts = spyOn(MessageV2, "parts")
      expect(await SessionHistory.messages({ sessionID: session.id, raw, limit: 3 })).toEqual(expected)
      expect(parts.mock.calls.map(([input]) => input.messageID).sort()).toEqual(
        expected.map(({ info }) => info.id).sort(),
      )
    }),
  ),
)

test("zero-policy continuation does not read message history", () =>
  runtime.run(() =>
    history(async (session) => {
      using parts = spyOn(MessageV2, "parts")
      using infos = spyOn(MessageV2, "readInfoList")
      expect(await ContinuationKernel.propose(session.id)).toBeUndefined()
      expect(parts).not.toHaveBeenCalled()
      expect(infos).not.toHaveBeenCalled()
    }),
  ))

test("reconcile includes old roots without hydrating their bodies", () =>
  runtime.run(() =>
    history(async (session) => {
      const infos = await SessionHistory.effectiveMessageInfos(session)
      const root = infos[0]
      await RolloutLedger.beginRun(RolloutLifecycle.owner(session), root.id)
      using parts = spyOn(MessageV2, "parts")
      expect((await RolloutLifecycle.reconcile(session.id, root.id))?.status).toBe("completed")
      expect(parts).not.toHaveBeenCalled()
    }),
  ))
