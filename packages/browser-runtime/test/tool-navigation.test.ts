import { afterAll, afterEach, expect, test } from "bun:test"
import { BrowserCommandService } from "../src/command-service"
import { BrowserSessionImpl } from "../src/session"
import { BrowserProfiles } from "../src/profiles"
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
  execute: (id: string, command: BrowserBackendCommand) => Promise<BrowserBackendResult> = async () => ({
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
    execute: (command) => execute(id, command),
  }))
  const page = await session.openPage({})
  restore = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => session })
  return { session, pageId: page.id }
}
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
