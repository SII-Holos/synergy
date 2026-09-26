import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".agenda-series-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {AgendaSeriesList} from ${JSON.stringify(`/@fs/${source}/components/agenda/series-list.tsx`)}
    import {CalendarGrid} from ${JSON.stringify(`/@fs/${source}/components/agenda/calendar.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/components/agenda/agenda-dialog.css`)}
    import {messages as en} from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import {messages as zh} from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const locale=new URLSearchParams(location.search).get("locale") || "en"
    const i18n=setupI18n({locale,messages:{en,"zh-CN":zh}})
    const items=[{id:"frequent", title:"Frequent series",status:"active",state:{lastRunStatus:"error",lastRunAt:1000,lastRunError:"Timed out"}},{id:"todo",title:"Pending item",status:"pending"},{id:"paused",title:"Paused series",status:"paused",state:{lastRunAt:2000}}]
    const events=Array.from({length:200},(_,i)=>({id:String(i),itemId:"frequent",time:i*60000}))
    function App(){const [selected,setSelected]=createSignal("");return <main style="padding:24px"><CalendarGrid viewMode="list" anchor={new Date(2026,8,25).getTime()} events={[]} listContent={<AgendaSeriesList items={items} events={events} onSelect={(item)=>setSelected(item.id)}/>}/><output>{selected()}</output></main>}
    render(()=> <I18nProvider i18n={i18n}><App/></I18nProvider>,document.getElementById("root"))
  `,
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import {useLingui} from "@lingui/solid"
    import {createIntlFormatter} from ${JSON.stringify(`/@fs/${source}/context/locale/formatter.ts`)}
    export const useLocale=()=>({i18n:useLingui().i18n(),fmt:createIntlFormatter(()=>new URLSearchParams(location.search).get("locale") || "en")})
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("a dense series stays one row, exposes planned times and keeps unknown run states distinct", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Frequent series Active", exact: true }).waitFor({ timeout: 3000 })
  expect(await page.getByRole("article").count()).toBe(3)
  const frequent = page.getByRole("button", { name: "Frequent series Active", exact: true })
  await frequent.press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("frequent")
  await page.getByText("Preview 200 planned times", { exact: true }).click()
  expect(await page.getByRole("listitem").count()).toBe(200)
  expect(await page.getByText("No run record available", { exact: true }).count()).toBe(1)
  expect(await page.getByText("Latest run status unavailable", { exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Last run failed", exact: true }).click()
  expect(await page.getByRole("article").count()).toBe(1)
  expect(await page.getByText("Timed out", { exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Pending", exact: true }).click()
  expect(await page.getByRole("article").count()).toBe(1)
  expect(await page.getByRole("button", { name: "Pending item Pending", exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  expect(errors).toEqual([])
})

test("the narrow calendar toolbar keeps its date range and view controls readable", async () => {
  await page.goto(baseUrl + "?locale=zh-CN")
  const title = page.locator(".agenda-calendar-toolbar > span")
  await title.waitFor({ state: "visible" })
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of ["今天", "上一时间范围", "下一时间范围", "列表", "日", "周", "月"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  }
})
