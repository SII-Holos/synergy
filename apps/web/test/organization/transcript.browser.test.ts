import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

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
    displayName: "Reader",
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}
const message = (id: string, sequence = 1) => ({
  type: "message",
  sequence,
  messageID: id,
  role: "user",
  createdAt: sequence,
  agent: "general",
  model: { providerID: "provider", modelID: "model" },
  summary: "",
  integrity: "a".repeat(64),
})
const part = (text: string, sequence = 2) => ({
  type: "part",
  sequence,
  messageID: "message-a",
  partID: "part-a",
  part: { type: "text", content: { kind: "inline", text } },
  integrity: "a".repeat(64),
})

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-transcript-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { Show } from "solid-js"
    import { AppBaseProviders } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { SpaceProvider, useSpace } from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import { SharedOrganizationTranscript } from ${JSON.stringify(`/@fs/${source}/organization/shared-transcript.tsx`)}
    const platform = { platform: "web", openLink() {}, organization: { list: () => window.hostList(), request: value => window.hostRequest(value).then(result => result.ok && result.value.base64 !== undefined ? {ok:true,value:{status:result.value.status,contentType:result.value.contentType,contentRange:result.value.contentRange,bodyBytes:Uint8Array.from(atob(result.value.base64), c => c.charCodeAt(0))}} : result), cancel: () => Promise.resolve({ok:true}) }, fetch: async () => Response.json({ healthy: false }) }
    function Fixture() { const space = useSpace(); return <Show when={space.current()?.identity.kind === "organization"}><SharedOrganizationTranscript sessionID="session-a" shareGeneration={1} /></Show> }
    render(() => <PlatformProvider value={platform}><AppBaseProviders><SpaceProvider><Fixture /></SpaceProvider></AppBaseProviders></PlatformProvider>, document.getElementById("root"))
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

test("evicting a content blob releases every message that references its canonical tool output", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 2000 } })
  const bytes = [
    new Uint8Array(1024 * 1024).fill(65),
    new Uint8Array(8 * 1024 * 1024).fill(66),
    new Uint8Array(8 * 1024 * 1024).fill(67),
  ]
  const hashes = bytes.map((value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"))
  const bodies = new Map(hashes.map((hash, index) => [hash, bytes[index]!]))
  const ids = ["shared-a", "shared-b", "large-b", "large-c"]
  const bodyIndex = [0, 0, 1, 2]
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const url = new URL(request.path, entry.issuer)
    if (url.pathname.endsWith("/content")) {
      const content = bodies.get(url.pathname.split("/").at(-2)!)!
      const range = request.range!.match(/^bytes=(\d+)-(\d+)$/)!
      const start = Number(range[1]),
        end = Math.min(Number(range[2]), content.byteLength - 1)
      return {
        ok: true,
        value: {
          status: 206,
          base64: Buffer.from(content.subarray(start, end + 1)).toString("base64"),
          contentType: "text/plain",
          contentRange: `bytes ${start}-${end}/${content.byteLength}`,
        },
      }
    }
    const match = url.pathname.match(/\/messages\/([^/]+)\/parts$/)
    const index = match ? ids.indexOf(match[1]!) : -1
    const body = url.pathname.endsWith("/messages")
      ? {
          shareGeneration: 1,
          watermark: 10,
          items: ids.map((id, index) => ({
            ...message(id, index + 1),
            role: "assistant",
            parentID: "user-root",
            mode: "general",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          })),
        }
      : index >= 0
        ? {
            shareGeneration: 1,
            watermark: 10,
            complete: true,
            items: [
              {
                type: "part",
                sequence: index + 5,
                messageID: ids[index],
                partID: `part-${ids[index]}`,
                integrity: "a".repeat(64),
                part: {
                  type: "tool",
                  callID: `call-${index}`,
                  tool: "organization_knowledge",
                  status: "completed",
                  startedAt: 1,
                  completedAt: 2,
                  input: { kind: "inline", text: '{"input":{"operation":"read"}}' },
                  output: {
                    kind: "blob",
                    blobID: `body-${bodyIndex[index]}`,
                    hash: hashes[bodyIndex[index]!],
                    bytes: bytes[bodyIndex[index]!]!.byteLength,
                    mediaType: "text/plain",
                  },
                },
              },
            ],
          }
        : { shareGeneration: 1, nextSeq: 11, items: [] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  const row = (id: string) => page.locator(`[data-organization-message="${id}"]`)
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a", server.url).href)
    await row("shared-a").getByRole("button", { name: "Load full content", exact: true }).click()
    await row("shared-a").locator('[data-component="tool-card-area"]').waitFor()
    expect(await row("shared-b").locator('[data-component="tool-card-area"]').count()).toBe(1)
    for (const id of ids.slice(2)) {
      await row(id).getByRole("button", { name: "Load full content", exact: true }).click()
      await row(id).locator('[data-component="tool-card-area"]').waitFor()
    }
    expect(await row("shared-a").locator('[data-component="tool-card-area"]').count()).toBe(0)
    expect(await row("shared-b").locator('[data-component="tool-card-area"]').count()).toBe(0)
    expect(await row("large-b").locator('[data-component="tool-card-area"]').count()).toBe(1)
    expect(await row("large-c").locator('[data-component="tool-card-area"]').count()).toBe(1)
  } finally {
    await page.close()
  }
}, 120_000)

test("shared conversation reads a bounded message window and renders its canonical text", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const reads: string[] = []
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    reads.push(request.path)
    const url = new URL(request.path, entry.issuer)
    const body = url.pathname.endsWith("/messages")
      ? { shareGeneration: 1, watermark: 2, items: [message("message-a")] }
      : url.pathname.endsWith("/parts")
        ? { shareGeneration: 1, watermark: 2, items: [part("A shared answer with readable text")], complete: true }
        : { shareGeneration: 1, nextSeq: 3, items: [] }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a", server.url).href)
    await page.getByText("A shared answer with readable text", { exact: true }).waitFor()
    expect(
      reads.some((value) => {
        const url = new URL(value, entry.issuer)
        return (
          url.pathname.endsWith("/sync/messages") &&
          url.searchParams.get("latest") === "true" &&
          url.searchParams.get("limit") === "32" &&
          url.searchParams.get("sourceSessionID") === "session-a"
        )
      }),
    ).toBe(true)
    expect(
      reads.some((value) => {
        const url = new URL(value, entry.issuer)
        return (
          url.pathname.endsWith("/messages/message-a/parts") &&
          url.searchParams.get("latest") === "true" &&
          url.searchParams.get("limit") === "64" &&
          url.searchParams.get("sourceSessionID") === "session-a"
        )
      }),
    ).toBe(true)
    expect(reads.some((value) => value.includes("sync/snapshot"))).toBe(false)
  } finally {
    await page.close()
  }
})

test("a late replay response cannot rewind a refreshed conversation window", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const replay = Promise.withResolvers<{ ok: true; value: { status: number; body: string } }>()
  const replayEntered = Promise.withResolvers<void>()
  const cursors: number[] = []
  let windows = 0
  await page.exposeFunction("hostList", () => ({ ok: true, value: [entry] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const url = new URL(request.path, entry.issuer)
    if (url.pathname.endsWith("/events")) {
      cursors.push(Number(url.searchParams.get("cursor")))
      if (cursors.length === 1) {
        replayEntered.resolve()
        return replay.promise
      }
      return { ok: true, value: { status: 200, body: JSON.stringify({ shareGeneration: 1, nextSeq: 21, items: [] }) } }
    }
    const body = url.pathname.endsWith("/messages")
      ? {
          shareGeneration: 1,
          watermark: ++windows === 1 ? 10 : 20,
          items: [message("message-a", windows === 1 ? 1 : 20)],
        }
      : { shareGeneration: 1, watermark: 20, items: [part("Current text", 20)], complete: true }
    return { ok: true, value: { status: 200, body: JSON.stringify(body) } }
  })
  try {
    await page.goto(new URL("/organization/org-a/account-a/deployment-a", server.url).href)
    await replayEntered.promise
    await page.getByRole("button", { name: "Latest messages", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector("button[disabled]"))
    replay.resolve({
      ok: true,
      value: {
        status: 200,
        body: JSON.stringify({ shareGeneration: 1, cursor: 11, nextSeq: 12, items: [message("stale-message", 11)] }),
      },
    })
    await page.waitForTimeout(1250)
    expect(cursors.length).toBeGreaterThan(1)
    expect(cursors[1]).toBe(20)
    expect(await page.locator('[data-organization-message="stale-message"]').count()).toBe(0)
  } finally {
    replay.resolve({ ok: true, value: { status: 200, body: "{}" } })
    await page.close()
  }
})
