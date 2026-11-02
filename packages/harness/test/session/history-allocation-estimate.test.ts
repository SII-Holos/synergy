import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"

test("estimates history from bounded content references before reading bodies", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const message = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          isRoot: true,
          agent: "general",
          model: { providerID: "test", modelID: "test" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: session.id,
          type: "text",
          text: "x".repeat(300_000),
        })
        using bodies = spyOn(MessageV2, "parts")
        expect(await SessionHistory.hydrationSize({ sessionID: session.id })).toBeGreaterThanOrEqual(300_000)
        expect(bodies).not.toHaveBeenCalled()
      },
    })
  })
})
