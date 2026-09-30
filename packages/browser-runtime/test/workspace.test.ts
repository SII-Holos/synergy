import { afterAll, afterEach, expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { BrowserWorkspace } from "../src/workspace"
import { BrowserBroker } from "../src/broker"
import { BrowserCommandService } from "../src/command-service"
import { BrowserSessionImpl } from "../src/session"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
const owner = { mode: "scope" as const, scopeID: "workspace-native", directory: null }
let restore: (() => void) | undefined
afterEach(() =>
  runtime.run(() => {
    restore?.()
    BrowserBroker.resetForTest()
  }),
)
test("session state lists all pages without starting a host", () =>
  runtime.run(() => {
    const page = {
      id: "p",
      profileId: "personal",
      url: "about:blank",
      title: "",
      isLoading: false,
      lastActiveAt: null,
      status: "suspended" as const,
    }
    expect(BrowserWorkspace.sessionStatePayload(owner, { status: "suspended", pages: [page] }, null)).toMatchObject({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      pages: [page],
      hostStatus: "detached",
    })
  }))
test("the user control route requires native authority and explicitly targets a page", () =>
  runtime.run(async () => {
    let executed = ""
    const browser = new BrowserSessionImpl(owner, async ({ id, url }) => ({
      id,
      url: url!,
      title: "",
      backend: "host",
      loading: false,
      lastActiveAt: null,
      isAlive: () => true,
      close: async () => {},
      execute: async () => {
        executed = id
        return { type: "void" }
      },
    }))
    const one = await browser.openPage({}),
      two = await browser.openPage({})
    restore = BrowserCommandService.useRuntimeForTest({ getOrCreateSession: async () => browser })
    const state: BrowserWorkspace.State = {
      directory: "home",
      owner,
      presentation: null,
      requestedPresentation: "auto",
      nativePresentation: false,
    }
    const request = {
      pageId: two.id,
      commandId: "reload",
      command: { type: "reload" as const, source: "user" as const },
    }
    await expect(BrowserWorkspace.executeControl(state, request, "http://localhost")).rejects.toMatchObject({
      code: "browser_desktop_required",
    })
    expect(executed).toBe("")
    const result = await BrowserWorkspace.executeControl(
      { ...state, nativePresentation: true },
      request,
      "http://localhost",
    )
    expect(result.status).toBe(200)
    expect(executed).toBe(two.id)
    expect(executed).not.toBe(one.id)
    await browser.dispose()
  }))
