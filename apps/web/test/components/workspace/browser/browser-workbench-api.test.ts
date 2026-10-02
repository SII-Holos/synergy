import { expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type { BrowserNativeViewBridge } from "../../../../src/context/platform"
import {
  browserWorkbenchAccess,
  closeBrowserWorkbenchPage,
  openBrowserWorkbenchPage,
} from "../../../../src/components/workspace/browser/browser-workbench-api"

const route = {
  mode: "session" as const,
  sessionID: "session-one",
  path_directory: "home",
  query_directory: "/fixture/project",
  scopeID: "scope-one",
}

test("a new shared page uses Scope authority without a conversation request", async () => {
  const input = fixture((request) =>
    new URL(request.url).pathname.endsWith("/pages")
      ? Response.json({ id: "shared-page", url: "about:blank", title: "" })
      : Response.json({ ownerKey: "canonical-scope" }),
  )
  const shared = { mode: "scope" as const, path_directory: "home", scopeID: "scope-one" }
  const tab = await openBrowserWorkbenchPage({ ...input, route: shared })
  expect(input.requests).toHaveLength(2)
  expect(input.requests.every((request) => new URL(request.url).pathname.includes("/browser/"))).toBe(true)
  for (const request of input.requests) {
    expect(new URL(request.url).searchParams.get("mode")).toBe("scope")
    expect(new URL(request.url).searchParams.has("sessionID")).toBe(false)
  }
  expect(tab.state).toMatchObject({
    browserRoute: { mode: "scope", ownerKey: "canonical-scope", serverUrl: input.serverUrl },
  })
})

test("manual recovery resumes the most recent page without creating another page", async () => {
  const input = fixture((request) =>
    request.method === "GET"
      ? Response.json({
          ownerKey: "owner-one",
          pages: [
            { id: "older", url: "https://example.org", title: "Older", status: "suspended", lastActiveAt: 1 },
            { id: "recent", url: "https://example.com", title: "Recent", status: "suspended", lastActiveAt: 2 },
          ],
        })
      : Response.json({
          type: "control.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          result: {
            type: "page",
            page: { id: "recent", url: "https://example.com", title: "Recent", status: "active" },
          },
        }),
  )
  const tab = await openBrowserWorkbenchPage({ ...input, restore: true })
  expect(tab.resourceId).toBe("recent")
  expect(input.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(await input.requests[1]!.json()).toMatchObject({ pageId: "recent", command: { type: "resume" } })
})

function fixture(respond: (request: Request) => Response = () => Response.json({ ownerKey: "owner-one" })) {
  const requests: Request[] = []
  const tickets: Parameters<BrowserNativeViewBridge["createPresentationTicket"]>[0][] = []
  const client = createSynergyClient({
    baseUrl: "http://browser.test",
    headers: { Authorization: "Bearer fixture-token" },
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        requests.push(request.clone())
        return respond(request)
      },
      { preconnect() {} },
    ),
  })
  const unused = async () => {
    throw new Error("Page presentation is not part of workbench access")
  }
  const bridge: BrowserNativeViewBridge = {
    attachView: unused,
    detachView: unused,
    focusView: unused,
    resizeView: unused,
    retryPage: unused,
    presentationCapability: unused,
    createPresentationTicket: async (input) => {
      tickets.push(input)
      return { ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION, ticket: "native-ticket" }
    },
  }
  return { client, bridge, route, serverUrl: "http://browser.test", requests, tickets }
}

test("workbench access binds the native ticket to the server owner and preserves the task route", async () => {
  const input = fixture()
  expect(await browserWorkbenchAccess(input)).toEqual({
    ...route,
    ownerKey: "owner-one",
    serverUrl: input.serverUrl,
    presentation: "native",
    nativeTicket: "native-ticket",
  })
  const request = input.requests[0]!
  expect(request.headers.get("Authorization")).toBe("Bearer fixture-token")
  const url = new URL(request.url)
  expect(url.pathname).toBe("/home/browser/session")
  expect(Object.fromEntries(url.searchParams)).toEqual({
    directory: route.query_directory,
    scopeID: route.scopeID,
    mode: "session",
    sessionID: route.sessionID,
    presentation: "auto",
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
  })
  expect(input.tickets).toEqual([
    { protocolVersion: BROWSER_PROTOCOL_VERSION, serverUrl: input.serverUrl, ownerKey: "owner-one" },
  ])
})

test("opening a page returns its peer tab and closing targets that page with native authority", async () => {
  const input = fixture((request) => {
    if (new URL(request.url).pathname.endsWith("/pages"))
      return Response.json({ id: "page-new", title: "", url: "about:blank" })
    return Response.json({ ownerKey: "owner-one" })
  })
  expect(await openBrowserWorkbenchPage(input)).toEqual({
    id: 'browser:["http://browser.test","owner-one"]:page-new',
    panelId: "browser",
    resourceId: "page-new",
    title: "about:blank",
    state: { browserRoute: { ...route, ownerKey: "owner-one", serverUrl: input.serverUrl }, browserURL: "about:blank" },
    source: '["http://browser.test","owner-one"]',
  })
  await closeBrowserWorkbenchPage({ ...input, pageId: "page-new" })
  const mutations = input.requests.filter((request) => request.method === "POST")
  expect(mutations).toHaveLength(2)
  for (const request of mutations) {
    const query = new URL(request.url).searchParams
    expect(query.get("sessionID")).toBe(route.sessionID)
    expect(query.get("directory")).toBe(route.query_directory)
    expect(query.get("scopeID")).toBe(route.scopeID)
    expect(query.get("presentation")).toBe("native")
    expect(query.get("nativeTicket")).toBe("native-ticket")
  }
  const opened = await mutations[0]!.json()
  const closed = await mutations[1]!.json()
  expect(opened).toEqual({ requestId: expect.any(String), url: "about:blank" })
  expect(closed).toEqual({
    commandId: expect.any(String),
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    pageId: "page-new",
    command: { type: "close" },
  })
  expect(closed.commandId).not.toBe(opened.requestId)
})

test("a missing bridge or descriptor stops before granting native access", async () => {
  const input = fixture(() => new Response(null, { status: 204 }))
  await expect(browserWorkbenchAccess({ ...input, bridge: undefined })).rejects.toThrow("Desktop")
  expect(input.requests).toHaveLength(0)
  await expect(browserWorkbenchAccess(input)).rejects.toThrow("Browser state could not be loaded")
  expect(input.tickets).toHaveLength(0)
})

test("native ticket rejection retains structured diagnostics and cannot mutate a page", async () => {
  const input = fixture()
  const error = { code: "browser_native_ticket_rejected" as const, message: "Expired ticket", retryable: true }
  input.bridge.createPresentationTicket = async () => ({ ok: false, protocolVersion: BROWSER_PROTOCOL_VERSION, error })
  await expect(openBrowserWorkbenchPage(input)).rejects.toEqual(error)
  expect(input.requests.map((request) => request.method)).toEqual(["GET"])
})

test("an empty open response cannot create a phantom peer tab", async () => {
  const input = fixture((request) =>
    request.method === "GET" ? Response.json({ ownerKey: "owner-one" }) : new Response(null, { status: 204 }),
  )
  await expect(openBrowserWorkbenchPage(input)).rejects.toThrow("Page could not be opened")
})

test("server rejections preserve their error instead of being treated as successful close", async () => {
  const error = { name: "BrowserPageError", data: { code: "page_closed", message: "Page is closed" } }
  const input = fixture((request) =>
    request.method === "GET" ? Response.json({ ownerKey: "owner-one" }) : Response.json(error, { status: 409 }),
  )
  await expect(closeBrowserWorkbenchPage({ ...input, pageId: "page-old" })).rejects.toEqual(error)
})
