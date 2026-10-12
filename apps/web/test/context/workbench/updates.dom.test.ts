import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import { createBrowserFixture } from "../../support/browser-fixture"

test("a panel publishing the same title and dirty state performs no repeated layout writes", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".updates-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    const [tabs, setTabs] = createSignal([{id:"note",panelId:"notes",title:"Note"}])
    window.writes = 0
    const side = {tabs, setTabs(value) { if (++window.writes > 10) throw Error("Repeated layout write"); setTabs(value) }, active:()=>"note", opened:()=>true}
    export const useLayout = () => ({ surface: (_,name) => name === "side" ? side : {tabs:()=>[],active:()=>undefined}, sidebar:{occupiedWidth:()=>0} })
    export const useParams = () => ({ dir:"scope",id:"session" })
    export const useLocale = () => ({i18n:{_:value=>value.message}})
    export const useConfirm = () => ({ask:async()=>true})
    export const useDialog = () => ({})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createEffect, createSignal } from "solid-js"
    import { WorkbenchPanelsProvider, useWorkbenchPanels } from "@/context/workbench"
    function Panel() {
      const panels = useWorkbenchPanels()
      const [title, setTitle] = createSignal("Edited note")
      window.rename = setTitle
      createEffect(() => panels.updateTab("note", {title:title(),dirty:true}))
      return <span>{panels.surface("side").tabs()[0].title}</span>
    }
    render(()=><WorkbenchPanelsProvider><Panel/></WorkbenchPanelsProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  const fixture = await createBrowserFixture({
    root: directory,
    aliases: [
      ...[
        "@/context/session-route",
        "@/context/locale",
        "@/components/dialog/confirm-dialog",
        "@ericsanchezok/synergy-ui/context/dialog",
        "../layout",
      ].map((find) => ({ find, replacement: services })),
      { find: "@", replacement: source },
    ],
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(fixture.url)
    await page.getByText("Edited note", { exact: true }).waitFor()
    await page.waitForTimeout(30)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { writes: number }).writes)).toBe(1)
    await page.evaluate(() => (window as unknown as { rename(value: string): void }).rename("Renamed note"))
    await page.getByText("Renamed note", { exact: true }).waitFor()
    expect(await page.evaluate(() => (window as unknown as { writes: number }).writes)).toBe(2)
  } finally {
    await browser.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
