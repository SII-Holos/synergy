import { afterAll, describe, expect, test } from "bun:test"
import { BrowserOwner } from "../src/owner"
import { BrowserRuntime } from "../src/runtime"
// BrowserCommandService registers the disposal executor BrowserRuntime
// depends on; load it alongside the runtime under test.
import "../src/command-service"
import { BrowserStorage } from "../src/storage"
import { CortexTypes } from "@ericsanchezok/synergy-harness/cortex/types"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

afterAll(async () => {
  await BrowserRuntime.stop()
})

describe("Browser runtime session lifecycle", () => {
  test.each(["completed", "error", "cancelled", "interrupted"] as const)(
    "releases live Browser resources when a Cortex session becomes %s",
    async (status) => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const child = await Session.create({
            parentID: parent.id,
            cortex: cortexInfo(parent.id, "running"),
          })
          const owner = sessionOwner(child)
          await BrowserStorage.save(owner, {
            status: "active",
            page: {
              id: "page-terminal-cleanup",
              url: "https://example.com/",
              title: "Terminal cleanup",
              lastActiveAt: Date.now(),
            },
            panelWidth: 400,
            timestamp: Date.now(),
            annotations: [],
          })
          const active = await BrowserRuntime.getOrCreateSession(owner)

          await Session.update(child.id, (draft) => {
            draft.cortex!.status = status
            draft.cortex!.completedAt = Date.now()
          })

          const restored = await BrowserRuntime.getOrCreateSession(owner)
          expect(restored).not.toBe(active)
          expect(restored.status).toBe("suspended")
          expect(restored.descriptor).toMatchObject({ id: "page-terminal-cleanup", url: "https://example.com/" })
          expect(await BrowserStorage.load(owner)).toMatchObject({
            status: "suspended",
            page: { id: "page-terminal-cleanup", url: "https://example.com/" },
          })
        },
      })
    },
  )

  test("keeps live Browser resources while a Cortex session is not terminal", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({
          parentID: parent.id,
          cortex: cortexInfo(parent.id, "queued"),
        })
        const owner = sessionOwner(child)
        const active = await BrowserRuntime.getOrCreateSession(owner)

        await Session.update(child.id, (draft) => {
          draft.cortex!.status = "running"
        })

        expect(await BrowserRuntime.getOrCreateSession(owner)).toBe(active)
        expect(await BrowserStorage.load(owner)).toBeNull()
      },
    })
  })
})

function sessionOwner(session: { id: string; scope: { id: string; directory: string } }): BrowserOwner.Info {
  return {
    mode: "session",
    scopeID: session.scope.id,
    directory: session.scope.directory,
    sessionID: session.id,
  }
}

function cortexInfo(parentSessionID: string, status: CortexTypes.TaskStatus) {
  return {
    taskID: `cortex-browser-${crypto.randomUUID()}`,
    parentSessionID,
    parentMessageID: Identifier.ascending("message"),
    description: "Exercise Browser lifecycle cleanup",
    agent: "developer",
    executionRole: "delegated_subagent" as const,
    startedAt: Date.now(),
    status,
  }
}
