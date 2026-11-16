import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

type ConfirmFixture = {
  ask(): void
  action(): void
  other(): void
  retire(): void
  facts(): { answers: boolean[]; confirmed: number; dismissed: number }
}
declare global {
  interface Window {
    __ownedConfirmFixture__?: ConfirmFixture
  }
}
let browser: Browser, server: BrowserFixture, directory: string
const source = path.resolve(import.meta.dir, "../../../src")
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.confirm-owned-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {Toast} from "@ericsanchezok/synergy-ui/toast"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {useConfirm} from ${JSON.stringify(`/@fs/${source}/components/dialog/confirm-dialog.tsx`)}
    import "@ericsanchezok/synergy-ui/styles"
    function Fixture() {
      const owner=useConfirm(),other=useConfirm(),answers=[]
      let confirmed=0,dismissed=0
      const base={title:"Owner confirmation",description:"Private owner action",confirmLabel:"Apply owner action",tone:"warning"}
      const port=window.__ownedConfirmFixture__={
        ask(){void owner.ask(base).then(value=>answers.push(value))},
        action(){owner.show({...base,onConfirm:async()=>{try{await window.hostConfirm()}finally{window.hostDelivered()}},onConfirmed:()=>confirmed++,onDismiss:()=>dismissed++})},
        other(){other.show({title:"Other confirmation",description:"Separate owner action",confirmLabel:"Apply other action",tone:"warning",onConfirm(){}})},
        retire(){owner.closeOwned()},facts(){return {answers:[...answers],confirmed,dismissed}}
      }
      return <><button onClick={()=>port.ask()}>Ask owner</button><button onClick={()=>port.action()}>Owner action</button></>
    }
    render(()=><ThemeProvider><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><Fixture/><Toast.Region/></DialogProvider></I18nProvider></ThemeProvider>,document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: false,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test("closing one confirmation owner preserves another and allows a new owned confirmation", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  try {
    await page.goto(server.url)
    await page.getByRole("button", { name: "Ask owner", exact: true }).click()
    await page.getByRole("dialog", { name: "Owner confirmation", exact: true }).waitFor()
    await page.evaluate(() => window.__ownedConfirmFixture__!.other())
    await page.getByRole("dialog", { name: "Other confirmation", exact: true }).waitFor()
    expect(await page.locator('[role="dialog"]').count()).toBe(2)
    await page.evaluate(() => window.__ownedConfirmFixture__!.retire())
    await page.waitForFunction(() => window.__ownedConfirmFixture__?.facts().answers.length === 1)
    expect(await page.locator('[role="dialog"]').count()).toBe(1)
    expect(await page.getByRole("dialog", { name: "Other confirmation", exact: true }).count()).toBe(1)
    expect(await page.evaluate(() => window.__ownedConfirmFixture__!.facts().answers)).toEqual([false])
    await page.evaluate(() => window.__ownedConfirmFixture__!.ask())
    await page
      .getByRole("dialog", { name: "Owner confirmation", exact: true })
      .getByRole("button", { name: "Apply owner action", exact: true })
      .click()
    await page.waitForFunction(() => window.__ownedConfirmFixture__?.facts().answers.length === 2)
    expect(await page.evaluate(() => window.__ownedConfirmFixture__!.facts().answers)).toEqual([false, true])
    expect(await page.getByRole("dialog", { name: "Other confirmation", exact: true }).count()).toBe(1)
  } finally {
    await page.close()
  }
})

for (const outcome of ["success", "failure"] as const)
  test(`retiring a pending confirmation ignores its late ${outcome} without closing another owner`, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>()
    let accepted = 0
    await page.exposeFunction("hostDelivered", () => delivered.resolve())
    await page.exposeFunction("hostConfirm", async () => {
      accepted++
      entered.resolve()
      await release.promise
      if (outcome === "failure") throw new Error("Retired confirmation failed")
    })
    try {
      await page.goto(server.url)
      await page.getByRole("button", { name: "Owner action", exact: true }).click()
      await page.getByRole("dialog").getByRole("button", { name: "Apply owner action", exact: true }).click()
      await entered.promise
      await page.evaluate(() => window.__ownedConfirmFixture__!.other())
      await page.getByRole("dialog", { name: "Other confirmation", exact: true }).waitFor()
      await page.evaluate(() => window.__ownedConfirmFixture__!.retire())
      expect(await page.locator('[role="dialog"]').count()).toBe(1)
      expect(await page.evaluate(() => window.__ownedConfirmFixture__!.facts())).toMatchObject({
        confirmed: 0,
        dismissed: 1,
      })
      release.resolve()
      await delivered.promise
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      expect(accepted).toBe(1)
      expect(await page.evaluate(() => window.__ownedConfirmFixture__!.facts())).toMatchObject({
        confirmed: 0,
        dismissed: 1,
      })
      expect(await page.getByRole("dialog", { name: "Other confirmation", exact: true }).count()).toBe(1)
      expect(await page.getByRole("alert").count()).toBe(0)
      expect(await page.locator('[data-component="toast"]').count()).toBe(0)
    } finally {
      release.resolve()
      await page.close()
    }
  })
