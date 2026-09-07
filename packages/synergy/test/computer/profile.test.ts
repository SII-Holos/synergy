import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ComputerAppsTool } from "../../src/computer/tools"

test("native dispatch rechecks a profile downgraded after tool initialization", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ controlProfile: "full_access" })
      try {
        const tool = await ComputerAppsTool.init()
        for (const profile of ["guarded", "autonomous"] as const) {
          await Session.updateControlProfile(session.id, profile)
          await expect(
            tool.execute(
              {},
              {
                sessionID: session.id,
                messageID: "msg_not_dispatched",
                agent: "synergy",
                abort: new AbortController().signal,
                metadata() {},
                async ask() {
                  throw new Error("Must not ask for an approval")
                },
              },
            ),
          ).rejects.toThrow("Computer Use requires Full Access")
        }
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})
