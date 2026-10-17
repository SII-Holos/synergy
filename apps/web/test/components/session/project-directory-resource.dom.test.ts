import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string, server: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".directory-resource-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { batch, createMemo, createSignal, Show, Suspense } from "solid-js"
    import { createProjectDirectoryResource } from "@/components/session/project-directory-resource"
    import { RetainedSessionViews } from "@/components/session/retained-session-views"
    import { ViewResidencyProvider } from "@/context/view-residency"
    const [id, select] = createSignal("A"), [scope, scopeTo] = createSignal("one"), [connection, connect] = createSignal("server-one")
    const requests = [], controls = new Map()
    const result = scopeID => ({version:1,scopeID,revision:1,mainWorkspaceID:"main",additionalWorkspaceIDs:[],folders:[{workspaceID:"main",generation:1,path:"/"+scopeID,available:true,git:true}]})
    const clients = Object.fromEntries(["server-one", "server-two"].map(server => [server, {project:{directories:({scopeID}) => new Promise((resolve,reject)=>requests.push({server,scopeID,resolve:()=>resolve({data:result(scopeID)}),reject:()=>reject(new Error("Directory unavailable"))}))}}]))
    window.fixture = {select,scopeTo,connect,switchOwner:()=>batch(()=>{connect("server-two");scopeTo("two")}),requests,release:index=>requests[index].resolve(),fail:index=>requests[index].reject(),refresh:()=>controls.get(id()).refetch()}
    function SessionView(props) {
      const [directories, actions] = createProjectDirectoryResource(() => ({client:clients[props.owner.server],scopeID:props.owner.scopeID}))
      controls.set(props.owner.sessionID, actions)
      const main = createMemo(() => directories.latest?.data?.folders[0]?.path)
      return <><header>Session {props.owner.sessionID}</header><p data-directories>{main() ?? "Loading folders"}</p><p data-error>{directories.latest?.error}</p><Show when={directories.loading}><span data-loading>Refreshing folders</span></Show><p data-optimistic>Captured submission {props.owner.sessionID}</p><input aria-label="composer" /></>
    }
    render(()=><ViewResidencyProvider><RetainedSessionViews owner={{server:connection(),scopeID:scope(),sessionID:id(),generation:"1"}} render={owner=><Suspense fallback={<p data-fallback>Waiting for session</p>}><SessionView owner={owner}/></Suspense>}/></ViewResidencyProvider>,document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../../src") }],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function select(id: string) {
  await page.evaluate((id) => (window as unknown as { fixture: { select(id: string): void } }).fixture.select(id), id)
}
async function release(index: number) {
  await page.evaluate(
    (index) => (window as unknown as { fixture: { release(index: number): void } }).fixture.release(index),
    index,
  )
}
async function waitRequests(count: number) {
  await page.waitForFunction(
    (count) => (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests.length === count,
    count,
  )
}
const active = () => page.locator("[data-session-resident]:not([hidden])")

test("cold and evicted Session views retain the shell, composer and captured submission while folders are pending", async () => {
  await page.goto(server.url)
  await waitRequests(1)
  expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
  expect(await active().locator("[data-optimistic]").innerText()).toBe("Captured submission A")
  expect(await page.locator("[data-fallback]").count()).toBe(0)
  await release(0)
  await active().getByText("/one", { exact: true }).waitFor()
  const editor = await active().getByRole("textbox", { name: "composer" }).elementHandle()
  await editor!.fill("retained draft")
  await select("B")
  await waitRequests(2)
  expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
  expect(await active().locator("[data-optimistic]").innerText()).toBe("Captured submission B")
  await release(1)
  await active().getByText("/one", { exact: true }).waitFor()
  await select("A")
  expect(await active().getByRole("textbox", { name: "composer" }).inputValue()).toBe("retained draft")
  expect(
    await active()
      .getByRole("textbox", { name: "composer" })
      .evaluate((element, old) => element === old, editor),
  ).toBe(true)
  expect(
    await page.evaluate(() => (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests.length),
  ).toBe(2)
  for (const [index, id] of ["C", "D", "E", "F", "G", "H"].entries()) {
    await select(id)
    await waitRequests(index + 3)
    expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
    await release(index + 2)
    await active().getByText("/one", { exact: true }).waitFor()
  }
  await select("A")
  await waitRequests(9)
  expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
  expect(await active().locator("[data-optimistic]").innerText()).toBe("Captured submission A")
  expect(await page.locator("[data-fallback]").count()).toBe(0)
  await release(8)
  expect(errors).toEqual([])
})

test("metadata failures, refreshes and late previous-owner replies stay inside their Session", async () => {
  await page.goto(server.url)
  await waitRequests(1)
  expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
  await page.evaluate(() => (window as unknown as { fixture: { fail(index: number): void } }).fixture.fail(0))
  await active().getByText("Directory unavailable", { exact: true }).waitFor()
  const node = await active().getByRole("textbox", { name: "composer" }).elementHandle()
  await page.evaluate(() => void (window as unknown as { fixture: { refresh(): void } }).fixture.refresh())
  await waitRequests(2)
  expect(
    await active()
      .getByRole("textbox", { name: "composer" })
      .evaluate((element, old) => element === old, node),
  ).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: { switchOwner(): void } }).fixture.switchOwner())
  await waitRequests(3)
  expect(await active().locator("[data-directories]").innerText()).toBe("Loading folders")
  expect(await active().getByRole("textbox", { name: "composer" }).count()).toBe(1)
  await release(2)
  await active().getByText("/two", { exact: true }).waitFor()
  await release(1)
  expect(await active().locator("[data-directories]").innerText()).toBe("/two")
  expect(await active().locator("[data-error]").innerText()).toBe("")
  expect(await page.locator("[data-fallback]").count()).toBe(0)
  expect(errors).toEqual([])
})
