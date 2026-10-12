import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string, server: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".retained-views-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, createEffect, onCleanup, Show } from "solid-js"
    import { RetainedSessionViews } from "@/components/session/retained-session-views"
    import { useViewActivity, ViewResidencyProvider } from "@/context/view-residency"
    import { Virtualizer } from "virtua/solid"
    const [id, select] = createSignal("A"), [scope, scopeTo] = createSignal("one"), [generation, reload] = createSignal("1")
    const [invalidated, invalidate] = createSignal()
    const metrics = { mounts: 0, active: 0, owners: [] }
    window.fixture = { select, scopeTo, reload, invalidate, metrics }
    function VirtualView() {
      let viewport
      return <div data-virtual ref={element=>viewport=element} style="height:200px;width:400px;overflow:auto">
        <Virtualizer data={Array.from({length:200},(_,index)=>index)} scrollRef={viewport} itemSize={40}>
          {index=><div data-virtual-row={index} style="height:40px">Row {index}</div>}
        </Virtualizer>
      </div>
    }
    function View(props) {
      const active = useViewActivity()
      const owner = props.owner
      metrics.mounts++
      createEffect(() => { if (!active()) return; metrics.active++; onCleanup(() => metrics.active--) })
      return <article><h1>{owner.sessionID}</h1><input aria-label="draft" /><details><summary>Expand</summary>Details</details>
        <div data-scroll style="height:100px;overflow:auto"><div style="height:2000px">Body {owner.sessionID}</div></div>
        <button onClick={() => metrics.owners.push(owner.scopeID + "/" + owner.sessionID)}>Owner</button>
        <Show when={active()}><textarea aria-label="composer" /></Show>
        <Show when={location.search.includes("virtual")}><VirtualView/></Show>
      </article>
    }
    render(() => <ViewResidencyProvider><RetainedSessionViews invalidated={invalidated()} owner={{server:"server",scopeID:scope(),sessionID:id(),generation:generation()}} render={owner => <View owner={owner}/>} /></ViewResidencyProvider>,document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../../src") }],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function change(method: "select" | "scopeTo" | "reload", value: string) {
  await page.evaluate(
    ({ method, value }) => {
      const fixture = (window as unknown as { fixture: Record<string, (value: string) => void> }).fixture
      fixture[method](value)
    },
    { method, value },
  )
}
test("warm navigation keeps DOM, reading and disclosure state with captured owners and one active composer", async () => {
  await page.goto(server.url)
  const draft = page.getByRole("textbox", { name: "draft", exact: true })
  await draft.fill("draft A")
  const node = await draft.elementHandle()
  await page.getByText("Expand", { exact: true }).click()
  await page.locator("[data-scroll]").evaluate((el) => {
    el.scrollTop = 675
  })
  await change("select", "B")
  await change("scopeTo", "two")
  await page.getByRole("button", { name: "Owner" }).click()
  await change("scopeTo", "one")
  await change("select", "A")
  expect(await draft.inputValue()).toBe("draft A")
  expect(await draft.evaluate((el, previous) => el === previous, node)).toBe(true)
  expect(await page.locator("[data-session-resident]:not([hidden]) details").getAttribute("open")).not.toBeNull()
  expect(await page.locator("[data-session-resident]:not([hidden]) [data-scroll]").evaluate((el) => el.scrollTop)).toBe(
    675,
  )
  expect(await page.getByRole("textbox", { name: "composer" }).count()).toBe(1)
  await page.getByRole("button", { name: "Owner" }).click()
  expect(
    await page.evaluate(
      () => (window as unknown as { fixture: { metrics: { owners: string[] } } }).fixture.metrics.owners,
    ),
  ).toEqual(["two/B", "one/A"])
  for (let i = 0; i < 20; i++) await change("select", `session-${i}`)
  expect(await page.locator("[data-session-resident]").count()).toBe(6)
  expect(
    await page.evaluate(
      () => (window as unknown as { fixture: { metrics: { active: number } } }).fixture.metrics.active,
    ),
  ).toBe(1)
  await change("reload", "2")
  expect(await page.locator("[data-session-resident]").count()).toBe(1)
  expect(errors).toEqual([])
})

test("deleted cached owners are removed and never resurrected by an unchanged route", async () => {
  await page.goto(server.url)
  await page.getByRole("textbox", { name: "draft", exact: true }).fill("deleted draft")
  await change("select", "B")
  await page.evaluate(() =>
    (
      window as unknown as { fixture: { invalidate(value: { scopeID: string; sessionID: string }): void } }
    ).fixture.invalidate({ scopeID: "one", sessionID: "A" }),
  )
  expect(await page.locator("[data-session-resident]").count()).toBe(1)
  await change("select", "A")
  expect(await page.getByRole("textbox", { name: "draft", exact: true }).count()).toBe(0)
  await change("select", "C")
  expect(await page.getByRole("textbox", { name: "draft", exact: true }).inputValue()).toBe("")
  expect(errors).toEqual([])
})

test("scroll events delivered after hiding cannot replace the retained virtual window", async () => {
  await page.goto(server.url + "?virtual")
  const viewport = page.locator("[data-virtual]")
  await viewport.evaluate((element) => {
    element.scrollTop = 6000
  })
  await page.waitForFunction(() => document.querySelector('[data-virtual-row="150"]'))
  const node = await viewport.elementHandle()
  const keys = await viewport
    .locator("[data-virtual-row]")
    .evaluateAll((elements) => elements.map((el) => el.getAttribute("data-virtual-row")))
  await change("select", "B")
  await node!.evaluate((element) => element.dispatchEvent(new Event("scroll")))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(
    await node!.evaluate((element) =>
      [...element.querySelectorAll("[data-virtual-row]")].map((el) => el.getAttribute("data-virtual-row")),
    ),
  ).toEqual(keys)
  await change("select", "A")
  expect(await node!.evaluate((element) => element.scrollTop)).toBe(6000)
  expect(errors).toEqual([])
})
