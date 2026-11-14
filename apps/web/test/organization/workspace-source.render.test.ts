import { afterEach, expect, mock, test } from "bun:test"
import { createComponent, Show } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { OrganizationApiTokenProtocol as SourceToken } from "@ericsanchezok/synergy-organization-protocol"
import { Persist as SourceTokenPersist } from "../../src/utils/persist"
import { z } from "zod"
import type {
  OrgProjectView,
  OrgAccount,
  OrgKnowledgeItem,
  OrgKnowledgeRelease,
} from "@ericsanchezok/synergy-sdk/organization"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
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

function changed(root: HTMLElement, predicate: () => boolean, stage = "organization") {
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
      reject(new Error(`The source-rendered organization state did not settle: ${stage}`))
    }, 1000)
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    if (predicate()) {
      clearTimeout(timer)
      observer.disconnect()
      resolve()
    }
  })
}

type SourceRequest = (input: Desktop.Request) => Promise<Desktop.Result<Desktop.Response> | undefined>
async function mount(input: { request?: SourceRequest; holdOrganization?: boolean; path?: string } = {}) {
  const sourceRequest = input.request
  const holdOrganization = input.holdOrganization ?? true
  const previousURL = window.location.href
  const browser = window as unknown as { happyDOM: { setURL(url: string): void } }
  browser.happyDOM.setURL(`https://app.example/organization/org-a/account-a/deployment-a${input.path ?? ""}`)
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
        const supplied = await sourceRequest?.(input)
        if (supplied) return supplied
        if (holdOrganization && input.connectionID === entries[0]!.id && input.path === "/org/v1/organization") {
          try {
            return await held.promise
          } finally {
            drainedRead.resolve()
          }
        }
        if (input.path === "/org/v1/organization")
          return input.connectionID === entries[0]!.id
            ? reply({ orgID: "org-a", name: "Field A", revision: 7 })
            : reply({ orgID: "org-b", name: "Field B", revision: 1 })
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

function response(body: unknown, status = 200): Desktop.Result<Desktop.Response> {
  return { ok: true, value: { status, body: JSON.stringify(body) } }
}
function requestBody(request: Desktop.Request): unknown {
  if (!request.body) throw new Error("The generated SDK did not send its request body")
  return JSON.parse(request.body)
}
function button(root: ParentNode, label: string) {
  const value = [...root.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)
  if (!value) throw new Error(`The source UI did not render ${label}`)
  return value
}
function field(root: ParentNode, label: string, value: string) {
  const element = [...root.querySelectorAll("label")].find((node) => node.textContent?.trim() === label)
  const id = element?.getAttribute("for")
  const target = id ? document.getElementById(id) : undefined
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement))
    throw new Error(`The source UI did not render the ${label} field`)
  target.value = value
  target.dispatchEvent(new Event("input", { bubbles: true }))
  return target
}
function inputValue(root: ParentNode, contains: string) {
  return [...root.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value.includes(contains))
}
function submit(form: HTMLFormElement | null) {
  if (!form) throw new Error("The source UI did not render its form")
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}
async function choose(root: ParentNode, label: string, option: string) {
  const trigger = [...root.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.getAttribute("aria-label")?.startsWith(`${label}: `),
  )
  if (!trigger) throw new Error(`The source UI did not render the ${label} choice`)
  await changed(document.body, () => !trigger.disabled, `choice:${label}:enabled`)
  trigger.click()
  const listbox = () =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].find(
      (node) => node.getAttribute("aria-label") === label,
    )
  const selected = () =>
    [...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (node) => node.textContent?.trim() === option && node.getAttribute("aria-disabled") !== "true",
    )
  await changed(document.body, () => !!selected(), `choice:${label}:${option}`)
  const item = selected()
  if (!item) throw new Error(`The source UI did not render the ${option} option`)
  item.click()
  listbox()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await changed(
    document.body,
    () => !trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true",
    `choice:${label}:closed`,
  )
}
async function confirmation(label: string) {
  const current = () => {
    for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
      const buttons = [...dialog.querySelectorAll("button")]
      const accept = buttons.find((node) => node.textContent?.trim() === label && !node.disabled)
      const cancel = buttons.find((node) => node.textContent?.trim() === "Cancel" && !node.disabled)
      if (accept && cancel) return { dialog, accept, cancel }
    }
  }
  await changed(document.body, () => !!current(), `confirmation:${label}:ready`)
  const controls = current()
  if (!controls) throw new Error(`The source confirmation did not render its ${label} and Cancel actions`)
  return controls
}
const originalProject: OrgProjectView = {
  projectID: "project-one",
  orgID: "org-a",
  name: "Field notes",
  description: "Keep the reviewed description",
  state: "active",
  revision: 3,
  createdAt: 1,
  role: "maintainer",
  permissions: { read: true, manage: true, execute: true },
}
const colleague: OrgAccount = {
  accountID: "account-colleague",
  orgID: "org-a",
  displayName: "Field colleague",
  loginName: "colleague",
  role: "member",
  state: "active",
  revision: 4,
  authRevision: 2,
  createdAt: 1,
}
const policy: OrgKnowledgeItem = {
  itemID: "field-policy",
  orgID: "org-a",
  scope: { kind: "organization" },
  kind: "material",
  title: "Reviewed field policy",
  authorID: "account-a",
  state: "published",
  revision: 6,
  latestVersion: 2,
  createdAt: 1,
  updatedAt: 2,
}
const policyVersions: OrgKnowledgeRelease[] = [2, 1].map((version) => ({
  itemID: policy.itemID,
  orgID: policy.orgID,
  scope: policy.scope,
  kind: policy.kind,
  title: policy.title,
  version,
  authorID: "account-a",
  author: { accountID: "account-a", displayName: "Policy author", loginName: "author" },
  publishedAt: version,
  manifestHash: String(version).repeat(64),
  fileCount: 1,
  totalBytes: new TextEncoder().encode("Reviewed policy bytes").length,
}))

test("the source project editor preserves canonical revisions through create, edit, archive and restore", async () => {
  const writes: Desktop.Request[] = []
  let project = originalProject
  const f = await mount({
    holdOrganization: false,
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (url.pathname === "/org/v1/projects" && input.method === "GET") return response({ items: [] })
      if (url.pathname === "/org/v1/projects" && input.method === "POST") {
        writes.push(input)
        project = { ...originalProject, name: "Reviewed project", description: "Keep all notes" }
        return response(project)
      }
      if (url.pathname !== "/org/v1/projects/project-one") return
      if (input.method === "PATCH") {
        writes.push(input)
        const change = z
          .strictObject({
            expectedRevision: z.number(),
            name: z.string().optional(),
            description: z.string().optional(),
            state: z.enum(["active", "archived"]).optional(),
          })
          .parse(requestBody(input))
        const { expectedRevision: _, ...values } = change
        project = { ...project, ...values, revision: project.revision + 1 }
      }
      return response(project)
    },
  })
  button(f.root, "Create project").click()
  field(f.root, "Project name", "  Reviewed project  ")
  field(f.root, "Description", "Keep all notes")
  submit(f.root.querySelector<HTMLFormElement>("form.organization-editor"))
  await changed(f.root, () => f.root.querySelector("h2")?.textContent === "Reviewed project")
  expect(requestBody(writes[0]!)).toEqual({ name: "Reviewed project", description: "Keep all notes" })
  button(f.root, "Edit project").click()
  field(f.root, "Project name", "Updated project")
  field(f.root, "Description", "Keep all notes and the review")
  submit(f.root.querySelector<HTMLFormElement>("form.organization-editor"))
  await changed(f.root, () => f.root.querySelector("h2")?.textContent === "Updated project")
  expect(requestBody(writes[1]!)).toEqual({
    expectedRevision: 3,
    name: "Updated project",
    description: "Keep all notes and the review",
  })
  button(f.root, "Archive project").click()
  const archived = await confirmation("Archive project")
  expect(writes).toHaveLength(2)
  archived.cancel.click()
  expect(writes).toHaveLength(2)
  expect(project.state).toBe("active")
  button(f.root, "Archive project").click()
  ;(await confirmation("Archive project")).accept.click()
  await changed(f.root, () => f.root.textContent?.includes("Restore project") === true)
  expect(requestBody(writes[2]!)).toEqual({ expectedRevision: 4, state: "archived" })
  button(f.root, "Restore project").click()
  ;(await confirmation("Restore project")).accept.click()
  await changed(f.root, () => f.root.textContent?.includes("Archive project") === true)
  expect(requestBody(writes[3]!)).toEqual({ expectedRevision: 5, state: "active" })
  expect(project.description).toBe("Keep all notes and the review")
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})

test("a rejected source project edit retains the draft and a cancelled old identity cannot navigate the new Space", async () => {
  const pending = Promise.withResolvers<Desktop.Result<Desktop.Response>>()
  const observed = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  const writes: Desktop.Request[] = []
  const f = await mount({
    holdOrganization: false,
    path: "/projects/project-one",
    async request(input) {
      if (input.path === "/org/v1/projects/project-one") {
        if (input.method === "PATCH") {
          writes.push(input)
          if (writes.length === 1) return response({ code: "REVISION_CONFLICT" }, 409)
          observed.resolve()
          try {
            return await pending.promise
          } finally {
            drained.resolve()
          }
        }
        return response(originalProject)
      }
    },
  })
  await changed(f.root, () => f.root.querySelector("h2")?.textContent === originalProject.name)
  button(f.root, "Edit project").click()
  const name = field(f.root, "Project name", "Unsubmitted review")
  const description = field(f.root, "Description", "The draft must survive a conflict")
  submit(f.root.querySelector<HTMLFormElement>("form.organization-editor"))
  await changed(f.root, () => !!f.root.querySelector('[role="alert"]'))
  expect(name.value).toBe("Unsubmitted review")
  expect(description.value).toBe("The draft must survive a conflict")
  expect(f.root.querySelector("h2")?.textContent).toBe(originalProject.name)
  submit(f.root.querySelector<HTMLFormElement>("form.organization-editor"))
  await observed.promise
  const oldOwner = f.space.current()!
  f.space.open(organizationSpaceKey(entries[1]!))
  await changed(f.root, () => f.root.querySelector("h1")?.textContent === "Field B")
  expect(oldOwner.signal.aborted).toBe(true)
  expect(f.cancelled).toContain(writes[1]!.requestID)
  pending.resolve(response({ ...originalProject, name: "Late old review", revision: 4 }))
  await drained.promise
  await Promise.resolve()
  await Promise.resolve()
  expect(f.root.querySelector<HTMLFormElement>("form.organization-editor")).toBeNull()
  const identity = f.space.current()?.identity
  if (identity?.kind !== "organization") throw new Error("The second organization did not become current")
  expect(identity.orgID).toBe("org-b")
  expect(f.root.textContent).not.toContain("Late old review")
  expect(writes.map(requestBody)).toEqual([
    { expectedRevision: 3, name: "Unsubmitted review", description: "The draft must survive a conflict" },
    { expectedRevision: 3, name: "Unsubmitted review", description: "The draft must survive a conflict" },
  ])
  expect(f.starts()).toBe(0)
})

test("the source member actions keep invitations private and confirmations bound to the reviewed account revision", async () => {
  const writes: Desktop.Request[] = []
  let account = colleague
  const f = await mount({
    holdOrganization: false,
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (url.pathname === "/org/v1/accounts") return response({ items: [account] })
      if (input.method === "POST" && url.pathname === "/org/v1/invites") {
        writes.push(input)
        return response({ token: "a".repeat(64), expiresAt: 2_000_000_000_000 })
      }
      if (url.pathname === "/org/v1/accounts/account-colleague/reset") {
        writes.push(input)
        return response({ token: "b".repeat(64), expiresAt: 2_000_000_000_000 })
      }
      if (input.method === "PATCH" && url.pathname === "/org/v1/accounts/account-colleague") {
        writes.push(input)
        account = { ...account, state: "removed", revision: 5 }
        return response(account)
      }
    },
  })
  button(f.root, "Members").click()
  await changed(f.root, () => f.root.textContent?.includes(colleague.displayName) === true, "members:listed")
  button(f.root, "Invite member").click()
  await choose(f.root, "Invitation role", "Administrator")
  button(f.root.querySelector(".organization-editor")!, "Invite member").click()
  await changed(f.root, () => !!inputValue(f.root, "invite="))
  const link = inputValue(f.root, "invite=")!
  expect(link.value).toBe(`https://a.example/organization.html#invite=${"a".repeat(64)}`)
  expect(requestBody(writes[0]!)).toEqual({ role: "admin" })
  button(f.root.querySelector(".organization-editor")!, "Cancel").click()
  expect(link.isConnected).toBe(false)
  button(f.root, "Reset password").click()
  ;(await confirmation("Create reset link")).accept.click()
  await changed(f.root, () => !!inputValue(f.root, "reset="))
  expect(inputValue(f.root, "reset=")?.value).toBe(`https://a.example/organization.html#reset=${"b".repeat(64)}`)
  expect(requestBody(writes[1]!)).toEqual({ expectedRevision: 4 })
  button(f.root, "Done").click()
  button(f.root, "Remove member").click()
  const remove = await confirmation("Remove member")
  remove.cancel.click()
  expect(writes).toHaveLength(2)
  button(f.root, "Remove member").click()
  ;(await confirmation("Remove member")).accept.click()
  await changed(
    f.root,
    () => f.root.querySelector(".organization-member-list")?.textContent?.includes("Removed") === true,
  )
  expect(requestBody(writes[2]!)).toEqual({ expectedRevision: 4, state: "removed" })
  expect(inputValue(f.root, "reset=")).toBeUndefined()
  expect(f.starts()).toBe(0)
})

test("a denied source member mutation clears privileged rows and links before another identity is opened", async () => {
  const writes: Desktop.Request[] = []
  const f = await mount({
    holdOrganization: false,
    path: "/members",
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (input.connectionID !== entries[0]!.id) return
      if (url.pathname === "/org/v1/accounts") return response({ items: [colleague] })
      if (input.method === "POST" && url.pathname === "/org/v1/invites")
        return response({ token: "a".repeat(64), expiresAt: 2_000_000_000_000 })
      if (input.method === "PATCH") {
        writes.push(input)
        return response({ code: "PERMISSION_DENIED" }, 403)
      }
    },
  })
  await changed(f.root, () => f.root.textContent?.includes(colleague.displayName) === true, "members:listed")
  button(f.root, "Invite member").click()
  button(f.root.querySelector(".organization-editor")!, "Invite member").click()
  await changed(f.root, () => !!inputValue(f.root, "invite="))
  await choose(f.root, "Role: Field colleague", "Administrator")
  await changed(
    f.root,
    () => !f.root.querySelector(".organization-member-list") && !!f.root.querySelector('[role="alert"]'),
  )
  expect(writes).toHaveLength(1)
  expect(requestBody(writes[0]!)).toEqual({ expectedRevision: 4, role: "admin" })
  expect(inputValue(f.root, "invite=")).toBeUndefined()
  expect([...f.root.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Invite member")).toBe(
    false,
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  f.space.open(organizationSpaceKey(entries[1]!))
  await changed(f.root, () => f.root.querySelector("h1")?.textContent === "Field B")
  expect(f.root.textContent).not.toContain(colleague.displayName)
  expect(f.root.textContent).not.toContain("a".repeat(64))
  expect(writes.every((request) => request.connectionID === entries[0]!.id)).toBe(true)
})

test("source project membership uses the current project revision and cancelling discovery does not add a member", async () => {
  const writes: Desktop.Request[] = []
  let revision = 3
  let members: Array<{
    accountID: string
    displayName: string
    loginName: string
    state: "active"
    role: "reader" | "collaborator" | "maintainer"
  }> = []
  const f = await mount({
    holdOrganization: false,
    path: "/projects/project-one/members",
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (url.pathname === "/org/v1/projects/project-one") return response({ ...originalProject, revision })
      if (url.pathname === "/org/v1/projects/project-one/members")
        return response({ items: members, projectRevision: revision })
      if (url.pathname === "/org/v1/projects/project-one/member-candidates")
        return response({
          items: [
            {
              accountID: colleague.accountID,
              displayName: colleague.displayName,
              loginName: colleague.loginName,
              state: colleague.state,
            },
          ],
          projectRevision: revision,
        })
      if (url.pathname === "/org/v1/projects/project-one/members/account-colleague" && input.method === "PUT") {
        writes.push(input)
        const change = z
          .strictObject({
            expectedRevision: z.number(),
            role: z.enum(["reader", "collaborator", "maintainer"]).nullable(),
          })
          .parse(requestBody(input))
        revision++
        members =
          change.role === null
            ? []
            : [
                {
                  accountID: colleague.accountID,
                  displayName: colleague.displayName,
                  loginName: colleague.loginName,
                  state: "active",
                  role: change.role,
                },
              ]
        return response({ ...originalProject, revision })
      }
    },
  })
  await changed(
    f.root,
    () => f.root.textContent?.includes("No project roles assigned") === true,
    "project-members:empty",
  )
  button(f.root, "Add project member").click()
  await changed(f.root, () => f.root.textContent?.includes(colleague.displayName) === true, "members:listed")
  button(f.root, "Add project member").click()
  expect(f.root.querySelector(".organization-publication-detail")).toBeNull()
  expect(writes).toHaveLength(0)
  button(f.root, "Add project member").click()
  await changed(f.root, () => f.root.textContent?.includes(colleague.displayName) === true, "members:listed")
  await choose(f.root, "Role", "Collaborator")
  const discovery = f.root.querySelector(".organization-publication-detail")!
  button(discovery, "Add project member").click()
  await changed(
    f.root,
    () => writes.length === 1 && !!f.root.querySelector('button[aria-label^="Role: Field colleague: "]'),
    "project-members:added",
  )
  expect(requestBody(writes[0]!)).toEqual({ expectedRevision: 3, role: "collaborator" })
  await choose(f.root, "Role: Field colleague", "Maintainer")
  await changed(
    f.root,
    () =>
      writes.length === 2 &&
      f.root.querySelector('button[aria-label^="Role: Field colleague: "]')?.textContent?.includes("Maintainer") ===
        true,
    "project-members:promoted",
  )
  expect(requestBody(writes[1]!)).toEqual({ expectedRevision: 4, role: "maintainer" })
  await changed(f.root, () => !button(f.root, "Remove from project").disabled)
  button(f.root, "Remove from project").click()
  ;(await confirmation("Remove from project")).accept.click()
  await changed(
    f.root,
    () => f.root.textContent?.includes("No project roles assigned") === true,
    "project-members:empty",
  )
  expect(requestBody(writes[2]!)).toEqual({ expectedRevision: 5, role: null })
  expect(f.starts()).toBe(0)
})

test("source knowledge keeps fixed versions and verifies preview bytes before displaying them", async () => {
  const bytes = new TextEncoder().encode("Reviewed policy bytes")
  const reads: Desktop.Request[] = []
  let withdrawn = false
  const writes: Desktop.Request[] = []
  const f = await mount({
    holdOrganization: false,
    path: "/knowledge",
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (url.pathname === "/org/v1/knowledge") return response({ items: withdrawn ? [] : [policy] })
      if (url.pathname === "/org/v1/knowledge/field-policy/versions") return response({ items: policyVersions })
      if (url.pathname.endsWith("/files")) {
        const older = url.pathname.includes("/versions/1/")
        return response({
          items: [
            {
              path: "policy.txt",
              fileID: older ? "b".repeat(64) : "a".repeat(64),
              bytes: bytes.length,
              mediaType: "text/plain",
              sha256: older ? "0".repeat(64) : bytesToHex(sha256(bytes)),
            },
          ],
        })
      }
      if (url.pathname.endsWith("/content")) {
        reads.push(input)
        return {
          ok: true,
          value: {
            status: 206,
            bodyBytes: bytes,
            contentType: "text/plain",
            contentRange: `bytes 0-${bytes.length - 1}/${bytes.length}`,
          },
        }
      }
      if (url.pathname === "/org/v1/knowledge/field-policy" && input.method === "DELETE") {
        writes.push(input)
        withdrawn = true
        return response({ ...policy, state: "withdrawn", revision: 7 })
      }
    },
  })
  await changed(f.root, () => !!f.root.querySelector(".organization-publication-entry"))
  f.root.querySelector<HTMLButtonElement>(".organization-publication-entry")!.click()
  await changed(f.root, () => f.root.textContent?.includes("policy.txt") === true)
  expect(f.root.textContent).toContain("Published by Policy author")
  button(f.root, "Preview").click()
  await changed(f.root, () => !!f.root.querySelector(".organization-file-preview pre"))
  expect(f.root.querySelector(".organization-file-preview pre")?.textContent).toBe("Reviewed policy bytes")
  expect(reads[0]!.path).toContain(`/versions/2/files/${"a".repeat(64)}/content`)
  expect(reads[0]!.range).toBe(`bytes=0-${bytes.length - 1}`)
  button(f.root, "Close preview").click()
  expect(f.root.querySelector(".organization-file-preview")).toBeNull()
  button(f.root, "Version 1").click()
  await changed(f.root, () => f.reads.some((read) => read.path.includes("/versions/1/files")))
  await changed(f.root, () => !!f.root.querySelector(".organization-file-list button"))
  button(f.root, "Preview").click()
  await changed(
    f.root,
    () => reads.length === 2 && !!f.root.querySelector('.organization-publication-files [role="alert"]'),
  )
  expect(f.root.querySelector(".organization-file-preview")).toBeNull()
  expect(f.root.textContent).not.toContain("Reviewed policy bytes")
  expect(reads[1]!.path).toContain(`/versions/1/files/${"b".repeat(64)}/content`)
  button(f.root, "Withdraw publication").click()
  const cancelled = await confirmation("Withdraw publication")
  expect(writes).toHaveLength(0)
  cancelled.cancel.click()
  expect(writes).toHaveLength(0)
  button(f.root, "Withdraw publication").click()
  ;(await confirmation("Withdraw publication")).accept.click()
  await changed(f.root, () => !f.root.querySelector(".organization-publication-entry"))
  expect(writes).toHaveLength(1)
  expect(requestBody(writes[0]!)).toEqual({ expectedRevision: 6 })
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})

test("source knowledge search keeps its query across pages and old confirmations cannot act in another Space", async () => {
  const queryReads: Desktop.Request[] = []
  const writes: Desktop.Request[] = []
  const f = await mount({
    holdOrganization: false,
    path: "/knowledge",
    async request(input) {
      const url = new URL(input.path, "https://a.example")
      if (input.connectionID !== entries[0]!.id) return
      if (url.pathname === "/org/v1/knowledge") return response({ items: [policy] })
      if (url.pathname === "/org/v1/knowledge/search") {
        queryReads.push(input)
        return url.searchParams.has("cursor")
          ? response({ items: [{ ...policy, itemID: "second-policy", title: "Second reviewed policy" }] })
          : response({ items: [policy], cursor: "next-review-page" })
      }
      if (url.pathname.endsWith("/versions")) return response({ items: policyVersions })
      if (url.pathname.endsWith("/files")) return response({ items: [] })
      if (input.method === "DELETE") {
        writes.push(input)
        return response({ ...policy, state: "withdrawn" })
      }
    },
  })
  await changed(
    f.root,
    () => !!f.root.querySelector(".organization-publication-entry") && !button(f.root, "Search publications").disabled,
  )
  field(f.root, "Search publications", "  field review  ")
  submit(f.root.querySelector<HTMLFormElement>("form.organization-search"))
  await changed(
    f.root,
    () => f.root.textContent?.includes("Load more") === true && !button(f.root, "Load more").disabled,
    "knowledge:first-search-page",
  )
  button(f.root, "Load more").click()
  await changed(f.root, () => f.root.textContent?.includes("Second reviewed policy") === true, "knowledge:continuation")
  expect(queryReads).toHaveLength(2)
  expect(new URL(queryReads[0]!.path, "https://a.example").searchParams.get("q")).toBe("field review")
  const second = new URL(queryReads[1]!.path, "https://a.example").searchParams
  expect(second.get("q")).toBe("field review")
  expect(second.get("cursor")).toBe("next-review-page")
  expect(f.root.querySelectorAll(".organization-publication-entry")).toHaveLength(2)
  f.root.querySelector<HTMLButtonElement>(".organization-publication-entry")!.click()
  await changed(f.root, () => f.root.textContent?.includes("Withdraw publication") === true)
  button(f.root, "Withdraw publication").click()
  const old = await confirmation("Withdraw publication")
  const owner = f.space.current()!
  f.space.open(organizationSpaceKey(entries[1]!))
  await changed(f.root, () => f.root.querySelector("h1")?.textContent === "Field B")
  expect(owner.signal.aborted).toBe(true)
  expect(old.accept.isConnected).toBe(false)
  old.accept.click()
  expect(writes).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(f.root.textContent).not.toContain("Reviewed field policy")
  expect(f.starts()).toBe(0)
})

function sourceTokenStorage() {
  const target = SourceTokenPersist.connection(organizationSpaceKey(entries[0]!), "organization-api-token:account-a")
  const key = `${target.storage}:${target.key}`
  const previous = localStorage.getItem(key)
  localStorage.removeItem(key)
  cleanups.push(() => {
    if (previous === null) localStorage.removeItem(key)
    else localStorage.setItem(key, previous)
  })
  return key
}

function sourceTokenTransport(mode: "lost" | "existing") {
  const requests: SourceToken.Create[] = []
  const revocations: Array<{ tokenID: string; expectedRevision: number }> = []
  const byRequest = new Map<string, SourceToken.Metadata>()
  const rows = new Map<string, SourceToken.Metadata>()
  const secret = `sy_api_${"b".repeat(64)}`
  const success = (body: unknown): Desktop.Result<Desktop.Response> => ({
    ok: true,
    value: { status: 200, body: JSON.stringify(body) },
  })
  const failure = (status: number, code: string): Desktop.Result<Desktop.Response> => ({
    ok: true,
    value: { status, body: JSON.stringify({ code }) },
  })
  if (mode === "existing") {
    const row = SourceToken.Metadata.parse({
      tokenID: "existing-token",
      orgID: "org-a",
      accountID: "account-a",
      projectID: "project-a",
      label: "Existing automation",
      operations: ["sessions.read"],
      revision: 17,
      createdAt: 1,
      expiresAt: Date.now() + 86400000,
    })
    rows.set(row.tokenID, row)
  }
  return {
    requests,
    revocations,
    secret,
    issued: () => byRequest.size,
    async request(input: Desktop.Request): Promise<Desktop.Result<Desktop.Response>> {
      const path = new URL(input.path, entries[0]!.issuer).pathname
      const account = input.connectionID === entries[0]!.id ? "a" : "b"
      if (path === "/org/v1/organization")
        return success({ orgID: `org-${account}`, name: `Field ${account.toUpperCase()}`, revision: 1 })
      if (account !== "a") return success({ items: [] })
      if (path === "/org/v1/projects")
        return success({
          items: [
            {
              projectID: "project-a",
              orgID: "org-a",
              name: "Field notes",
              description: "",
              state: "active",
              revision: 1,
              createdAt: 1,
              role: "collaborator",
              permissions: { read: true, execute: true, manage: false },
            },
          ],
        })
      if (path === "/org/v1/api-tokens" && input.method === "POST") {
        const request = SourceToken.Create.parse(JSON.parse(input.body!))
        requests.push(request)
        if (mode === "existing") return failure(403, "PERMISSION_DENIED")
        const previous = byRequest.get(request.requestID)
        if (previous) return success(SourceToken.Created.parse({ metadata: previous, secretUnavailable: true }))
        const metadata = SourceToken.Metadata.parse({
          tokenID: `issued-token-${byRequest.size + 1}`,
          orgID: "org-a",
          accountID: "account-a",
          projectID: request.projectID,
          label: request.label,
          operations: request.operations,
          revision: 1,
          createdAt: Date.now(),
          expiresAt: request.expiresAt,
        })
        byRequest.set(request.requestID, metadata)
        rows.set(metadata.tokenID, metadata)
        if (byRequest.size === 1) return failure(504, "COMMAND_OUTCOME_UNKNOWN")
        return success(SourceToken.Created.parse({ metadata, token: secret, secretUnavailable: false }))
      }
      const revoke = path.match(/^\/org\/v1\/api-tokens\/([^/]+)\/revoke$/)
      if (revoke && input.method === "POST") {
        const body = SourceToken.Revoke.parse(JSON.parse(input.body!))
        const tokenID = revoke[1]!
        revocations.push({ tokenID, expectedRevision: body.expectedRevision })
        const previous = rows.get(tokenID)
        if (!previous || previous.revision !== body.expectedRevision) return failure(409, "REVISION_CONFLICT")
        const metadata = SourceToken.Metadata.parse({
          ...previous,
          revision: previous.revision + 1,
          revokedAt: Date.now(),
        })
        rows.set(tokenID, metadata)
        return success(metadata)
      }
      if (path === "/org/v1/api-tokens") return success(SourceToken.Page.parse({ items: [...rows.values()] }))
      return success({ items: [] })
    },
  }
}

async function openSourceTokenPanel(f: Awaited<ReturnType<typeof mount>>) {
  button(f.root, "Account").click()
  await changed(f.root, () => !!f.root.querySelector(".organization-api-token-disclosure"))
  const disclosure = f.root.querySelector<HTMLDetailsElement>(".organization-api-token-disclosure")!
  disclosure.open = true
  disclosure.dispatchEvent(new Event("toggle"))
  await changed(f.root, () => !!f.root.querySelector(".organization-api-tokens"))
}

test("source UI with controlled transport recovers one token request and clears a replacement secret on Space exit", async () => {
  const storageKey = sourceTokenStorage()
  const backend = sourceTokenTransport("lost")
  const f = await mount({ request: backend.request, holdOrganization: false })
  await openSourceTokenPanel(f)
  field(f.root, "Token name", "Automation")
  await choose(f.root, "Project", "Field notes")
  submit(f.root.querySelector<HTMLFormElement>(".organization-api-tokens form")!)
  await changed(
    f.root,
    () =>
      backend.requests.length === 1 &&
      f.root.textContent!.includes("Recover token issuance") &&
      !button(f.root, "Recover token issuance").disabled,
    "token:unknown-response-settled",
  )
  expect(backend.requests).toHaveLength(1)
  expect(backend.requests[0]!.operations).toEqual(["sessions.read"])
  expect(backend.requests[0]!.projectID).toBe("project-a")
  expect(f.root.querySelector(".organization-api-tokens form")).toBeNull()
  expect(localStorage.getItem(storageKey)).toContain(backend.requests[0]!.requestID)
  button(f.root, "Recover token issuance").click()
  await changed(f.root, () => f.root.textContent!.includes("its original value is unavailable"))
  expect(backend.requests).toHaveLength(2)
  expect(backend.requests[1]).toEqual(backend.requests[0])
  expect(backend.issued()).toBe(1)
  expect(f.root.querySelector(".organization-api-token-secret")).toBeNull()
  expect(f.root.querySelector(".organization-api-tokens form")).toBeNull()
  button(f.root, "Revoke token").click()
  await changed(document.body, () => !!document.querySelector("[role='dialog']"))
  expect(backend.revocations).toHaveLength(0)
  ;(await confirmation("Revoke token")).accept.click()
  await changed(f.root, () => !!f.root.querySelector(".organization-api-tokens form"))
  expect(backend.revocations).toEqual([{ tokenID: "issued-token-1", expectedRevision: 1 }])
  expect(backend.requests).toHaveLength(2)
  expect(localStorage.getItem(storageKey)).toBeNull()
  field(f.root, "Token name", "Replacement automation")
  submit(f.root.querySelector<HTMLFormElement>(".organization-api-tokens form")!)
  await changed(f.root, () => !!f.root.querySelector(".organization-api-token-secret input"))
  const secret = f.root.querySelector<HTMLInputElement>(".organization-api-token-secret input")!
  expect(secret.type).toBe("password")
  expect(secret.readOnly).toBe(true)
  expect(secret.value).toBe(backend.secret)
  expect(backend.requests).toHaveLength(3)
  expect(backend.issued()).toBe(2)
  expect(backend.requests[2]!.requestID).not.toBe(backend.requests[0]!.requestID)
  expect(localStorage.getItem(storageKey)).toBeNull()
  expect(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!)).join(" "),
  ).not.toContain(backend.secret)
  const previous = f.space.current()!
  f.space.open(organizationSpaceKey(entries[1]!))
  await changed(f.root, () => f.root.querySelector("h1")?.textContent === "Field B")
  expect(previous.signal.aborted).toBe(true)
  expect(f.root.querySelector(".organization-api-token-secret")).toBeNull()
  expect(f.root.textContent).not.toContain("Replacement automation")
  expect(backend.requests).toHaveLength(3)
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})

test("source UI with controlled transport revokes the confirmed existing token revision without issuing a token", async () => {
  sourceTokenStorage()
  const backend = sourceTokenTransport("existing")
  const f = await mount({ request: backend.request, holdOrganization: false })
  await openSourceTokenPanel(f)
  await changed(f.root, () => f.root.textContent!.includes("Existing automation"))
  const row = [...f.root.querySelectorAll<HTMLLIElement>(".organization-api-token-list > li")].find(
    (item) => item.querySelector("strong")?.textContent === "Existing automation",
  )!
  expect(row).toBeDefined()
  button(row, "Revoke token").click()
  await changed(document.body, () => !!document.querySelector("[role='dialog']"))
  expect(backend.revocations).toHaveLength(0)
  expect(backend.requests).toHaveLength(0)
  ;(await confirmation("Revoke token")).accept.click()
  await changed(f.root, () => row.textContent!.includes("Revoked"))
  expect(backend.revocations).toEqual([{ tokenID: "existing-token", expectedRevision: 17 }])
  expect([...row.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Revoke token")).toBe(false)
  expect(backend.requests).toHaveLength(0)
  expect(f.root.querySelector(".organization-api-token-secret")).toBeNull()
  expect(f.starts()).toBe(0)
  expect(f.personalFetches()).toBe(0)
})
