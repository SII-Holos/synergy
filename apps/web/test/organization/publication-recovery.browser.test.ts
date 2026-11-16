import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

declare global {
  interface Window {
    publicationFixture: typeof import("../../src/organization/publication-record") &
      typeof import("../../src/organization/publication-store")
    publicationRecoveryFixture: typeof import("../../src/organization/publication-recovery") & {
      createOrganizationClient: (typeof import("@ericsanchezok/synergy-sdk/organization"))["createOrganizationClient"]
      createOrganizationConnections: (typeof import("../../src/organization/connections"))["createOrganizationConnections"]
    }
  }
}
let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const connection: Desktop.Connection = {
  id: "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: "https://a.example",
  clientID: "desktop",
  orgID: "org-a",
  deploymentIncarnation: "deployment-a",
  state: "ready",
  account: {
    accountID: "account-a",
    orgID: "org-a",
    loginName: "a",
    displayName: "Member A",
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
}
const project = {
  projectID: "project",
  orgID: "org-a",
  name: "Field work",
  description: "",
  state: "active",
  revision: 1,
  createdAt: 0,
  permissions: { read: true, manage: true, execute: true },
  role: "maintainer",
}
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.publication-recovery-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import * as records from ${JSON.stringify(`/@fs/${source}/organization/publication-record.ts`)}
    import * as stores from ${JSON.stringify(`/@fs/${source}/organization/publication-store.ts`)}
    import * as recovery from ${JSON.stringify(`/@fs/${source}/organization/publication-recovery.ts`)}
    import {createOrganizationClient} from "@ericsanchezok/synergy-sdk/organization"
    import {createOrganizationConnections} from ${JSON.stringify(`/@fs/${source}/organization/connections.ts`)}
    window.publicationFixture={...records,...stores}
    window.publicationRecoveryFixture={...recovery,createOrganizationClient,createOrganizationConnections}
    const platform = { platform: "web", openLink() {}, organization: { protocolVersion: 2,
      list: () => window.hostList(), request: value => window.hostRequest(value), cancel: () => Promise.resolve({ok:true}),
      connect: () => Promise.resolve({ok:false,error:{code:"unavailable"}}), signOut: () => Promise.resolve({ok:false,error:{code:"unavailable"}}),
    }, fetch: async () => Response.json({ healthy: false }) }
    render(() => <PlatformProvider value={platform}><AppBaseProviders><AppInterface /></AppBaseProviders></PlatformProvider>, document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test.each([375, 1100])(
  "a lost publication ACK survives real reload and checks the original receipt without replay (%s)",
  async (width) => {
    const page = await browser.newPage({
      viewport: { width, height: width === 375 ? 667 : 760 },
      colorScheme: width === 375 ? "light" : "dark",
    })
    page.setDefaultTimeout(5000)
    const writes: unknown[] = []
    const checks: unknown[] = []
    let sealed: Record<string, unknown> | undefined
    let published: Record<string, unknown> | undefined
    await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
    await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
      const url = new URL(request.path, connection.issuer)
      const body = request.body ? JSON.parse(request.body) : undefined
      const response = (value: unknown, status = 200) => ({ ok: true, value: { status, body: JSON.stringify(value) } })
      if (url.pathname === "/org/v1/organization") return response({ orgID: "org-a", name: "Field team", revision: 1 })
      if (url.pathname === "/org/v1/projects") return response({ items: [project] })
      if (url.pathname === "/org/v1/projects/project") return response(project)
      if (url.pathname.includes("/knowledge/applied/"))
        return response({
          selection: {
            revision: 0,
            manifestHash: "0".repeat(64),
            releaseCount: 0,
            updatedBy: "account-a",
            updatedAt: 0,
          },
          items: [],
        })
      if (url.pathname === "/org/v1/knowledge/publication-receipts") {
        checks.push(body)
        return response({ state: "published", release: published })
      }
      if (url.pathname === "/org/v1/knowledge" && request.method === "POST") {
        writes.push(body)
        published = {
          itemID: body.itemID,
          orgID: "org-a",
          scope: { kind: "project", projectID: "project" },
          kind: body.kind,
          title: body.title,
          version: 1,
          authorID: "account-a",
          publishedAt: 2,
          manifestHash: sealed?.manifestHash,
          fileCount: 1,
          totalBytes: 12,
        }
        return response({ code: "SERVICE_UNAVAILABLE", message: "The reply was lost", retryable: true }, 503)
      }
      if (url.pathname === "/org/v1/knowledge")
        return response({
          items: published
            ? [
                {
                  ...published,
                  authorID: "account-a",
                  state: "published",
                  revision: 1,
                  latestVersion: 1,
                  createdAt: 1,
                  updatedAt: 2,
                },
              ]
            : [],
        })
      if (url.pathname === "/org/v1/publications/uploads")
        return response({
          uploadID: "sealed",
          orgID: "org-a",
          authorID: "account-a",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          state: "open",
          fileCount: 0,
          totalBytes: 0,
          createdAt: 1,
        })
      if (url.pathname === "/org/v1/publications/uploads/sealed/files")
        return response({ ...body, fileID: "b".repeat(64) })
      if (url.pathname.endsWith("/chunks")) return response({ receivedBytes: 12 })
      if (url.pathname.endsWith("/seal")) {
        sealed = {
          uploadID: "sealed",
          orgID: "org-a",
          authorID: "account-a",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          state: "sealed",
          createdAt: 1,
          ...body,
        }
        return response(sealed)
      }
      return response({ items: [] })
    })
    try {
      await page.goto(
        new URL("/organization/org-a/account-a/deployment-a/projects/project/knowledge", fixture.url).href,
      )
      await page.getByRole("button", { name: "Publish", exact: true }).click()
      await page.getByLabel("Title", { exact: true }).fill("Original pending publication")
      await page
        .getByLabel("Choose files", { exact: true })
        .setInputFiles({ name: "result.txt", mimeType: "text/plain", buffer: Buffer.from("Original txt") })
      await page.getByRole("button", { name: "Publish", exact: true }).click()
      await page.getByRole("alert").waitFor()
      expect(writes).toHaveLength(1)
      await page.reload()
      await page.getByRole("heading", { name: "Knowledge and Skills", exact: true }).waitFor()
      const recovery = page.getByRole("region", { name: "Unconfirmed publications" })
      await recovery.waitFor({ timeout: 5000 })
      expect(await recovery.getByText("Original pending publication", { exact: true }).count()).toBe(1)
      expect(writes).toHaveLength(1)
      expect(checks).toHaveLength(0)
      const check = recovery.getByRole("button", { name: "Check publication result" })
      await check.scrollIntoViewIfNeeded()
      const box = await check.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(width === 375 ? 667 : 760)
      if (process.env.SYNERGY_UI_SCREENSHOT_DIR) {
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({
          path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, `publication-pending-${width}.png`),
        })
      }
      await recovery.getByRole("button", { name: "Check publication result" }).click()
      await recovery.waitFor({ state: "detached" })
      expect(checks).toEqual(writes)
      expect(writes).toHaveLength(1)
      expect(await page.getByRole("button", { name: /Original pending publication/ }).count()).toBe(1)
      if (process.env.SYNERGY_UI_SCREENSHOT_DIR) {
        const folder = process.env.SYNERGY_UI_SCREENSHOT_DIR
        await fs.mkdir(folder, { recursive: true })
        await page.screenshot({ path: path.join(folder, `publication-reconciled-${width}.png`) })
      }
    } finally {
      await page.close()
    }
  },
  30_000,
)

test("real IndexedDB recovery is paged and exact to account/deployment, retaining historical unknown across restart", async () => {
  const page = await browser.newPage()
  try {
    await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.publicationFixture)
    const result = await page.evaluate(async () => {
      const { preparePublicationRecord, createOrganizationPublicationStore, removeOrganizationPublications } =
        window.publicationFixture
      const identity = {
        kind: "organization",
        orgID: "org",
        accountID: "alice",
        deploymentIncarnation: "deployment",
      } as const
      const store = createOrganizationPublicationStore({ identity })
      const records = []
      for (let i = 0; i < 40; i++) {
        const record = preparePublicationRecord({
          identity,
          source: { scope: { kind: "project", projectID: "project" } },
          upload: {
            uploadID: `upload-${i}`,
            orgID: "org",
            authorID: "alice",
            purpose: "knowledge",
            scope: { kind: "project", projectID: "project" },
            state: "sealed",
            fileCount: 1,
            totalBytes: 12,
            manifestHash: "a".repeat(64),
            createdAt: 1,
          },
          publication: {
            purpose: "knowledge",
            request: {
              requestID: `request-${String(i).padStart(3, "0")}`,
              itemID: `item-${i}`,
              expectedRevision: 0,
              uploadID: `upload-${i}`,
              title: `Title ${i}`,
              kind: "material",
            },
          },
          createdAt: 1,
        })
        records.push(await store.put(record))
      }
      const original = records[0]!
      await store.attempt(original)
      store.dispose()
      const reopened = createOrganizationPublicationStore({ identity })
      const originalLoaded = (await reopened.get(original.request.requestID))!
      const next = await reopened.attempt(originalLoaded)
      await reopened.failed(next, true)
      const state = (await reopened.get(original.request.requestID))!.state
      let cursor: string | undefined
      const ids: string[] = []
      let pages = 0
      do {
        const page = await reopened.page({
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          limit: 13,
          cursor,
        })
        ids.push(...page.items.map((item) => item.request.requestID))
        cursor = page.cursor
        pages++
      } while (cursor)
      const foreign = createOrganizationPublicationStore({ identity: { ...identity, accountID: "bob" } })
      const replaced = createOrganizationPublicationStore({
        identity: { ...identity, deploymentIncarnation: "new-deployment" },
      })
      const accountRows = (
        await foreign.page({ purpose: "knowledge", scope: { kind: "project", projectID: "project" } })
      ).items.length
      const deploymentRows = (
        await replaced.page({ purpose: "knowledge", scope: { kind: "project", projectID: "project" } })
      ).items.length
      const abort = new AbortController()
      const retired = createOrganizationPublicationStore({ identity, signal: abort.signal })
      abort.abort()
      let denied = false
      try {
        await retired.put(original)
      } catch {
        denied = true
      }
      await removeOrganizationPublications(original.connectionKey)
      const remaining = (
        await reopened.page({ purpose: "knowledge", scope: { kind: "project", projectID: "project" } })
      ).items.length
      reopened.dispose()
      foreign.dispose()
      replaced.dispose()
      retired.dispose()
      return { state, ids, pages, accountRows, deploymentRows, denied, remaining }
    })
    expect(result.state).toBe("unknown")
    expect(result.ids).toHaveLength(40)
    expect(new Set(result.ids).size).toBe(40)
    expect(result.pages).toBe(4)
    expect(result.accountRows).toBe(0)
    expect(result.deploymentRows).toBe(0)
    expect(result.denied).toBe(true)
    expect(result.remaining).toBe(0)
  } finally {
    await page.close()
  }
}, 30_000)

test("an original unknown is retained after receipt absence and a subsequent not-dispatched attempt", async () => {
  const page = await browser.newPage()
  try {
    await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.publicationRecoveryFixture)
    const result = await page.evaluate(async () => {
      const { preparePublicationRecord, createOrganizationPublicationStore } = window.publicationFixture
      const { createOrganizationClient, submitPublication } = window.publicationRecoveryFixture
      const identity = {
        kind: "organization",
        orgID: "org",
        accountID: "alice",
        deploymentIncarnation: "deployment",
      } as const
      const record = preparePublicationRecord({
        identity,
        source: { scope: { kind: "project", projectID: "project" } },
        upload: {
          uploadID: "sealed",
          orgID: "org",
          authorID: "alice",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          state: "sealed",
          fileCount: 1,
          totalBytes: 12,
          manifestHash: "a".repeat(64),
          createdAt: 1,
        },
        publication: {
          purpose: "knowledge",
          request: {
            requestID: "original",
            itemID: "item",
            expectedRevision: 0,
            uploadID: "sealed",
            title: "Title",
            kind: "material",
          },
        },
        createdAt: 1,
      })
      const store = createOrganizationPublicationStore({ identity })
      await store.put(record)
      const writes: unknown[] = []
      let checks = 0
      const api = createOrganizationClient({
        baseUrl: "https://organization.example",
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            const request = new Request(input)
            if (new URL(request.url).pathname.endsWith("publication-receipts")) {
              checks++
              return Response.json({ state: "missing" })
            }
            writes.push(await request.json())
            if (writes.length === 1) throw new Error("Original reply lost")
            throw { outcome: "not_dispatched" }
          },
          { preconnect() {} },
        ),
      })
      const signal = new AbortController().signal
      try {
        await submitPublication(api, store, record, signal)
      } catch {}
      const first = (await store.get("original"))!
      try {
        await submitPublication(api, store, first, signal)
      } catch {}
      const final = (await store.get("original"))!
      store.dispose()
      return { first: first.state, final: final.state, checks, writes, original: record.request }
    })
    expect(result.first).toBe("unknown")
    expect(result.final).toBe("unknown")
    expect(result.checks).toBe(1)
    expect(result.writes).toEqual([result.original, result.original])
  } finally {
    await page.close()
  }
}, 30_000)

test("a held original publication reply cannot clear metadata after its Space has retired", async () => {
  const page = await browser.newPage()
  try {
    await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.publicationRecoveryFixture)
    const result = await page.evaluate(async () => {
      const { preparePublicationRecord, createOrganizationPublicationStore } = window.publicationFixture
      const { createOrganizationClient, submitPublication, inspectPublication } = window.publicationRecoveryFixture
      const identity = {
        kind: "organization",
        orgID: "org",
        accountID: "alice",
        deploymentIncarnation: "deployment",
      } as const
      const record = preparePublicationRecord({
        identity,
        source: { scope: { kind: "project", projectID: "project" } },
        upload: {
          uploadID: "sealed",
          orgID: "org",
          authorID: "alice",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          state: "sealed",
          fileCount: 1,
          totalBytes: 12,
          manifestHash: "a".repeat(64),
          createdAt: 1,
        },
        publication: {
          purpose: "knowledge",
          request: {
            requestID: "original",
            itemID: "item",
            expectedRevision: 0,
            uploadID: "sealed",
            title: "Title",
            kind: "material",
          },
        },
        createdAt: 1,
      })
      const abort = new AbortController()
      const store = createOrganizationPublicationStore({ identity, signal: abort.signal })
      await store.put(record)
      let entered!: () => void
      let release!: (value: Response) => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<Response>((resolve) => {
        release = resolve
      })
      let calls = 0
      const api = createOrganizationClient({
        baseUrl: "https://organization.example",
        fetch: Object.assign(
          async () => {
            calls++
            entered()
            return held
          },
          { preconnect() {} },
        ),
      })
      const pending = submitPublication(api, store, record, abort.signal).then(
        () => false,
        () => true,
      )
      await started
      abort.abort()
      release(
        Response.json({
          itemID: "item",
          orgID: "org",
          scope: { kind: "project", projectID: "project" },
          kind: "material",
          title: "Title",
          version: 1,
          authorID: "alice",
          publishedAt: 2,
          manifestHash: "a".repeat(64),
          fileCount: 1,
          totalBytes: 12,
        }),
      )
      const rejected = await pending
      const reopened = createOrganizationPublicationStore({ identity })
      const original = await reopened.get("original")
      try {
        await inspectPublication(api, reopened, record, abort.signal)
      } catch {}
      reopened.dispose()
      store.dispose()
      return { rejected, calls, retained: original?.state }
    })
    expect(result).toEqual({ rejected: true, calls: 1, retained: "dispatching" })
  } finally {
    await page.close()
  }
}, 30_000)

test("old logout cleanup cannot delete a new login's publication after another connection owner completes logout", async () => {
  const page = await browser.newPage()
  try {
    await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.publicationRecoveryFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationConnections } = window.publicationRecoveryFixture
      const { createOrganizationPublicationStore, preparePublicationRecord } = window.publicationFixture
      const account = {
        accountID: "alice",
        orgID: "org",
        loginName: "alice",
        displayName: "Alice",
        role: "member",
        state: "active",
        revision: 1,
        authRevision: 1,
        createdAt: 1,
      } as const
      let native: Desktop.Connection = {
        id: "a".repeat(64),
        issuer: "https://org.example",
        orgID: "org",
        deploymentIncarnation: "deployment",
        clientID: "desktop",
        account,
        state: "ready",
        revision: "00000000-0000-4000-8000-000000000001",
      }
      let commits = 0
      const unavailable = async (): Promise<never> => {
        throw new Error("This metadata fixture cannot launch a Runtime")
      }
      const bridge: Desktop.Bridge = {
        protocolVersion: 2,
        list: async () => ({ ok: true, value: [native] }),
        connect: unavailable,
        request: unavailable,
        cancel: async () => ({ ok: true, value: undefined }),
        async signOut(input) {
          if (input.phase === "prepare") {
            if (native.revision !== input.requestID) {
              if (native.revision !== input.expectedRevision)
                return { ok: false, error: { code: "connection_changed" } }
              native = { ...native, state: "sign_out_pending", revision: input.requestID }
            }
          } else {
            if (native.revision !== input.expectedRevision) return { ok: false, error: { code: "connection_changed" } }
            native = { ...native, state: "signed_out" }
            commits++
          }
          return { ok: true, value: native }
        },
        memberStatus: unavailable,
        startMember: unavailable,
        download: unavailable,
        projectBinding: unavailable,
        bindProject: unavailable,
        memberRequest: unavailable,
        downloadContent: unavailable,
        downloadAttachment: unavailable,
        commandStream: unavailable,
      }
      const create = () =>
        createOrganizationConnections({
          storage: localStorage,
          origins: [],
          redirectUri: "https://app.example/organization.html",
          bridge,
        })
      const old = create()
      const other = create()
      await old.load()
      await other.load()
      const key = JSON.stringify(["organization", "org", "alice", "deployment"])
      old.select(key)
      other.select(key)
      const originalOpen = IDBFactory.prototype.open
      let entered!: () => void
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        entered = resolve
      })
      IDBFactory.prototype.open = function (...args) {
        const request = originalOpen.apply(this, args)
        if (args[0] === "synergy.organization-question-drafts") {
          IDBFactory.prototype.open = originalOpen
          request.addEventListener(
            "success",
            (event) => {
              event.stopImmediatePropagation()
              const callback = request.onsuccess
              release = () => {
                callback?.call(request, event)
              }
              entered()
            },
            { once: true },
          )
        }
        return request
      }
      let pending: Promise<unknown> | undefined
      let store: ReturnType<typeof createOrganizationPublicationStore> | undefined
      try {
        pending = old.signOut(key).catch((error: unknown) => error)
        await held
        await other.signOut(key)
        native = { ...native, state: "ready", revision: "00000000-0000-4000-8000-000000000002" }
        await old.load()
        const view = old.current()
        if (!view || view.identity.kind !== "organization") throw new Error("The new native login was not selected")
        store = createOrganizationPublicationStore({ identity: view.identity, signal: view.signal })
        const record = preparePublicationRecord({
          identity: view.identity,
          source: { scope: { kind: "project", projectID: "project" } },
          upload: {
            uploadID: "new-sealed",
            orgID: "org",
            authorID: "alice",
            purpose: "knowledge",
            scope: { kind: "project", projectID: "project" },
            state: "sealed",
            fileCount: 1,
            totalBytes: 12,
            manifestHash: "a".repeat(64),
            createdAt: 1,
          },
          publication: {
            purpose: "knowledge",
            request: {
              requestID: "new-login-publication",
              itemID: "item",
              uploadID: "new-sealed",
              expectedRevision: 0,
              title: "New login publication",
              kind: "material",
            },
          },
          createdAt: 1,
        })
        await store.put(record)
        release()
        const retired = await pending
        const retained = await store.get(record.request.requestID)
        return {
          retained: retained?.request.title,
          commits,
          error: retired && typeof retired === "object" && "code" in retired ? retired.code : undefined,
          revision: old.connection()?.transport === "desktop" ? native.revision : undefined,
        }
      } finally {
        IDBFactory.prototype.open = originalOpen
        release?.()
        await pending
        store?.dispose()
        old.dispose()
        other.dispose()
      }
    })
    expect(result).toEqual({
      retained: "New login publication",
      commits: 1,
      error: "cancelled",
      revision: "00000000-0000-4000-8000-000000000002",
    })
  } finally {
    await page.close()
  }
}, 30_000)

test("publication logout cancellation aborts an already deleted row before the actual IndexedDB commit", async () => {
  const page = await browser.newPage()
  try {
    await page.exposeFunction("hostList", () => ({ ok: true, value: [] }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.publicationFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationPublicationStore, preparePublicationRecord, removeOrganizationPublications } =
        window.publicationFixture
      const identity = {
        kind: "organization",
        orgID: "org",
        accountID: "alice",
        deploymentIncarnation: "deployment",
      } as const
      const store = createOrganizationPublicationStore({ identity })
      const record = preparePublicationRecord({
        identity,
        source: { scope: { kind: "project", projectID: "project" } },
        upload: {
          uploadID: "sealed",
          orgID: "org",
          authorID: "alice",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
          state: "sealed",
          fileCount: 1,
          totalBytes: 12,
          manifestHash: "a".repeat(64),
          createdAt: 1,
        },
        publication: {
          purpose: "knowledge",
          request: {
            requestID: "original",
            itemID: "item",
            uploadID: "sealed",
            expectedRevision: 0,
            title: "Title",
            kind: "material",
          },
        },
        createdAt: 1,
      })
      await store.put(record)
      const originalDelete = IDBCursor.prototype.delete
      const abort = new AbortController()
      let deletes = 0
      IDBCursor.prototype.delete = function () {
        const request = originalDelete.call(this)
        request.addEventListener(
          "success",
          () => {
            deletes++
            abort.abort()
          },
          { once: true },
        )
        return request
      }
      let rejected = false
      try {
        await removeOrganizationPublications(record.connectionKey, indexedDB, abort.signal)
      } catch {
        rejected = true
      } finally {
        IDBCursor.prototype.delete = originalDelete
      }
      const retained = !!(await store.get(record.request.requestID))
      store.dispose()
      return { rejected, retained, deletes }
    })
    expect(result).toEqual({ rejected: true, retained: true, deletes: 1 })
  } finally {
    await page.close()
  }
}, 30_000)
