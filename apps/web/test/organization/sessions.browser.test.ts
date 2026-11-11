import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import { organizationCommandFixtureSource } from "../support/organization-command-fixture"
import {
  OrganizationCommandProtocol as Command,
  type OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"

let browser: Browser
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const entry: Desktop.Connection = {
  id: "a".repeat(64),
  issuer: "https://a.example",
  clientID: "desktop",
  orgID: "org-a",
  deploymentIncarnation: "deployment-a",
  account: {
    accountID: "account-a",
    orgID: "org-a",
    loginName: "reader",
    displayName: "Member",
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}
const session = {
  sessionID: "session-a",
  projectID: "project-a",
  creatorID: "account-a",
  driverRuntimeID: "runtime-a",
  bindingEpoch: 1,
  createdAt: 0,
  shareState: "private",
  resourceIDs: [],
  permissions: { read: true, execute: true, stop: true },
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-session-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { Show } from "solid-js"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { SpaceProvider, useSpace } from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import { OrganizationSessionComposer } from ${JSON.stringify(`/@fs/${source}/organization/session-composer.tsx`)}
    import { OrganizationSessionResources } from ${JSON.stringify(`/@fs/${source}/organization/session-resources.tsx`)}
    import { PrivateOrganizationTranscript } from ${JSON.stringify(`/@fs/${source}/organization/private-transcript.tsx`)}
    ${organizationCommandFixtureSource}
    const platform = { platform: "web", openLink() {}, organization: { list: () => window.hostList(), request: value => window.hostRequest(value), commandStream, memberStatus: value => window.hostMemberStatus ? window.hostMemberStatus(value) : Promise.resolve({ok:true,value:{connectionID:"${entry.id}",state:"stopped"}}),memberRequest:value => window.hostMemberRequest(value),startMember:value => window.hostStartMember(value),projectBinding:value => window.hostProjectBinding(value),bindProject:value => window.hostBindProject(value), cancel: value => {commandTransfers.delete(value.requestID);return Promise.resolve({ok:true})} }, fetch: async () => Response.json({ healthy: false }) }
    function Fixture() { const space = useSpace(); const mode = new URLSearchParams(location.search).get("fixture"); return <Show when={space.current()?.identity.kind === "organization"}>{mode === "private" ? <PrivateOrganizationTranscript sessionID="session-a" binding={{schemaVersion:1,orgID:"org-a",projectID:"project-a",creatorID:"account-a",driverRuntimeID:"runtime-a",bindingEpoch:1}} /> : mode === "resources" ? <OrganizationSessionResources projectID="project-a" sessionID="session-a" canExecute={true} /> : <OrganizationSessionComposer session={${JSON.stringify(session)}} online={true} modelReady={true} control={{runID:"run-a",controlVersion:7,pausedSince:42}} accepted={() => {}} />}</Show> }
    render(() => <PlatformProvider value={platform}><AppBaseProviders>{new URLSearchParams(location.search).get("fixture") === "app" ? <AppInterface /> : <SpaceProvider><Fixture /></SpaceProvider>}</AppBaseProviders></PlatformProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test("the project conversation route shows the private title and keeps send controls within desktop and narrow viewports", async () => {
  for (const variant of [
    { width: 1100, height: 760, scheme: "light" as const },
    { width: 1100, height: 760, scheme: "dark" as const },
    { width: 375, height: 740, scheme: "light" as const },
    { width: 375, height: 667, scheme: "light" as const },
    { width: 375, height: 667, scheme: "light" as const, pending: true },
    { width: 1100, height: 760, scheme: "light" as const, readOnly: true },
  ]) {
    const readOnly = "readOnly" in variant
    const hasPending = "pending" in variant
    const viewport = { width: variant.width, height: variant.height }
    const page = await browser.newPage({ viewport, colorScheme: variant.scheme })
    await page.route("**/brand/synergy-product-icon.png", async (route) =>
      route.fulfill({
        contentType: "image/png",
        body: await fs.readFile(path.resolve(source, "../public/brand/synergy-product-icon.png")),
      }),
    )
    await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
    await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
      const url = new URL(request.path, entry.issuer)
      const query = request.body ? JSON.parse(request.body) : undefined
      const binding = {
        schemaVersion: 1,
        orgID: "org-a",
        projectID: "project-a",
        creatorID: "account-a",
        driverRuntimeID: "runtime-a",
        bindingEpoch: 1,
      }
      if (url.pathname.endsWith("/interactions"))
        return {
          ok: true,
          value: {
            status: 200,
            body: JSON.stringify({
              rootSessionID: "session-a",
              sourceSessionID: "session-a",
              binding,
              runtimeKind: "member",
              operation: query.operation,
              ...(query.operation === "pending"
                ? {
                    items: hasPending
                      ? [
                          {
                            kind: "permission",
                            requestID: "permission-a",
                            sourceSessionID: "session-a",
                            permission: "bash",
                            patterns: ["/approved/project/**"],
                            alwaysScope: "runtime",
                          },
                        ]
                      : [],
                    hasMore: false,
                  }
                : { items: [{ identity: { kind: "permission", requestID: "permission-a" }, state: "pending" }] }),
            }),
          },
        }
      const body =
        url.pathname === "/org/v1/organization"
          ? { orgID: "org-a", name: "Research team", revision: 1 }
          : url.pathname === "/org/v1/projects/project-a"
            ? {
                projectID: "project-a",
                orgID: "org-a",
                name: "Field notes",
                description: "Shared project",
                state: "active",
                revision: 1,
                createdAt: 1,
                role: "maintainer",
                permissions: { read: true, execute: !readOnly, manage: false },
              }
            : url.pathname === "/org/v1/sessions/session-a"
              ? {
                  ...session,
                  permissions: { read: true, execute: !readOnly, stop: !readOnly },
                  runtime: {
                    runtimeID: "runtime-a",
                    runtimeKind: "member",
                    ownerID: "account-a",
                    state: "online",
                    connectionEpoch: 1,
                  },
                }
              : url.pathname.endsWith("/share")
                ? {
                    sessionID: "session-a",
                    shareState: "private",
                    shareGeneration: 0,
                    bindingEpoch: 1,
                    nextSeq: 1,
                    syncState: "pending",
                    updatedAt: 1,
                  }
                : url.pathname.endsWith("/resources")
                  ? {
                      sessionID: "session-a",
                      revision: 1,
                      selection: { modelResourceID: "model-a", connectionResourceIDs: [] },
                    }
                  : query?.operation === "timeline"
                    ? {
                        operation: "timeline",
                        rootSessionID: "session-a",
                        sourceSessionID: "session-a",
                        binding,
                        items: [],
                        referencedRoots: [],
                        hasMore: false,
                        total: 0,
                        generation: 1,
                      }
                    : query?.operation === "session"
                      ? {
                          operation: "session",
                          rootSessionID: "session-a",
                          sourceSessionID: "session-a",
                          binding,
                          session: { sessionID: "session-a", title: "Private research", createdAt: 1, updatedAt: 1 },
                        }
                      : {
                          operation: "status",
                          rootSessionID: "session-a",
                          sourceSessionID: "session-a",
                          binding,
                          status: { type: "busy", runID: "actual-run-a", controlVersion: 7, observedAt: 1 },
                        }
      return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
    })
    try {
      await page.goto(
        new URL(
          "/organization/org-a/account-a/deployment-a/projects/project-a/sessions/session-a?fixture=app",
          server.url,
        ).href,
      )
      await page.getByRole("heading", { name: "Private research", exact: true }).waitFor()
      if (!readOnly) {
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("A retained draft")
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll("button")].some(
              (button) => button.textContent?.trim() === "Send" && !button.disabled,
            ),
          undefined,
          { timeout: 5000 },
        )
      }
      if (hasPending) await page.getByRole("button", { name: "Expand request", exact: true }).waitFor()
      expect(await page.getByRole("button", { name: "Cancel work", exact: true }).count()).toBe(readOnly ? 0 : 1)
      if (process.env.SYNERGY_UI_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.SYNERGY_UI_SCREENSHOT_DIR,
            `session-${viewport.width}-${viewport.height}-${variant.scheme}${hasPending ? "-pending" : readOnly ? "-read-only" : ""}.png`,
          ),
        })
      if (readOnly) {
        expect(await page.getByRole("textbox", { name: "Message", exact: true }).count()).toBe(0)
        expect(await page.getByRole("button", { name: "Pause", exact: true }).count()).toBe(0)
      } else {
        const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox()
        expect(send && send.y >= 0 && send.y + send.height <= viewport.height).toBe(true)
      }
      for (const name of readOnly ? ["Share with project"] : ["Send", "Pause", "Cancel work", "Share with project"]) {
        const bounds = await page.getByRole("button", { name, exact: true }).boundingBox()
        expect(
          bounds &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= viewport.width &&
            bounds.y >= 0 &&
            bounds.y + bounds.height <= viewport.height,
        ).toBe(true)
      }
      const transcript = await page.locator(".organization-transcript-viewport").boundingBox()
      expect(transcript && transcript.height >= 64).toBe(true)
      if (hasPending) {
        await page.getByRole("button", { name: "Expand request", exact: true }).click()
        const allow = page.getByRole("button", { name: "Allow once", exact: true })
        await allow.scrollIntoViewIfNeeded()
        const bounds = await allow.boundingBox()
        expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height).toBe(true)
        const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox()
        expect(send && send.y >= 0 && send.y + send.height <= viewport.height).toBe(true)
        const reading = await page.locator(".organization-transcript-viewport").boundingBox()
        expect(reading && reading.height >= 64).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally {
      await page.close()
    }
  }
})

test("private conversation projects verified native field bytes through the ordinary message renderer", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const requests: { operation: string; limit?: number; offset?: number; length?: number }[] = []
  const bytes = new TextEncoder().encode("Actual private content 你好")
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const binding = {
    schemaVersion: 1,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const query = JSON.parse(request.body!)
    requests.push(query)
    const base = { operation: query.operation, rootSessionID: "session-a", sourceSessionID: "session-a", binding }
    const body =
      query.operation === "timeline"
        ? {
            ...base,
            items: [
              {
                messageID: "message-a",
                role: "user",
                createdAt: 1,
                agent: "general",
                model: { providerID: "provider", modelID: "model" },
                summary: "Only safe metadata",
                version: "message-v1",
                order: "1",
              },
            ],
            referencedRoots: [],
            hasMore: false,
            total: 1,
            generation: 1,
          }
        : query.operation === "parts"
          ? {
              ...base,
              messageID: "message-a",
              hasMore: false,
              items: [
                {
                  messageID: "message-a",
                  partID: "part-a",
                  type: "text",
                  preview: "Safe preview",
                  content: { version: "part-v1", bytes: bytes.length },
                },
              ],
            }
          : query.operation === "partContent"
            ? {
                ...base,
                state: "ready",
                value: {
                  messageID: "message-a",
                  partID: "part-a",
                  version: "part-v1",
                  part: {
                    type: "text",
                    origin: "user",
                    content: {
                      kind: "native",
                      version: "part-v1",
                      field: "text",
                      bytes: bytes.length,
                      sha256,
                      original: "complete",
                    },
                  },
                },
                chunk: {
                  field: "text",
                  offset: query.offset,
                  nextOffset: Math.min(bytes.length, query.offset + query.length),
                  totalBytes: bytes.length,
                  sha256,
                  original: "complete",
                  data: Buffer.from(bytes.slice(query.offset, query.offset + query.length)).toString("base64url"),
                  complete: query.offset + query.length >= bytes.length,
                },
              }
            : query.operation === "session"
              ? { ...base, session: { sessionID: "session-a", title: "Private title", createdAt: 1, updatedAt: 2 } }
              : { ...base, status: { type: "idle", controlVersion: 1, observedAt: 2 } }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a?fixture=private", server.url).href)
    await page.getByText("Actual private content 你好", { exact: true }).waitFor()
    expect(await page.getByText("Only safe metadata", { exact: true }).count()).toBe(0)
    expect(requests.find((request) => request.operation === "timeline")?.limit).toBe(32)
    expect(requests.find((request) => request.operation === "parts")?.limit).toBe(64)
    expect(
      requests.filter((request) => request.operation === "partContent").every((request) => request.length! <= 131072),
    ).toBe(true)
  } finally {
    await page.close()
  }
})

test("a native permission revocation clears previously rendered private content", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  let revoked = false
  const text = "Temporary authorized content"
  const bytes = Buffer.from(text)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const binding = {
    schemaVersion: 1,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostMemberStatus", () => ({
    ok: true,
    value: { connectionID: entry.id, state: "running", runtimeID: "runtime-a" },
  }))
  await page.exposeFunction("hostMemberRequest", (request: Desktop.MemberRequest) => {
    if (revoked) return { ok: false, error: { code: "permission_denied" } }
    const query = request.query
    const base = { operation: query.operation, rootSessionID: "session-a", sourceSessionID: "session-a", binding }
    const result =
      query.operation === "timeline"
        ? {
            ...base,
            items: [
              {
                messageID: "message-a",
                role: "user",
                createdAt: 1,
                agent: "general",
                model: { providerID: "provider", modelID: "model" },
                summary: "",
                version: "message-v1",
                order: "1",
              },
            ],
            referencedRoots: [],
            hasMore: false,
            total: 1,
            generation: 1,
          }
        : query.operation === "parts"
          ? {
              ...base,
              messageID: "message-a",
              items: [
                {
                  partID: "part-a",
                  messageID: "message-a",
                  type: "text",
                  preview: "",
                  content: { version: "part-v1", bytes: bytes.length },
                },
              ],
              hasMore: false,
            }
          : query.operation === "partContent"
            ? {
                ...base,
                state: "ready",
                value: {
                  partID: "part-a",
                  messageID: "message-a",
                  version: "part-v1",
                  part: {
                    type: "text",
                    content: {
                      kind: "native",
                      version: "part-v1",
                      field: "text",
                      bytes: bytes.length,
                      sha256,
                      original: "complete",
                    },
                  },
                },
                chunk: {
                  field: "text",
                  offset: query.offset,
                  nextOffset: Math.min(bytes.length, query.offset + query.length),
                  totalBytes: bytes.length,
                  sha256,
                  original: "complete",
                  data: bytes.subarray(query.offset, query.offset + query.length).toString("base64url"),
                  complete: query.offset + query.length >= bytes.length,
                },
              }
            : query.operation === "session"
              ? { ...base, session: { sessionID: "session-a", title: "Private", createdAt: 1, updatedAt: 1 } }
              : { ...base, status: { type: "idle", controlVersion: 1, observedAt: 1 } }
    return { ok: true, value: { kind: "result", result } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a?fixture=private", server.url).href)
    await page.getByText(text, { exact: true }).waitFor()
    revoked = true
    await page.getByRole("button", { name: "Latest messages", exact: true }).click()
    await page.getByRole("alert").first().waitFor()
    expect(await page.getByText(text, { exact: true }).count()).toBe(0)
  } finally {
    await page.close()
  }
})

test("an unknown input keeps its original identity across explicit retry and preserves the next draft through reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const writes: Command.InputRequest[] = []
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    if (request.method === "POST") {
      writes.push(Command.InputRequest.parse(JSON.parse(request.body!)))
      return {
        ok: true,
        value: {
          status: 504,
          body: JSON.stringify({
            code: "COMMAND_OUTCOME_UNKNOWN",
            message: "Reception is unknown",
            outcome: "unknown",
            retryable: false,
          }),
        },
      }
    }
    return {
      ok: true,
      value: {
        status: 200,
        body: JSON.stringify(
          Command.View.parse({
            requestID: writes.at(-1)!.requestID,
            attemptID: "attempt-a",
            state: "not_dispatched",
            authorizedAt: 1,
          }),
        ),
      },
    }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a?fixture=composer", server.url).href)
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Original request")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByRole("button", { name: "Check request status", exact: true }).waitFor()
    expect(writes).toHaveLength(1)
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Next request")
    await page.getByRole("button", { name: "Check request status", exact: true }).click()
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByRole("button", { name: "Check request status", exact: true }).waitFor()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    await page.reload()
    await page.getByRole("button", { name: "Check request status", exact: true }).waitFor()
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("Next request")
    expect(writes).toHaveLength(2)
  } finally {
    await page.close()
  }
})

test("resource reconciliation updates the revision without overwriting an unsaved model choice", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const reloadEntered = Promise.withResolvers<void>()
  const reloadReady = Promise.withResolvers<void>()
  let reads = 0
  const models = ["A", "B"].map((id) => ({
    resourceID: `model-${id}`,
    orgID: "org-a",
    kind: "model",
    name: `Model ${id}`,
    scope: { kind: "organization" },
    state: "enabled",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    definition: {
      protocol: "openai-compatible",
      model: {
        id,
        name: `Model ${id}`,
        limit: { context: 128000, output: 8192 },
        capabilities: {
          temperature: true,
          reasoning: false,
          tools: true,
          input: ["text"],
          output: ["text"],
          interleaved: false,
        },
      },
    },
    permissions: { use: true },
  }))
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const url = new URL(request.path, entry.issuer)
    if (request.method === "PUT")
      return {
        ok: true,
        value: {
          status: 409,
          body: JSON.stringify({
            code: "REVISION_CONFLICT",
            message: "Selection changed",
            currentRevision: 5,
            outcome: "not_dispatched",
            retryable: false,
          }),
        },
      }
    if (url.pathname === "/org/v1/projects/project-a/resources")
      return { ok: true, value: { status: 200, body: JSON.stringify({ items: models }) } }
    if (++reads > 1) {
      reloadEntered.resolve()
      await reloadReady.promise
    }
    return {
      ok: true,
      value: {
        status: 200,
        body: JSON.stringify({
          sessionID: "session-a",
          revision: reads === 1 ? 4 : 5,
          selection: { modelResourceID: "model-A", connectionResourceIDs: [] },
        }),
      },
    }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a?fixture=resources", server.url).href)
    await page.getByRole("button", { name: "Model: Model A", exact: true }).click()
    await page.getByRole("option", { name: "Model B", exact: true }).click()
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await reloadEntered.promise
    await page.getByText("Loading…", { exact: true }).waitFor()
    reloadReady.resolve()
    await page.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" })
    expect(await page.getByRole("button", { name: /^Model:/ }).textContent()).toContain("Model B")
  } finally {
    reloadReady.resolve()
    await page.close()
  }
})
