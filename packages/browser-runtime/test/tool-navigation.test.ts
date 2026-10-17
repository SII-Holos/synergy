import { afterAll, afterEach, expect, test } from "bun:test"
import { BrowserCommandService } from "../src/command-service"
import { BrowserSessionImpl } from "../src/session"
import { BrowserProfiles } from "../src/profiles"
import { BrowserControl } from "../src/control"
import type { BrowserBackendCommand, BrowserBackendResult } from "@ericsanchezok/synergy-browser-core"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
let restore: (() => void) | undefined
afterEach(() =>
  runtime.run(() => {
    restore?.()
    BrowserCommandService.clear()
  }),
)
const owner = { mode: "scope" as const, scopeID: "command-pages", directory: null }
async function setup(
  execute: (
    id: string,
    command: BrowserBackendCommand,
    agentSessionID?: string,
  ) => Promise<BrowserBackendResult> = async () => ({
    type: "void",
  }),
) {
  const session = new BrowserSessionImpl(owner, async ({ id, url }) => ({
    id,
    url: url ?? "about:blank",
    title: "",
    backend: "host",
    loading: false,
    lastActiveAt: null,
    isAlive: () => true,
    close: async () => {},
    execute: (command, agentSessionID) => execute(id, command, agentSessionID),
  }))
  const page = await session.openPage({})
  restore = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => session })
  return { session, pageId: page.id }
}
test("session identity reaches the Host and activity snapshots survive independent task completion", () =>
  runtime.run(async () => {
    const actors: Array<string | undefined> = []
    const { session, pageId } = await setup(async (_id, _command, actor) => {
      actors.push(actor)
      return { type: "void" }
    })
    await BrowserCommandService.execute(owner, {
      pageId,
      commandId: "agent",
      agentSessionID: "one",
      command: { type: "stop" },
    })
    await BrowserCommandService.execute(owner, { pageId, commandId: "human", command: { type: "stop" } })
    expect(actors).toEqual(["one", undefined])
    const one = {
      sessionID: "one",
      operationID: "one",
      pageId,
      url: "about:blank",
      kind: "reading" as const,
      tool: "browser_read",
      label: "Reading",
    }
    const two = { ...one, sessionID: "two", operationID: "two" }
    await session.notifyAgentActivity(one)
    await session.notifyAgentActivity(two)
    await session.notifyAgentActivity({ ...one, kind: "idle" })
    expect(BrowserControl.sessionState(session).agentActivities).toEqual([two, { ...one, kind: "idle" }])
    await session.closePage(pageId)
    expect(BrowserControl.sessionState(session).agentActivities).toEqual([])
  }))
test("commands deduplicate successes and failures without repeating effects", () =>
  runtime.run(async () => {
    let calls = 0
    const { pageId } = await setup(async () => {
      calls++
      return { type: "void" }
    })
    const request = { pageId, commandId: "same", command: { type: "reload" as const } }
    await Promise.all([BrowserCommandService.execute(owner, request), BrowserCommandService.execute(owner, request)])
    await BrowserCommandService.execute(owner, request)
    expect(calls).toBe(1)
    await expect(BrowserCommandService.execute(owner, { ...request, command: { type: "stop" } })).rejects.toMatchObject(
      { code: "browser_command_id_conflict" },
    )
    restore?.()
    let failures = 0
    const next = await setup(async () => {
      failures++
      throw new Error("unknown outcome")
    })
    const failure = { ...request, pageId: next.pageId }
    await expect(BrowserCommandService.execute(owner, failure)).rejects.toThrow("unknown outcome")
    await expect(BrowserCommandService.execute(owner, failure)).rejects.toThrow("unknown outcome")
    expect(failures).toBe(1)
  }))
test("activity follows dispatch, excludes queued and denied work, and retains successful viewing", () =>
  runtime.run(async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const { session, pageId } = await setup(async (_id, command) => {
      if (command.type === "reload") {
        entered()
        await blocked
      }
      if (command.type === "snapshot") throw new Error("read failed")
      return { type: "void" }
    })
    const first = BrowserCommandService.execute(owner, {
      pageId,
      agentSessionID: "one",
      commandId: "reload",
      command: { type: "reload" },
    })
    await started
    const second = BrowserCommandService.execute(owner, {
      pageId,
      agentSessionID: "two",
      commandId: "clipboard",
      command: { type: "clipboard", action: "write", text: "test" },
    })
    try {
      expect(
        session.agentActivities.map(({ sessionID, kind, operationID }) => ({ sessionID, kind, operationID })),
      ).toEqual([{ sessionID: "one", kind: "acting", operationID: "reload" }])
    } finally {
      release()
      await Promise.all([first, second])
    }
    expect(session.agentActivities.map(({ sessionID, kind }) => ({ sessionID, kind }))).toEqual([
      { sessionID: "one", kind: "idle" },
      { sessionID: "two", kind: "idle" },
    ])
    const recent = [...session.agentActivities]
    await expect(
      BrowserCommandService.execute(owner, {
        pageId,
        agentSessionID: "one",
        commandId: "failed",
        command: { type: "snapshot" },
      }),
    ).rejects.toThrow("read failed")
    await expect(
      BrowserCommandService.execute(owner, {
        pageId,
        agentSessionID: "one",
        commandId: "denied",
        command: { type: "reload" },
        authorize: async () => {
          throw new Error("denied")
        },
      }),
    ).rejects.toThrow("denied")
    await first
    expect(session.agentActivities).toEqual(recent)
  }))
test("one page serializes commands while other pages make progress", () =>
  runtime.run(async () => {
    const order: string[] = []
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, pageId } = await setup(async (id, command) => {
      order.push(`${id}:${command.type}`)
      if (command.type === "reload") {
        entered()
        await blocked
      }
      return { type: "void" }
    })
    const other = await session.openPage({})
    const first = BrowserCommandService.execute(owner, { pageId, commandId: "1", command: { type: "reload" } })
    await started
    const second = BrowserCommandService.execute(owner, { pageId, commandId: "2", command: { type: "stop" } })
    await BrowserCommandService.execute(owner, { pageId: other.id, commandId: "3", command: { type: "stop" } })
    expect(order).toEqual([`${pageId}:reload`, `${other.id}:stop`])
    release()
    await Promise.all([first, second])
    expect(order.at(-1)).toBe(`${pageId}:stop`)
  }))

test("cancelling a queued task cannot stop another task's active page operation", () =>
  runtime.run(async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const commands: string[] = []
    const { pageId } = await setup(async (_id, command) => {
      commands.push(command.type)
      if (command.type === "reload") {
        entered()
        await blocked
      }
      return { type: "void" }
    })
    const first = BrowserCommandService.execute(owner, { pageId, commandId: "one:reload", command: { type: "reload" } })
    await started
    const cancellation = new AbortController()
    const second = BrowserCommandService.execute(owner, {
      pageId,
      commandId: "two:reload",
      command: { type: "reload" },
      signal: cancellation.signal,
    })
    cancellation.abort()
    expect(commands).toEqual(["reload"])
    release()
    await first
    await expect(second).rejects.toMatchObject({ code: "browser_command_aborted" })
    expect(commands).toEqual(["reload"])
  }))
test("dialog response bypasses its blocked page command and disposal drains all pages", () =>
  runtime.run(async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, pageId } = await setup(async (_id, command) => {
      if (command.type === "reload") {
        entered()
        await waiting
      }
      if (command.type === "dialog.respond") release()
      return { type: "void" }
    })
    const active = BrowserCommandService.execute(owner, { pageId, commandId: "active", command: { type: "reload" } })
    await started
    await BrowserCommandService.execute(owner, {
      pageId,
      commandId: "answer",
      command: { type: "dialog.respond", requestId: "prompt", accept: true },
    })
    await active
    let disposed = false
    await BrowserCommandService.disposeOwner(owner, async () => {
      await session.dispose()
      disposed = true
    })
    expect(disposed).toBe(true)
  }))
test("revocation blocks cached observations and permission changes invalidate pending approval", () =>
  runtime.run(async () => {
    let calls = 0
    const { session, pageId } = await setup(async () => {
      calls++
      return { type: "void" }
    })
    const profileId = session.pages[0]!.profileId
    const request = { pageId, commandId: "cached", command: { type: "reload" as const } }
    await BrowserCommandService.execute(owner, request)
    await BrowserProfiles.update(profileId, { enabled: false })
    await expect(BrowserCommandService.execute(owner, request)).rejects.toMatchObject({
      code: "browser_profile_disabled",
    })
    await BrowserProfiles.update(profileId, { enabled: true })
    await expect(
      BrowserCommandService.execute(owner, {
        ...request,
        commandId: "pending",
        authorize: async () => {
          await BrowserProfiles.setPolicy(profileId, "https://example.com", { access: "deny" })
        },
      }),
    ).rejects.toMatchObject({ code: "browser_permission_changed" })
    expect(calls).toBe(1)
  }))
test("missing and closed pages are never implicitly reopened", () =>
  runtime.run(async () => {
    const { pageId, session } = await setup()
    await BrowserCommandService.execute(owner, { pageId, commandId: "close", command: { type: "close" } })
    await expect(
      BrowserCommandService.execute(owner, {
        pageId,
        commandId: "navigate",
        command: { type: "navigate", source: "agent", url: "example.com" },
      }),
    ).rejects.toMatchObject({ code: "browser_page_missing" })
    expect(session.pages).toEqual([])
  }))

for (const agentSessionID of [undefined, "agent"]) {
  test(`resuming a missing page rejects before host work or activity (${agentSessionID ?? "human"})`, () =>
    runtime.run(async () => {
      let calls = 0
      const { session } = await setup(async () => {
        calls++
        return { type: "void" }
      })
      await expect(
        BrowserCommandService.execute(owner, {
          pageId: "missing-page",
          commandId: "missing-resume",
          agentSessionID,
          command: { type: "resume" },
        }),
      ).rejects.toMatchObject({ code: "browser_page_missing", pageId: "missing-page", retryable: false })
      expect(calls).toBe(0)
      expect(BrowserControl.sessionState(session).agentActivities).toEqual([])
    }))
}
