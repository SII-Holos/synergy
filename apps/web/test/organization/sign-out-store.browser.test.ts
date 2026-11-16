import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import type { OrganizationSignOutStore } from "../../src/organization/sign-out-store"

declare global {
  interface Window {
    __organizationSignOutFixture__?: (input: { name: string }) => OrganizationSignOutStore
  }
}

let browser: Browser
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-sign-out-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><script type="module" src="/main.ts"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.ts"),
    `import { createOrganizationSignOutStore } from ${JSON.stringify(`/@fs/${source}/organization/sign-out-store.ts`)}; window.__organizationSignOutFixture__ = createOrganizationSignOutStore`,
  )
  server = await createBrowserFixture({ root: directory, aliases: [{ find: "@", replacement: source }] })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test("real connection intent transactions coalesce one owner and cannot delete its later replacement", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    await page.waitForFunction(() => !!window.__organizationSignOutFixture__)
    const result = await page.evaluate(async () => {
      const open = window.__organizationSignOutFixture__
      if (!open) throw new Error("Connection fixture did not initialize")
      const first = open({ name: "sign-out-transaction-fixture" })
      const second = open({ name: "sign-out-transaction-fixture" })
      const original = {
        version: 1 as const,
        connectionKey: JSON.stringify(["organization", "org", "account", "deployment"]),
        connectionID: "a".repeat(64),
        issuer: "https://organization.example",
        orgID: "org",
        deploymentIncarnation: "deployment",
        clientID: "desktop",
        accountID: "account",
        expectedRevision: "00000000-0000-4000-8000-000000000001",
        requestID: "00000000-0000-4000-8000-000000000002",
      }
      const replacement = {
        ...original,
        requestID: "00000000-0000-4000-8000-000000000003",
        expectedRevision: "00000000-0000-4000-8000-000000000004",
      }
      const competitor = { ...original, requestID: "00000000-0000-4000-8000-000000000006" }
      const other = {
        ...original,
        connectionKey: JSON.stringify(["organization", "org", "other-account", "deployment"]),
        connectionID: "b".repeat(64),
        accountID: "other-account",
      }
      try {
        const [one, two] = await Promise.all([first.begin(original), second.begin(competitor)])
        const coalesced = JSON.stringify(one) === JSON.stringify(two)
        const stale = { ...one, requestID: "00000000-0000-4000-8000-000000000005" }
        const refused = !(await second.remove(stale))
        const retained = JSON.stringify(await first.get(one.connectionKey)) === JSON.stringify(one)
        await first.begin(other)
        const removed = await first.remove(one)
        await second.begin(replacement)
        const oldCannotDelete = !(await first.remove(one))
        const next = await second.get(one.connectionKey)
        first.close()
        second.close()
        const restarted = open({ name: "sign-out-transaction-fixture" })
        try {
          return {
            coalesced,
            refused,
            retained,
            removed,
            oldCannotDelete,
            replacement: next,
            restarted: await restarted.get(one.connectionKey),
            other: await restarted.get(other.connectionKey),
          }
        } finally {
          restarted.close()
        }
      } finally {
        first.close()
        second.close()
      }
    })
    expect(result.coalesced).toBe(true)
    expect(result.refused).toBe(true)
    expect(result.retained).toBe(true)
    expect(result.removed).toBe(true)
    expect(result.oldCannotDelete).toBe(true)
    expect(result.replacement?.requestID).toBe("00000000-0000-4000-8000-000000000003")
    expect(result.restarted).toEqual(result.replacement)
    expect(result.other?.accountID).toBe("other-account")
  } finally {
    await page.close()
  }
})
