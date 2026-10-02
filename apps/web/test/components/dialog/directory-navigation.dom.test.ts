import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

type Fixture = {
  results: { directory: string | string[] }[]
  requests: string[]
}
let fixture: string
let server: ViteDevServer
let browser: Browser
let page: Page
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const facts = () => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture)

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".directory-navigation-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "bridge.ts"),
    `
    const tree={"/fixture":["Projects","Other","Bulk"],"/fixture/Projects":["des-intelli","sibling"],"/fixture/Projects/des-intelli":["src","docs"],"/fixture/Other":[],"/fixture/Bulk":Array.from({length:20},(_,i)=>"Long selected folder "+i)}
    export const h=window.fixture={results:[],requests:[]}
    const client={global:{filesystem:{
      async directories({path}){h.requests.push(path);return {data:{path,parent:path==="/fixture"?null:path.slice(0,path.lastIndexOf("/")),entries:(tree[path]??[]).map(name=>({name,path:path+"/"+name}))}}},
      async browse(){return {data:[]}}
    }}}
    export const useGlobalSDK=()=>({client,url:"http://server"})
    export const useGlobalSync=()=>({data:{paths:{home:"/fixture"}}})
    export const serverDisplayName=()=>"Test computer"
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import "@ericsanchezok/synergy-ui/styles/tailwind"
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DialogSelectDirectory} from ${JSON.stringify(`/@fs/${appSrc}/components/dialog/dialog-select-directory.tsx`)}
    import {h} from "./bridge"
    function App(){const dialog=useDialog();return <button onClick={()=>dialog.show(()=><DialogSelectDirectory multiple={!location.search} onSelect={result=>h.results.push(result)}/>)}>Open picker</button>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const port = await fixturePort()
  const bridge = path.join(fixture, "bridge.ts")
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid(), tailwindcss()],
    resolve: {
      alias: [
        ...["@/context/global-sdk", "@/context/global-sync", "@/context/server"].map((find) => ({
          find,
          replacement: bridge,
        })),
        { find: "@", replacement: appSrc },
      ],
    },
    optimizeDeps: { include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

async function open(single = false) {
  errors.length = 0
  await page.goto(base + (single ? "?single" : ""))
  await page.getByRole("button", { name: "Open picker", exact: true }).click()
  await page.getByRole("button", { name: "Projects", exact: true }).waitFor()
}

async function selectFolder(name: string) {
  const checkbox = page.getByRole("checkbox", { name: `Select folder: ${name}`, exact: true })
  await page
    .locator('[data-component="checkbox"]')
    .filter({ has: checkbox })
    .locator('[data-slot="checkbox-checkbox-control"]')
    .click()
  expect(await checkbox.isChecked()).toBe(true)
}

test("browsing into a project returns only the deliberately selected folder", async () => {
  await open()
  await page.getByRole("button", { name: "Projects", exact: true }).click()
  await page.getByRole("button", { name: "des-intelli", exact: true }).waitFor()
  expect(await page.getByText("0 folders selected", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "Use selected folders", exact: true }).isEnabled()).toBe(false)
  await selectFolder("des-intelli")
  await page.getByRole("button", { name: "Use selected folders", exact: true }).click()
  expect((await facts()).results).toEqual([{ directory: ["/fixture/Projects/des-intelli"] }])
  expect(errors).toEqual([])
}, 20_000)

test("explicit choices survive navigation without selecting any ancestors", async () => {
  await open()
  await selectFolder("Other")
  expect((await facts()).requests).toEqual(["/fixture"])
  await page.getByRole("button", { name: "Projects", exact: true }).click()
  await page.getByRole("button", { name: "des-intelli", exact: true }).click()
  await page.getByRole("button", { name: "Select this folder", exact: true }).click()
  await page.getByRole("button", { name: "Use selected folders", exact: true }).click()
  expect((await facts()).results).toEqual([{ directory: ["/fixture/Other", "/fixture/Projects/des-intelli"] }])
  expect(errors).toEqual([])
}, 20_000)

test("folder selection and keyboard navigation are independent", async () => {
  await open()
  const checkbox = page.getByRole("checkbox", { name: "Select folder: Projects", exact: true })
  await checkbox.focus()
  await page.keyboard.press("Space")
  expect(await checkbox.isChecked()).toBe(true)
  expect((await facts()).requests).toEqual(["/fixture"])
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Projects", exact: true }).focus()
  await page.keyboard.press("ArrowRight")
  await page.getByRole("button", { name: "des-intelli", exact: true }).waitFor()
  await page.getByRole("button", { name: "des-intelli", exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "src", exact: true }).waitFor()
  expect(await page.getByText("0 folders selected", { exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click()
  expect((await facts()).results).toEqual([])
  expect(errors).toEqual([])
}, 20_000)

test("single-folder browsing confirms the current folder without adding its parent", async () => {
  await open(true)
  await page.getByRole("button", { name: "Projects", exact: true }).click()
  await page.getByRole("button", { name: "des-intelli", exact: true }).click()
  await page.getByRole("button", { name: "src", exact: true }).waitFor()
  await page.getByRole("button", { name: "Use this folder", exact: true }).click()
  expect((await facts()).results).toEqual([{ directory: "/fixture/Projects/des-intelli" }])
  expect(errors).toEqual([])
}, 20_000)

test("selected folders stay visible across browsing and can be deselected independently", async () => {
  await open()
  await selectFolder("Other")
  await page.getByRole("button", { name: "Projects", exact: true }).click()
  await selectFolder("des-intelli")
  const selection = page.getByRole("list", { name: "Selected folders", exact: true })
  expect(await selection.getByText("Other", { exact: true }).isVisible()).toBe(true)
  expect(await selection.getByText("des-intelli", { exact: true }).isVisible()).toBe(true)
  await selection.getByText("Other", { exact: true }).focus()
  expect(await page.getByRole("tooltip").innerText()).toBe("/fixture/Other")
  const removeOther = selection.getByRole("button", { name: "Deselect folder: /fixture/Other", exact: true })
  await removeOther.focus()
  await page.keyboard.press("Enter")
  expect(await page.getByText("1 folder selected", { exact: true }).isVisible()).toBe(true)
  expect(await selection.getByText("Other", { exact: true }).count()).toBe(0)
  expect(
    await selection
      .getByRole("button", { name: "Deselect folder: /fixture/Projects/des-intelli", exact: true })
      .evaluate((el) => el === document.activeElement),
  ).toBe(true)
  await page.getByRole("button", { name: "Use selected folders", exact: true }).click()
  expect((await facts()).results).toEqual([{ directory: ["/fixture/Projects/des-intelli"] }])
  expect(errors).toEqual([])
}, 20_000)

test("many selections keep the confirmation and deselection controls reachable in short narrow layouts", async () => {
  try {
    await page.setViewportSize({ width: 320, height: 540 })
    await open()
    await page.getByRole("button", { name: "Bulk", exact: true }).click()
    for (let i = 0; i < 20; i++) await selectFolder("Long selected folder " + i)
    const selection = page.getByRole("list", { name: "Selected folders", exact: true })
    expect(await selection.getByRole("listitem").count()).toBe(20)
    expect(await page.getByText("20 folders selected", { exact: true }).isVisible()).toBe(true)
    for (const viewport of [
      { width: 320, height: 540 },
      { width: 375, height: 420 },
    ]) {
      await page.setViewportSize(viewport)
      const pathBounds = await page.getByRole("textbox", { name: "Folder path", exact: true }).boundingBox()
      expect(pathBounds).not.toBeNull()
      for (const name of ["Home folder", "Parent folder", "Go"]) {
        const bounds = await page.getByRole("button", { name, exact: true }).boundingBox()
        expect(bounds).not.toBeNull()
        expect(Math.abs(bounds!.y + bounds!.height / 2 - pathBounds!.y - pathBounds!.height / 2)).toBeLessThanOrEqual(1)
      }
      for (const name of ["Clear selection", "Use selected folders"]) {
        const bounds = await page.getByRole("button", { name, exact: true }).boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
      }
    }
    await selection
      .getByRole("button", { name: "Deselect folder: /fixture/Bulk/Long selected folder 19", exact: true })
      .click()
    expect(await page.getByText("19 folders selected", { exact: true }).isVisible()).toBe(true)
    await page.getByRole("button", { name: "Clear selection", exact: true }).focus()
    await page.keyboard.press("Enter")
    expect(await selection.count()).toBe(0)
    expect(await page.getByRole("button", { name: "Use selected folders", exact: true }).isEnabled()).toBe(false)
    expect(
      await page
        .getByRole("button", { name: "Select this folder", exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await page.setViewportSize({ width: 375, height: 812 })
  }
}, 30_000)
