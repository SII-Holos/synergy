import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { BrowserRuntime } from "../src/runtime"
import { BrowserOwner } from "../src/owner"
import { BrowserStorage } from "../src/storage"
import { BrowserToolHelper } from "../src/tools/browser-shared"
import { testRuntime } from "./support/runtime"
import { BrowserEvent } from "../src/event"
import type { BrowserPageBackend } from "../src/page"

const runtime = await testRuntime(registerLocalRuntime)
afterAll(() => runtime.close())

test("ordinary Scope browser state has no implicit Workspace and creates no task", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const owner = BrowserOwner.shared()
        const browser = await BrowserRuntime.getOrCreateSession(owner)
        expect(browser.owner).toMatchObject({ mode: "scope", workspaceID: null, directory: null })
        expect(browser.pages).toEqual([])
        expect((await Session.list()).data).toHaveLength(0)
        await BrowserRuntime.withinOwner(owner, async () => {
          expect(ScopeContext.current.workspace).toBeNull()
        })
      },
    })
  }))

test("two tasks resolve the same shared page while historical pages keep their owner", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const one = await Session.create({})
        const two = await Session.create({})
        const shared = BrowserOwner.shared()
        await BrowserStorage.save(shared, {
          timestamp: 1,
          pages: [
            {
              id: "shared-page",
              url: "https://example.com",
              title: "Shared",
              profileId: "personal",
              status: "suspended",
              isLoading: false,
              lastActiveAt: 1,
            },
          ],
        })
        const context = (sessionID: string) => ({
          sessionID,
          messageID: "same-message",
          callID: "same-call",
          agent: "synergy",
          abort: new AbortController().signal,
          extra: {},
          metadata() {},
          async ask() {},
        })
        expect(await BrowserToolHelper.resolveOwner(context(one.id), "shared-page")).toEqual(shared)
        expect(await BrowserToolHelper.resolveOwner(context(two.id), "shared-page")).toEqual(shared)
        expect(BrowserToolHelper.operationID(context(one.id), "reload")).not.toBe(
          BrowserToolHelper.operationID(context(two.id), "reload"),
        )
        const historical = BrowserOwner.fromToolContext(context(one.id))
        await BrowserStorage.save(historical, {
          timestamp: 1,
          pages: [
            {
              id: "old-page",
              url: "https://example.org",
              title: "Old",
              profileId: "personal",
              status: "suspended",
              isLoading: false,
              lastActiveAt: 1,
            },
          ],
        })
        expect(await BrowserToolHelper.resolveOwner(context(one.id), "old-page")).toMatchObject({
          mode: "session",
          sessionID: one.id,
        })
        await expect(BrowserToolHelper.resolveOwner(context(two.id), "old-page")).rejects.toMatchObject({
          code: "browser_page_missing",
        })
      },
    })
  }))

test("cancelling a task preserves its original failure and clears only its own activity", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const task = await Session.create({}),
          owner = BrowserOwner.shared()
        await BrowserStorage.save(owner, {
          timestamp: 1,
          pages: [
            {
              id: "activity-page",
              url: "https://example.com",
              title: "Shared",
              profileId: "personal",
              status: "suspended",
              isLoading: false,
              lastActiveAt: 1,
            },
          ],
        })
        const controller = new AbortController()
        const ctx = {
          sessionID: task.id,
          messageID: "message",
          callID: "call",
          agent: "synergy",
          abort: controller.signal,
          extra: {},
          metadata() {},
          async ask() {},
        }
        const page: BrowserPageBackend = {
          id: "activity-page",
          url: "https://example.com",
          title: "Shared",
          backend: "host",
          loading: false,
          lastActiveAt: 1,
          isAlive: () => true,
          close: async () => {},
          execute: async () => ({ type: "void" }),
        }
        const events: string[] = []
        const unsubscribe = BrowserEvent.subscribe(owner, (event) => {
          if (event.type === "agent.activity") events.push(event.kind)
        })
        const failure = new Error("Original task failure")
        try {
          await expect(
            BrowserToolHelper.withActivity(ctx, page, "acting", "browser_action", "Acting", async () => {
              controller.abort()
              throw failure
            }),
          ).rejects.toBe(failure)
          expect(events).toEqual(["acting", "idle"])
        } finally {
          unsubscribe()
        }
      },
    })
  }))
