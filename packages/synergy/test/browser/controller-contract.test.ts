import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CdpPageController, type BrowserAction, type BrowserBackendResult } from "@ericsanchezok/synergy-browser"
import { chromium, type Browser, type Page } from "playwright"
import { PlaywrightCdpTransport } from "../../src/browser/playwright-cdp-transport"

let browser: Browser
let page: Page
let transport: PlaywrightCdpTransport
let controller: CdpPageController

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  transport = new PlaywrightCdpTransport(page)
  controller = new CdpPageController({ pageId: "contract-page", transport })
})

afterAll(async () => {
  await controller.dispose()
  await transport.dispose()
  await browser.close()
})

describe("shared CDP page controller contract", () => {
  test("fills, presses, selects, checks, drags, and traverses iframe and shadow DOM locators", async () => {
    await page.setContent(`
      <input aria-label="Name" value="before">
      <input id="check" type="checkbox">
      <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
      <button aria-hidden="true">Continue with Holos</button>
      <button id="continue">Continue with Holos</button>
      <div id="drag" draggable="true" style="width:30px;height:30px"></div><div id="drop" style="width:30px;height:30px"></div>
      <iframe id="child" srcdoc='<button id="inside">Inside frame</button>'></iframe>
      <div id="shadow"></div>
      <script>
        globalThis.events = []
        document.querySelector('#continue').onclick = () => events.push('click')
        document.querySelector('[aria-label=Name]').onkeydown = (event) => events.push(event.key)
        document.querySelector('#drag').ondragstart = () => events.push('dragstart')
        document.querySelector('#drop').ondragover = (event) => event.preventDefault()
        document.querySelector('#drop').ondrop = (event) => { event.preventDefault(); events.push('drop') }
        const root = document.querySelector('#shadow').attachShadow({mode:'open'})
        root.innerHTML = '<button id="shadow-button">Shadow action</button>'
        root.querySelector('button').onclick = () => events.push('shadow')
      </script>
    `)
    await page
      .frameLocator("#child")
      .locator("#inside")
      .evaluate((button) => {
        button.addEventListener("click", () => {
          document.body.dataset.clicked = "yes"
        })
      })

    await action({
      type: "click",
      target: { kind: "role", role: "button", name: "Continue with Holos", exact: true },
    })
    await action({ type: "fill", target: { kind: "label", text: "Name" }, value: "Ada" })
    await action({ type: "press", target: { kind: "label", text: "Name" }, key: "Enter" })
    await action({ type: "setChecked", target: { kind: "css", value: "#check" }, checked: true })
    await action({ type: "setChecked", target: { kind: "css", value: "#check" }, checked: true })
    await action({ type: "select", target: { kind: "role", role: "combobox", name: "Plan" }, values: ["pro"] })
    await action({
      type: "drag",
      from: { kind: "css", value: "#drag" },
      to: { kind: "css", value: "#drop" },
    })
    await action({
      type: "click",
      target: {
        kind: "role",
        role: "button",
        name: "Inside frame",
        framePath: [{ kind: "css", value: "#child" }],
      },
    })
    await action({ type: "click", target: { kind: "role", role: "button", name: "Shadow action" } })

    expect(await page.locator('[aria-label="Name"]').inputValue()).toBe("Ada")
    expect(await page.locator("#check").isChecked()).toBe(true)
    expect(await page.locator('[aria-label="Plan"]').inputValue()).toBe("pro")
    expect(await page.frameLocator("#child").locator("body").getAttribute("data-clicked")).toBe("yes")
    expect(await page.evaluate(() => (globalThis as any).events)).toEqual(
      expect.arrayContaining(["click", "Enter", "dragstart", "drop", "shadow"]),
    )
  })

  test("rejects readonly mutation, permits trusted mutation, and detects obstruction quickly", async () => {
    await expect(
      controller.execute({ type: "evaluate", mode: "readonly", expression: "document.body.dataset.changed = 'yes'" }),
    ).rejects.toMatchObject({ code: "browser_evaluation_failed" })
    await controller.execute({ type: "evaluate", mode: "trusted", expression: "document.body.dataset.changed = 'yes'" })
    expect(await page.locator("body").getAttribute("data-changed")).toBe("yes")

    await page.setContent(`
      <button id="covered" style="position:fixed;left:20px;top:20px;width:120px;height:40px">Covered</button>
      <div role="dialog" aria-label="Blocking overlay" style="position:fixed;inset:0;z-index:10"></div>
    `)
    const started = Date.now()
    await expect(
      action({ type: "click", target: { kind: "css", value: "#covered" }, timeoutMs: 500 }),
    ).rejects.toMatchObject({
      code: "browser_obstructed",
      obstruction: { role: "dialog", name: "Blocking overlay" },
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await controller.execute({ type: "screenshot", target: { kind: "css", value: "#covered" } })).toMatchObject({
      type: "screenshot",
    })
  })

  test("returns stable zero, ambiguous, invalid-selector, and stale-ref errors", async () => {
    await page.setContent("<button>Duplicate</button><button>Duplicate</button>")
    await expect(
      action({ type: "click", target: { kind: "role", role: "button", name: "Missing" } }),
    ).rejects.toMatchObject({
      code: "browser_locator_not_found",
    })
    await expect(
      action({ type: "click", target: { kind: "role", role: "button", name: "Duplicate" } }),
    ).rejects.toMatchObject({
      code: "browser_locator_ambiguous",
    })
    await expect(
      action({ type: "click", target: { kind: "css", value: 'button:has-text("Duplicate")' } }),
    ).rejects.toMatchObject({ code: "browser_invalid_selector" })

    const snapshot = await controller.execute({ type: "snapshot", maxNodes: 100 })
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot")
    const ref = snapshot.elements.find((element) => element.role === "button")?.ref
    if (!ref) throw new Error("Expected button ref")
    await page.goto("data:text/html,<button>Next document</button>")
    await expect(
      action({ type: "click", target: { kind: "ref", snapshotId: snapshot.snapshotId, ref } }),
    ).rejects.toMatchObject({
      code: "browser_stale_ref",
    })
  })

  test("keeps screenshot modes exact and returns bounded reads, inspection, waits, and performance", async () => {
    await page.setContent(`<main><h1>Contract page</h1><button id="target">Target</button></main>`)
    const viewport = await controller.execute({ type: "screenshot" })
    const locator = await controller.execute({ type: "screenshot", target: { kind: "css", value: "#target" } })
    const clip = await controller.execute({ type: "screenshot", clip: { x: 0, y: 0, width: 100, height: 80 } })
    expect(viewport).toMatchObject({ type: "screenshot", width: 800, height: 600 })
    expect(locator).toMatchObject({ type: "screenshot" })
    expect(clip).toMatchObject({ type: "screenshot", width: 100, height: 80 })

    expect(
      await controller.execute({
        type: "wait",
        condition: { type: "text", values: ["Contract page"], match: "all" },
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ type: "wait", matched: true })
    expect(await controller.execute({ type: "read", format: "text", maxChars: 8 })).toMatchObject({
      type: "data",
      data: { truncated: true },
    })
    expect(await controller.execute({ type: "inspect", target: { kind: "css", value: "#target" } })).toMatchObject({
      type: "data",
      data: { tag: "button", listeners: expect.any(Array) },
    })
    expect(await controller.execute({ type: "performance", action: "measure" })).toMatchObject({
      type: "data",
      data: { metrics: expect.any(Object), resources: expect.any(Array) },
    })
  })
})

async function action(value: BrowserAction): Promise<BrowserBackendResult> {
  return controller.execute({ type: "action", action: value })
}
