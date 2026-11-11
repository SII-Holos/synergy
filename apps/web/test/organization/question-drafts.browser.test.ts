import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import { organizationDataFixtureSource } from "../support/organization-data-fixture"
declare global {
  interface Window {
    questionDraftFixture: typeof import("../../src/organization/question-drafts")
  }
}
let browser: Browser
let fixture: BrowserFixture
let directory: string
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(import.meta.dir, "../../node_modules/.question-drafts-"))
  await Bun.write(path.join(directory, "index.html"), '<script type="module" src="/main.ts"></script>')
  await Bun.write(path.join(directory, "main.ts"), organizationDataFixtureSource)

  fixture = await createBrowserFixture({
    root: directory,
    styled: false,
    localized: false,
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }],
  })
  browser = await chromium.launch({ headless: true })
}, 60000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})
test("one legacy project imports all sources once, then point reads never parse the old record or read unrelated bodies", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.questionDraftFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationQuestionDrafts, organizationQuestionDraftLegacyKey } = window.questionDraftFixture
      const owner = {
        connectionKey: JSON.stringify(["organization", "org-one", "account-one", "deployment"]),
        accountID: "account-one",
        projectID: "project-one",
      }
      const key = organizationQuestionDraftLegacyKey(owner)
      const entries = Object.fromEntries(
        Array.from({ length: 160 }, (_, index) => [
          JSON.stringify([`source-${index}`, `question-${index}`]),
          {
            step: 0,
            selections: [[], []],
            custom: [`ordinary-${index}-` + "x".repeat(8192), `password-${index}`],
            source: ["custom", "custom"],
            inputTypes: ["text", "password"],
          },
        ]),
      )
      localStorage.setItem(key, JSON.stringify({ version: 2, entries }))
      let oldReads = 0
      let cleanupFails = true
      const storage = {
        getItem: (name: string) => {
          if (name === key) oldReads++
          return localStorage.getItem(name)
        },
        removeItem: (name: string) => {
          if (cleanupFails) throw new Error("Cleanup is temporarily unavailable")
          localStorage.removeItem(name)
        },
      }
      const request = {
        id: "question-159",
        sessionID: "source-159",
        questions: [
          { header: "Document", question: "Document?", options: [] },
          { header: "Password", question: "Password?", options: [], input_type: "password" as const },
        ],
      }
      const first = createOrganizationQuestionDrafts({ owner, storage })
      await first.ready()
      const original = IDBObjectStore.prototype.get
      let bodyReads = 0
      IDBObjectStore.prototype.get = function (query) {
        if (this.name === "drafts") bodyReads++
        return original.call(this, query)
      }
      let draft
      try {
        draft = await first.load(request)
      } finally {
        IDBObjectStore.prototype.get = original
      }
      await first.save(request, { ...draft!, custom: ["point-update", "never-store-password"] })
      first.dispose()
      const second = createOrganizationQuestionDrafts({ owner, storage })
      const restored = await second.load(request)
      const unrelated = await second.load({ ...request, sessionID: "unrelated-source" })
      second.dispose()
      const stillPresent = localStorage.getItem(key) !== null
      cleanupFails = false
      const third = createOrganizationQuestionDrafts({ owner, storage })
      await third.ready()
      third.dispose()
      return {
        oldReads,
        bodyReads,
        first: draft?.custom[0]?.slice(0, 13),
        password: draft?.custom[1],
        restored: restored?.custom,
        unrelated,
        stillPresent,
        cleaned: localStorage.getItem(key) === null,
      }
    })
    expect(result.oldReads).toBe(1)
    expect(result.bodyReads).toBe(1)
    expect(result.first).toBe("ordinary-159-")
    expect(result.password).toBe("")
    expect(result.restored).toEqual(["point-update", ""])
    expect(result.unrelated).toBeUndefined()
    expect(result.stillPresent).toBe(true)
    expect(result.cleaned).toBe(true)
  } finally {
    await page.close()
  }
})
test("a failed real import keeps its original legacy record and retries the complete transaction", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.questionDraftFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationQuestionDrafts, organizationQuestionDraftLegacyKey } = window.questionDraftFixture
      const owner = {
        connectionKey: JSON.stringify(["organization", "org-one", "account-one", "deployment"]),
        accountID: "account-one",
        projectID: "project-one",
      }
      const key = organizationQuestionDraftLegacyKey(owner)
      const value = JSON.stringify({
        version: 2,
        entries: Object.fromEntries(
          [0, 1, 2].map((index) => [
            JSON.stringify([`source-${index}`, `question-${index}`]),
            { step: 0, selections: [[]], custom: [`answer-${index}`], source: ["custom"], inputTypes: ["text"] },
          ]),
        ),
      })
      localStorage.setItem(key, value)
      const store = createOrganizationQuestionDrafts({ owner })
      const original = IDBObjectStore.prototype.add
      let writes = 0
      IDBObjectStore.prototype.add = function (value, key) {
        if (this.name === "drafts" && ++writes === 2)
          throw new DOMException("Injected storage failure", "QuotaExceededError")
        return original.call(this, value, key!)
      }
      let rejected = false
      try {
        await store.ready()
      } catch {
        rejected = true
      } finally {
        IDBObjectStore.prototype.add = original
      }
      const preserved = localStorage.getItem(key) === value
      await store.ready()
      const results = []
      for (let index = 0; index < 3; index++) {
        const draft = await store.load({
          id: `question-${index}`,
          sessionID: `source-${index}`,
          questions: [{ header: "Answer", question: "Answer?", options: [] }],
        })
        results.push(draft?.custom[0])
      }
      store.dispose()
      return { rejected, preserved, results, cleaned: localStorage.getItem(key) === null }
    })
    expect(result).toEqual({
      rejected: true,
      preserved: true,
      results: ["answer-0", "answer-1", "answer-2"],
      cleaned: true,
    })
  } finally {
    await page.close()
  }
})
test("a mismatched account cannot import another connection's legacy project drafts", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.questionDraftFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationQuestionDrafts, organizationQuestionDraftLegacyKey } = window.questionDraftFixture
      const owner = {
        connectionKey: JSON.stringify(["organization", "org-one", "other-account", "deployment"]),
        accountID: "account-one",
        projectID: "project-one",
      }
      const key = organizationQuestionDraftLegacyKey(owner)
      const raw = JSON.stringify({ version: 2, entries: {} })
      localStorage.setItem(key, raw)
      let reads = 0
      const store = createOrganizationQuestionDrafts({
        owner,
        storage: {
          getItem(name) {
            reads++
            return localStorage.getItem(name)
          },
          removeItem(name) {
            localStorage.removeItem(name)
          },
        },
      })
      try {
        await store.ready()
        return { rejected: false, preserved: false, reads }
      } catch {
        return { rejected: true, preserved: localStorage.getItem(key) === raw, reads }
      } finally {
        store.dispose()
      }
    })
    expect(result).toEqual({ rejected: true, preserved: true, reads: 0 })
  } finally {
    await page.close()
  }
})
