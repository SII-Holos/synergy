import { expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, type BrowserProfile } from "@ericsanchezok/synergy-browser-core"
import { createBrowserDataContext } from "../../../../src/components/workspace/browser/browser-data-context"

const profile: BrowserProfile = {
  id: "personal",
  kind: "persistent",
  enabled: true,
  revision: 1,
  name: "Personal",
  createdAt: 1,
  origins: {},
}
test("management context captures profile, releases on abort and never opens a page", async () => {
  const calls: string[] = [],
    native: unknown[] = []
  const controller = new AbortController()
  let tickets = 0
  const context = await createBrowserDataContext({
    client: {
      browser: {
        session: async () => ({ data: { ownerKey: "scope:home:scope", pages: [] } }),
        dataContext: async (input: unknown) => {
          calls.push("context")
          expect(input).toMatchObject({ browserDataContextInput: { profileId: "personal" } })
          return { data: { contextId: "context", profile } }
        },
        releaseDataContext: async (input: { nativeTicket: string }) => {
          expect(input.nativeTicket).toBe("ticket-2")
          calls.push("release")
          return { data: true }
        },
      },
    } as never,
    bridge: {
      createPresentationTicket: async () => ({
        ok: true,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ticket: `ticket-${++tickets}`,
      }),
      profileDataAction: async (input) => {
        native.push(input)
        return { type: "done" }
      },
    },
    serverUrl: "http://fixture.test",
    scopeID: "home",
    profileId: "personal",
    current: () => true,
    signal: controller.signal,
  })
  await context.action({ type: "deletePassword", id: "login" })
  expect(native).toEqual([
    {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      contextId: "context",
      action: { type: "deletePassword", id: "login" },
    },
  ])
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(context.current()).toBe(false)
  expect(calls).toEqual(["context", "release"])
  expect(tickets).toBe(2)
})

test("removal closes native context and cancels imports with zero further owner requests", async () => {
  let current = true,
    requests = 0
  const native: string[] = [],
    controller = new AbortController()
  const context = await createBrowserDataContext({
    client: {
      browser: {
        session: async () => {
          requests++
          return { data: { ownerKey: "scope:home:scope", pages: [] } }
        },
        dataContext: async () => {
          requests++
          return { data: { contextId: "context", profile } }
        },
        releaseDataContext: async () => {
          requests++
          return { data: true }
        },
      },
    } as never,
    bridge: {
      createPresentationTicket: async () => ({ ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION, ticket: "ticket" }),
      profileDataAction: async ({ action }) => {
        native.push(action.type)
        return { type: "done" }
      },
    },
    serverUrl: "http://fixture.test",
    scopeID: "home",
    current: () => current,
    signal: controller.signal,
  })
  const before = requests
  current = false
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toBe(before)
  expect(native).toEqual(["closeContext"])
  await expect(Promise.resolve().then(() => context.action({ type: "state" }))).rejects.toThrow()
})

test("a failed native close does not skip backend context release with its fresh ticket", async () => {
  let releases = 0,
    tickets = 0
  const context = await createBrowserDataContext({
    client: {
      browser: {
        session: async () => ({ data: { ownerKey: "scope:home:scope", pages: [] } }),
        dataContext: async () => ({ data: { contextId: "context", profile } }),
        releaseDataContext: async () => {
          releases++
          return { data: true }
        },
      },
    } as never,
    bridge: {
      createPresentationTicket: async () => ({
        ok: true,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ticket: `ticket-${++tickets}`,
      }),
      profileDataAction: async () => {
        throw new Error("Desktop disconnected before close")
      },
    },
    serverUrl: "http://fixture.test",
    scopeID: "home",
    current: () => true,
    signal: new AbortController().signal,
  })
  await expect(context.release()).rejects.toThrow("Desktop disconnected before close")
  expect(releases).toBe(1)
  expect(tickets).toBe(2)
})
