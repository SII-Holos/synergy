import { afterEach, expect, mock, test } from "bun:test"
import { createComponent, Show } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { setupSolidSourceDOM } from "../support/solid-source-dom"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationSignOutStore } from "../../src/organization/sign-out-store"
import type { Platform } from "../../src/context/platform"

await setupSolidSourceDOM()
const connections = await import("../../src/organization/connections")
const createConnections = connections.createOrganizationConnections
const intentStores: Array<{ closed: boolean }> = []
mock.module("../../src/organization/connections", () => ({
  ...connections,
  createOrganizationConnections(input: Parameters<typeof createConnections>[0]) {
    const lifetime = { closed: false }
    intentStores.push(lifetime)
    const store: OrganizationSignOutStore = {
      async get() {
        if (lifetime.closed) throw new Error("The fixture intent store has closed")
        return undefined
      },
      async begin() {
        throw new Error("This source renderer must not initiate logout")
      },
      async remove() {
        throw new Error("This source renderer must not remove logout metadata")
      },
      close() {
        lifetime.closed = true
      },
    }
    return createConnections({ ...input, signOutStore: store })
  },
}))

const { PlatformProvider } = await import("../../src/context/platform")
const { SpaceProvider, useSpace } = await import("../../src/context/space")
const { I18nProvider } = await import("@lingui/solid")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")
const { OrganizationWorkspace } = await import("../../src/organization/workspace")
const { organizationSpaceKey } = connections
const entries: Desktop.Connection[] = ["a", "b"].map((id) => ({
  id: id.repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: `https://${id}.example`,
  clientID: "desktop",
  orgID: `org-${id}`,
  deploymentIncarnation: `deployment-${id}`,
  account: {
    accountID: `account-${id}`,
    orgID: `org-${id}`,
    loginName: id,
    displayName: `Member ${id.toUpperCase()}`,
    role: "owner",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}))
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
  expect(intentStores.every((store) => store.closed)).toBe(true)
  intentStores.length = 0
})

function changed(root: HTMLElement, predicate: () => boolean) {
  if (predicate()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!predicate()) return
      clearTimeout(timer)
      observer.disconnect()
      resolve()
    })
    const timer = setTimeout(() => {
      observer.disconnect()
      reject(new Error("The source-rendered organization state did not settle"))
    }, 1000)
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    if (predicate()) {
      clearTimeout(timer)
      observer.disconnect()
      resolve()
    }
  })
}

async function mount() {
  const previousURL = window.location.href
  const browser = window as unknown as { happyDOM: { setURL(url: string): void } }
  browser.happyDOM.setURL("https://app.example/organization/org-a/account-a/deployment-a")
  const root = document.createElement("div")
  document.body.append(root)
  const held = Promise.withResolvers<Desktop.Result<Desktop.Response>>()
  const drainedRead = Promise.withResolvers<void>()
  const reads: Desktop.Request[] = []
  const cancelled: string[] = []
  let selected: ReturnType<typeof useSpace> | undefined
  let starts = 0
  let personalFetches = 0
  const unavailable = async () => ({ ok: false as const, error: { code: "unavailable" as const } })
  const reply = (value: unknown): Desktop.Result<Desktop.Response> => ({
    ok: true,
    value: { status: 200, body: JSON.stringify(value) },
  })
  const platform: Platform = {
    platform: "web",
    openLink() {
      throw new Error("The source renderer must not open an external application")
    },
    async restart() {
      throw new Error("The source renderer must not restart an application")
    },
    async notify() {},
    fetch: Object.assign(
      async () => {
        personalFetches++
        return Response.json({ healthy: false })
      },
      { preconnect() {} },
    ),
    organization: {
      protocolVersion: (await import("@ericsanchezok/synergy-organization-protocol")).OrganizationDesktop.BridgeVersion,
      async list() {
        return { ok: true, value: entries }
      },
      async request(input) {
        reads.push(input)
        if (input.connectionID === entries[0]!.id && input.path === "/org/v1/organization") {
          try {
            return await held.promise
          } finally {
            drainedRead.resolve()
          }
        }
        if (input.path === "/org/v1/organization") return reply({ orgID: "org-b", name: "Field B", revision: 1 })
        if (input.path.includes("/invitations")) return reply({ items: [] })
        return reply({ items: [] })
      },
      async cancel(input) {
        cancelled.push(input.requestID)
        return { ok: true, value: undefined }
      },
      async startMember() {
        starts++
        return { ok: false, error: { code: "unavailable" } }
      },
      connect: unavailable,
      commandStream: unavailable,
      download: unavailable,
      signOut: unavailable,
      memberStatus: unavailable,
      projectBinding: unavailable,
      bindProject: unavailable,
      memberRequest: unavailable,
      downloadContent: unavailable,
      downloadAttachment: unavailable,
    },
  }
  const i18n = setupI18n({ locale: "en", messages: { en: {} } })
  function Content() {
    const space = useSpace()
    selected = space
    return createComponent(Show, {
      get when() {
        return space.current()
      },
      keyed: true,
      children: (_view: unknown) => createComponent(OrganizationWorkspace, { footer: null, signOut() {} }),
    })
  }
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(I18nProvider, {
            i18n,
            get children() {
              return createComponent(DialogProvider, {
                get children() {
                  return createComponent(SpaceProvider, {
                    get children() {
                      return createComponent(Content, {})
                    },
                  })
                },
              })
            },
          })
        },
      }),
    root,
  )
  let closed = false
  function close() {
    if (closed) return
    closed = true
    dispose()
    root.remove()
    browser.happyDOM.setURL(previousURL)
    held.resolve(reply({ orgID: "org-a", name: "Late A", revision: 1 }))
  }
  cleanups.push(close)
  await changed(root, () =>
    reads.some((input) => input.connectionID === entries[0]!.id && input.path === "/org/v1/organization"),
  )
  return {
    root,
    reads,
    cancelled,
    held,
    drainedRead,
    get space() {
      if (!selected) throw new Error("The real Space provider did not mount")
      return selected
    },
    starts: () => starts,
    personalFetches: () => personalFetches,
    reply,
    close,
  }
}

test("the source workspace retires an old identity before presenting another organization", async () => {
  const f = await mount()
  expect(f.root.textContent).toContain("Member A")
  expect(f.root.textContent).toContain("Projects")
  f.space.open(organizationSpaceKey(entries[1]!))
  await changed(f.root, () => f.root.querySelector("h1")?.textContent === "Field B")
  expect(f.root.textContent).toContain("Member B")
  expect(f.cancelled.length).toBeGreaterThan(0)
  f.held.resolve(f.reply({ orgID: "org-a", name: "Late A", revision: 1 }))
  await f.drainedRead.promise
  await Promise.resolve()
  await Promise.resolve()
  expect(f.root.querySelector("h1")?.textContent).toBe("Field B")
  const knowledge = [...f.root.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Knowledge and Skills",
  )
  expect(knowledge).toBeDefined()
  knowledge!.click()
  await changed(f.root, () => {
    const route = f.space.route()
    return (
      route?.kind === "organization" &&
      route.view === "knowledge" &&
      f.reads.some((request) => request.connectionID === entries[1]!.id && request.path.startsWith("/org/v1/knowledge"))
    )
  })
  expect(
    f.reads.some((request) => request.connectionID === entries[1]!.id && request.path.startsWith("/org/v1/knowledge")),
  ).toBe(true)
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})

test("disposing the real source workspace cancels its original read without starting a Runtime", async () => {
  const f = await mount()
  expect(f.space.current()?.signal.aborted).toBe(false)
  const original = f.space.current()!
  f.close()
  await f.drainedRead.promise
  expect(original.signal.aborted).toBe(true)
  expect(f.cancelled.length).toBeGreaterThan(0)
  expect(f.root.isConnected).toBe(false)
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})
