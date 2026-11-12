import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"

test("canonical Workspace discovery retains retired historical identity and generation without a current directory", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          rootID: messageID,
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "snapshot",
          snapshot: "a".repeat(40),
          workspace: { id: "retired-original-workspace", generation: 7, root: "/original/history/evidence" },
        })
        const references = []
        for await (const reference of Core.workspaceReferences(session)) references.push(reference)
        expect(references).toEqual([{ id: "retired-original-workspace", scopeID: "home", generation: 7 }])
        expect((await Session.get(session.id)).workspaceID).toBeNull()
      },
    }),
  )
})
