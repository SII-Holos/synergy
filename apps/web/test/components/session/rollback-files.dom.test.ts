import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".rollback-files-"))
  const locale = path.join(fixture, "locale.ts")
  await Bun.write(
    locale,
    `
    import {setupI18n} from "@lingui/core"
    import {createSignal} from "solid-js"
    import {createReactiveI18n} from ${JSON.stringify(`/@fs/${appSrc}/context/locale/reactive-i18n.ts`)}
    const [generation,setGeneration]=createSignal(0)
    const core=setupI18n({locale:"en",messages:{en:{},"zh-CN":{"session.rollback.partialRestore":"已恢复 {restored} 个文件；{failed} 个文件未能恢复。","session.rollback.filesRestoreFailed":"文件恢复失败","session.rollback.restoreFiles":"恢复文件（{count}）"}}})
    core.on("change",()=>setGeneration(value=>value+1))
    export const i18n=createReactiveI18n(core,generation)
    export const useLocale=()=>({i18n})
  `,
  )
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Toast} from "@ericsanchezok/synergy-ui/toast"
    import {RollbackDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/session/rollback-dialog.tsx`)}
    import {i18n} from "./locale"
    const h=window.fixture={calls:[],resolve:()=>{},reject:()=>{},locale:()=>i18n.activate("zh-CN")}
    const sdk={client:{session:{files:{restore:(input,options)=>{h.calls.push({input,options});return new Promise((resolve,reject)=>{h.resolve=()=>resolve({data:{restoredFiles:["/a.txt"],failedFiles:[{file:"/b.txt",code:"conflict",message:"File changed"}],patchPartIDs:[]}});h.reject=()=>reject(new Error("Workspace unavailable"))})}},unrollback:async()=>{throw new Error("Redo must remain disabled")}}}}
    const rollback=()=>({id:"his_original",numTurns:1,droppedMessageIDs:["msg_original"],files:["/a.txt","/b.txt"],canUnrollback:true})
    function App(){const dialog=useDialog();return <button id="open" onClick={()=>dialog.show(()=><RollbackDialog sessionID="ses_original" rollback={rollback} sdk={sdk}/>)}>Open</button>}
    render(()=><I18nProvider i18n={i18n}><Toast.Region/><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))

  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    resolve: { alias: { "@/context/locale": locale, "@": appSrc } },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("pending file restore disables duplicate submissions and reports partial results", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  const restore = page.getByRole("button", { name: "Restore files (2)", exact: true })
  await restore.click()
  expect(await restore.isEnabled()).toBe(false)
  expect(await page.getByRole("button", { name: "Redo", exact: true }).isEnabled()).toBe(false)
  await restore.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  const calls = await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)
  expect(calls).toEqual([
    { input: { sessionID: "ses_original", rollbackID: "his_original" }, options: { throwOnError: true } },
  ])
  await page.evaluate(() => (window as unknown as { fixture: { resolve(): void } }).fixture.resolve())
  await page.locator('[data-slot="toast-title"]').filter({ hasText: "Failed to restore files" }).waitFor()
  expect(await page.locator('[data-slot="toast-description"]').textContent()).toContain(
    "1 file restored; 1 file could not be restored.",
  )
  expect(await page.locator('[data-slot="toast-description"]').textContent()).toContain("/b.txt: File changed")
  expect(await restore.isEnabled()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("file restoration localizes partial feedback and never displays transport failures as success", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.evaluate(() => (window as unknown as { fixture: { locale(): void } }).fixture.locale())
  const restore = page.getByRole("button", { name: "恢复文件（2）", exact: true })
  await restore.click()
  await page.evaluate(() => (window as unknown as { fixture: { resolve(): void } }).fixture.resolve())
  await page
    .locator('[data-slot="toast-description"]')
    .filter({ hasText: "已恢复 1 个文件；1 个文件未能恢复。" })
    .waitFor()
  await restore.click()
  await page.evaluate(() => (window as unknown as { fixture: { reject(): void } }).fixture.reject())
  await page.locator('[data-slot="toast-description"]').filter({ hasText: "Workspace unavailable" }).waitFor()
  expect(await page.locator('[data-slot="toast-title"]').allTextContents()).toEqual(["文件恢复失败", "文件恢复失败"])
  expect(errors).toEqual([])
}, 30_000)
