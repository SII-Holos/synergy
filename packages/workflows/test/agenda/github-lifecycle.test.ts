import { afterEach, describe, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Agenda, AgendaStore, AgendaTypes } from "../../src/agenda"
import { AgendaGithubTrigger } from "../../src/agenda/github-trigger"
import { GithubWatchPolicy } from "../../src/agenda/github-watch-policy"
import { AgendaUpdateTool } from "../../src/agenda/tools/agenda-update"

const trigger: AgendaTypes.Trigger = { type: "github", resource: "pr", repository: "owner/repo", number: 1 }

afterEach(() => AgendaGithubTrigger.stop())

describe("GitHub watch lifecycle", () => {
  test("reactivation checks credentials using the persisted triggers", async () => {
    const saved = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    const dispose = GithubWatchPolicy.register(async () => ({ enabled: true }))
    try {
      await using tmp = await tmpdir({})
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const item = await AgendaStore.create({
            title: "Resume watch",
            prompt: "check",
            triggers: [trigger],
            createdBy: "agent",
          })
          await Agenda.update(item.id, { status: "paused" }, item.origin.scope.id)
          const tool = await AgendaUpdateTool.init()
          const result = await tool.execute(
            { id: item.id, status: "active" },
            {
              sessionID: "test-session",
              messageID: "test-message",
              agent: "synergy",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            },
          )
          expect(result.metadata.reason).toBe("github_credential_missing")
          expect((await AgendaStore.get(item.origin.scope.id, item.id)).status).toBe("paused")
          expect(AgendaGithubTrigger.active().items).toBe(0)
        },
      })
    } finally {
      dispose()
      if (saved[0] === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = saved[0]
      if (saved[1] === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = saved[1]
    }
  })

  for (const status of ["cancelled", "done"] as const) {
    test(`an in-flight poll cannot overwrite ${status}`, async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const dispose = GithubWatchPolicy.register(async () => {
        entered.resolve()
        await release.promise
        return { enabled: false }
      })
      try {
        await using tmp = await tmpdir({})
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const item = await Agenda.create({
              title: "Concurrent stop",
              prompt: "check",
              triggers: [trigger],
              createdBy: "agent",
            })
            const polling = AgendaGithubTrigger.poll(AgendaGithubTrigger.entriesFor(item.id)[0]!)
            try {
              await entered.promise
              await Agenda.update(item.id, { status }, item.origin.scope.id)
            } finally {
              release.resolve()
              await polling
            }
            expect((await AgendaStore.get(item.origin.scope.id, item.id)).status).toBe(status)
            expect(AgendaGithubTrigger.active().items).toBe(0)
          },
        })
      } finally {
        release.resolve()
        dispose()
      }
    })
  }
})
