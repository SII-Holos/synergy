import { $ } from "bun"
import { describe, expect, mock, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Worktree } from "../../src/project/worktree"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionEvent } from "../../src/session/event"
import { SessionNav } from "../../src/session/nav"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"

describe("session input acceptance", () => {
  test("persists idle user input before returning an accepted response", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalRequest = SessionDrive.request
    let finishRequest: (handled: boolean) => void = () => {}
    const blockedRequest = new Promise<boolean>((resolve) => {
      finishRequest = resolve
    })
    ;(SessionDrive.request as any) = mock(() => blockedRequest)

    let sessionID = ""
    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Durable First Input" })
          sessionID = session.id
          const response = await Server.App().request(
            `/session/${session.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: "Start slowly" }] }),
            },
          )

          expect(response.status).toBe(200)
          const result = (await response.json()) as {
            status: string
            item?: { id: string; messageID: string }
          }
          expect(result.status).toBe("queued")
          const item = result.item
          expect(item?.messageID).toBeDefined()
          if (!item) throw new Error("Expected a durable inbox item")
          expect((await SessionInbox.list(session.id)).map((entry) => entry.id)).toEqual([item.id])
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
          finishRequest(true)
        },
      })
    } finally {
      finishRequest(true)
      ;(SessionDrive.request as any) = originalRequest
      if (sessionID) SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("moves accepted input to the top of recent navigation before the session drive starts", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalRequest = SessionDrive.request
    let finishRequest: (handled: boolean) => void = () => {}
    const blockedRequest = new Promise<boolean>((resolve) => {
      finishRequest = resolve
    })
    ;(SessionDrive.request as any) = mock(() => blockedRequest)

    const sessionIDs: string[] = []
    let stopUpdated = () => {}
    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const older = await Session.create({ title: "Older Session" })
          sessionIDs.push(older.id)
          await Bun.sleep(5)
          const newer = await Session.create({ title: "Newer Session" })
          sessionIDs.push(newer.id)

          const initialEntries = (await SessionNav.queryScope(scope.id, { limit: 2 })).items
          expect(initialEntries.map((entry) => entry.id)).toEqual([newer.id, older.id])
          const olderActivityAt = initialEntries.find((entry) => entry.id === older.id)?.lastActivityAt
          if (olderActivityAt === undefined) throw new Error("Expected the older session in recent navigation")
          const updates: Array<{
            info: Session.Info
            navEntry?: { id: string; lastActivityAt: number }
          }> = []
          stopUpdated = Bus.subscribe(SessionEvent.Updated, (event) => {
            if (event.properties.info.id !== older.id) return
            updates.push(event.properties as (typeof updates)[number])
          })

          await Bun.sleep(5)
          const response = await Server.App().request(
            `/session/${older.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: "Bring this session forward" }] }),
            },
          )

          expect(response.status).toBe(200)
          expect((await response.json()) as { status: string }).toMatchObject({ status: "queued" })
          const reordered = (await SessionNav.queryScope(scope.id, { limit: 2 })).items
          expect(reordered.map((entry) => entry.id)).toEqual([older.id, newer.id])
          expect(updates.at(-1)?.navEntry?.id).toBe(older.id)
          expect(updates.at(-1)?.navEntry?.lastActivityAt).toBe(reordered[0]?.lastActivityAt)
          expect(updates.at(-1)?.navEntry?.lastActivityAt).toBeGreaterThan(olderActivityAt)
          finishRequest(true)
        },
      })
    } finally {
      stopUpdated()
      finishRequest(true)
      ;(SessionDrive.request as any) = originalRequest
      for (const sessionID of sessionIDs) SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("retries an existing durable inbox item without creating a duplicate", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalRequest = SessionDrive.request
    const requests: Array<{ sessionID: string; reason: string }> = []
    ;(SessionDrive.request as any) = mock(async (sessionID: string, reason: string) => {
      requests.push({ sessionID, reason })
      return true
    })

    let sessionID = ""
    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Retry Durable Input" })
          sessionID = session.id
          const item = await SessionInbox.enqueueUser({
            sessionID,
            parts: [{ type: "text", text: "Resume this message" }],
          })

          const response = await Server.App().request(
            `/session/${sessionID}/inbox/${item.id}/retry?directory=${encodeURIComponent(scope.worktree)}`,
            { method: "POST" },
          )

          expect(response.status).toBe(200)
          expect((await response.json()) as { id: string; messageID: string }).toMatchObject({
            id: item.id,
            messageID: item.messageID,
          })
          expect((await SessionInbox.list(sessionID)).map((entry) => entry.id)).toEqual([item.id])
          expect(requests).toEqual([{ sessionID, reason: "user-input-retry" }])
        },
      })
    } finally {
      ;(SessionDrive.request as any) = originalRequest
      if (sessionID) SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("returns not found when retrying a missing inbox item", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Missing Retry Item" })
        try {
          const response = await Server.App().request(
            `/session/${session.id}/inbox/inb_missing/retry?directory=${encodeURIComponent(scope.worktree)}`,
            { method: "POST" },
          )
          expect(response.status).toBe(404)
        } finally {
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("rejects guide and withdrawal while the first task has no canonical root", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Locked First Task" })
        try {
          const item = await SessionInbox.enqueueUser({
            sessionID: session.id,
            parts: [{ type: "text", text: "Keep this root durable" }],
          })
          const path = `/session/${session.id}/inbox/${item.id}`
          const guide = await Server.App().request(`${path}/guide?directory=${encodeURIComponent(scope.worktree)}`, {
            method: "POST",
          })
          const remove = await Server.App().request(`${path}?directory=${encodeURIComponent(scope.worktree)}`, {
            method: "DELETE",
          })

          expect(guide.status).toBe(409)
          expect(remove.status).toBe(409)
          expect((await guide.json()) as { name: string }).toMatchObject({
            name: "SessionInboxFirstTaskLockedError",
          })
          expect((await remove.json()) as { name: string }).toMatchObject({
            name: "SessionInboxFirstTaskLockedError",
          })
          expect((await SessionInbox.list(session.id)).map((entry) => entry.id)).toEqual([item.id])
        } finally {
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("advances recent activity when input is queued behind a running session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Running Input" })
        const lease = SessionManager.acquire(session.id)
        if (!lease) throw new Error("Expected to acquire the session")
        await Session.update(session.id, (draft) => {
          draft.pendingReply = true
        })
        const activityBeforeInput = (await SessionNav.queryScope(scope.id, { limit: 1 })).items[0]?.lastActivityAt
        if (activityBeforeInput === undefined) throw new Error("Expected running session navigation activity")
        await Bun.sleep(5)

        try {
          const response = await Server.App().request(
            `/session/${session.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: "Queue behind the active turn" }] }),
            },
          )

          const result = (await response.json()) as { status: string; item?: { id: string } }
          expect(result.status).toBe("queued")
          const item = result.item
          if (!item) throw new Error("Expected a queued inbox item")
          expect((await SessionInbox.list(session.id)).map((entry) => entry.id)).toEqual([item.id])
          const activityAfterInput = (await SessionNav.queryScope(scope.id, { limit: 1 })).items[0]?.lastActivityAt
          expect(activityAfterInput).toBeGreaterThan(activityBeforeInput)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("preserves direct idle no-reply acceptance", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const originalInvoke = SessionInvoke.invoke
    ;(SessionInvoke.invoke as any) = mock(async () => undefined)

    let sessionID = ""
    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "No Reply Input" })
          sessionID = session.id
          const response = await Server.App().request(
            `/session/${session.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                noReply: true,
                parts: [{ type: "text", text: "Record without a reply" }],
              }),
            },
          )

          const result = (await response.json()) as { status: string; messageID?: string }
          expect(result.status).toBe("started")
          expect(result.messageID).toBeDefined()
          expect(await SessionInbox.list(session.id)).toHaveLength(0)
        },
      })
    } finally {
      ;(SessionInvoke.invoke as any) = originalInvoke
      if (sessionID) SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("rejects input before accepting it when the bound worktree was deleted externally", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Missing Worktree Input" })
        const worktree = await Worktree.create({
          sessionID: session.id,
          name: "missing-input",
          baseRef: "current",
          bind: true,
        })

        try {
          await $`git worktree remove --force ${worktree.path}`.cwd(scope.worktree).quiet()

          const response = await Server.App().request(
            `/session/${session.id}/input?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: "Continue" }] }),
            },
          )

          expect(response.status).toBe(409)
          expect(await response.json()).toEqual({
            name: "WorktreeUnavailableError",
            data: {
              message: "The worktree for this session is no longer available.",
              reason: "missing",
            },
          })
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
          expect(SessionManager.isRunning(session.id)).toBe(false)
        } finally {
          await Bun.sleep(50)
          await Worktree.remove({ sessionID: session.id, target: worktree.id, force: true }).catch(() => undefined)
          await Session.remove(session.id)
        }
      },
    })
  })
})
