import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let browser: Browser
let server: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".local-model-identity-"))
  const state = path.join(directory, "state.ts")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      state,
      `
      const model = id => ({ id, name: id, status: "active", capabilities: { reasoning: false, input: {} }, cost: { input: 1, output: 1 } })
      const providers = [
        { id: "a", name: "First", models: { bc: model("bc"), "b:c": model("b:c") } },
        { id: "ab", name: "Second", models: { c: model("c") } },
        { id: "a:b", name: "Third", models: { c: model("c") } },
      ]
      export const useParams = () => ({})
      export const useSDK = () => ({ url: "http://fixture.test", scopeKey: "home", client: {} })
      export const useSync = () => ({ data: {
        agent: [{ name: "fixture", mode: "primary" }],
        config: { quick_switcher: { models: [{ providerID: "a", modelID: "b:c", state: "add" }] } },
      } })
      export const useSessionDataView = () => () => ({ messagesFor: () => undefined, sessionFor: () => undefined })
      export const useProviders = () => ({
        all: () => providers, available: () => providers, connected: () => providers, default: () => ({}),
        ensureModels: async () => {}, complete: () => true, resolved: () => true,
      })
    `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { render } from "solid-js/web"
      import { LocalProvider, useLocal } from ${JSON.stringify(`/@fs/${source}/context/local.tsx`)}
      const ref = model => ({ providerID: model.provider.id, modelID: model.id })
      function Fixture() {
        const local = useLocal()
        return <>
          <button onClick={() => local.model.set({ providerID: "a", modelID: "bc" }, { recent: true })}>Select first</button>
          <button onClick={() => local.model.set({ providerID: "ab", modelID: "c" }, { recent: true })}>Select second</button>
          <button onClick={() => local.model.set({ providerID: "a:b", modelID: "c" }, { recent: true })}>Select third</button>
          <output aria-label="Recent models">{JSON.stringify(local.model.recent().map(ref))}</output>
          <output aria-label="Quick models">{JSON.stringify(local.model.quickSwitcher().map(ref))}</output>
        </>
      }
      render(() => <LocalProvider><Fixture /></LocalProvider>, document.querySelector("#root"))
    `,
    ),
  ])
  server = await createBrowserFixture({
    root: directory,
    aliases: [
      { find: "./sdk", replacement: state },
      { find: "./sync", replacement: state },
      ...["@/context/session-route", "@/context/session-data-view", "@/hooks/use-providers"].map((find) => ({
        find,
        replacement: state,
      })),
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("recent model writes preserve distinct provider/model pairs rather than concatenating IDs", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    await page.getByRole("button", { name: "Select first", exact: true }).click()
    await page.getByRole("button", { name: "Select second", exact: true }).click()
    expect(JSON.parse(await page.getByLabel("Recent models").innerText())).toEqual([
      { providerID: "ab", modelID: "c" },
      { providerID: "a", modelID: "bc" },
    ])
    await page.getByRole("button", { name: "Select third", exact: true }).click()
    expect(JSON.parse(await page.getByLabel("Recent models").innerText())).toEqual([
      { providerID: "a:b", modelID: "c" },
      { providerID: "ab", modelID: "c" },
      { providerID: "a", modelID: "bc" },
    ])
    await page.getByRole("button", { name: "Select first", exact: true }).click()
    expect(JSON.parse(await page.getByLabel("Recent models").innerText())).toEqual([
      { providerID: "a", modelID: "bc" },
      { providerID: "a:b", modelID: "c" },
      { providerID: "ab", modelID: "c" },
    ])
    await page.reload()
    expect(JSON.parse(await page.getByLabel("Recent models").innerText())).toEqual([
      { providerID: "a", modelID: "bc" },
      { providerID: "a:b", modelID: "c" },
      { providerID: "ab", modelID: "c" },
    ])
  } finally {
    await page.close()
  }
})

test("one quick preference never includes another provider through a delimiter collision", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(server.url)
    await page.getByLabel("Quick models").waitFor()
    expect(JSON.parse(await page.getByLabel("Quick models").innerText())).toEqual([{ providerID: "a", modelID: "b:c" }])
  } finally {
    await page.close()
  }
})
