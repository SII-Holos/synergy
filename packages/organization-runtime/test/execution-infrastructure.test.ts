import { expect, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { executionFixture } from "./support/execution"

test.each(["workspace", "environment"] as const)(
  "an accepted %s selection cannot silently execute through the native default",
  async (infrastructure) => {
    await using f = await executionFixture({ execution: true, infrastructure })
    await f.runtime.run(async () => {
      const session = await Session.get(f.sessionID)
      const queued = (await SessionInbox.peekTask(session.id))!
      expect(queued).toBeDefined()
      await expect(
        SessionExecutionSource.authorize({ sessionID: session.id, scopeID: session.scope.id }),
      ).rejects.toMatchObject({ cause: { data: { code: "RESOURCE_UNAVAILABLE" } } })
      expect(await SessionInbox.peekTask(session.id)).toEqual(queued)
      expect(await SessionExecutionOwners.latestRoot(session.id)).toBeUndefined()
      expect((await Session.get(session.id)).modelSelection).toEqual(session.modelSelection)
      await ScopeContext.provide({
        scope: session.scope,
        workspace: session.workspace,
        fn: async () => {
          expect(await Provider.list()).toEqual({})
        },
      })
      expect(f.infrastructureAllocations()).toBe(0)
    })
  },
)
