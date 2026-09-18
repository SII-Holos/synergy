import { expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"

test("startup discovery reads typed records without walking every historical session", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const sessions = await Promise.all(Array.from({ length: 12 }, () => Session.create({ title: "History" })))
      const active = sessions[0]
      await Session.update(active.id, (draft) => {
        draft.pendingReply = true
      })
      await SessionInbox.enqueueUser({
        sessionID: active.id,
        model: { providerID: "test", modelID: "test" },
        parts: [{ type: "text", text: "Queued" }],
      })
      const scan = spyOn(Storage, "scan")
      try {
        expect(await SessionManager.listPendingReply(active.scope.id)).toEqual([active.id])
        expect(await SessionManager.listInterruptedCortexDelegations(active.scope.id)).toEqual([])
        expect(await SessionInbox.listRunnableSessions(active.scope.id)).toEqual([active.id])
        expect(scan.mock.calls.filter(([key]) => key[0] === "sessions")).toHaveLength(0)
      } finally {
        scan.mockRestore()
        for (const session of sessions) await Session.remove(session.id)
      }
    },
  })
})
