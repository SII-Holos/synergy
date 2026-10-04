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
  const sdkFile = path.join(fixture, "sdk.ts")
  await Bun.write(sdkFile, "export const useSDK=()=>window.fixture.sdk")
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
    import {ensureSynergyHighlightTheme} from "@ericsanchezok/synergy-ui/context/marked"
    import {RollbackDialog} from ${JSON.stringify(`/@fs/${appSrc}/components/session/rollback-dialog.tsx`)}
    import {i18n} from "./locale"
    await ensureSynergyHighlightTheme()
    const h=window.fixture={calls:[],previews:0,resolve:()=>{},reject:()=>{},locale:()=>i18n.activate("zh-CN")}
    const sdk=h.sdk={url:"test",scopeKey:"scope",client:{session:{files:{preview:async()=>({data:{id:"preview-"+(++h.previews),expiresAt:Date.now()+60000,files:["a.txt","b.txt"].map(file=>({file,workspace:{id:"wsp_a",generation:1,root:"/project"},version:{entry:"version"},before:"changed",after:"baseline",action:"replace",binary:false,truncated:false}))}}),restore:(input,options)=>{h.calls.push({input,options});return new Promise((resolve,reject)=>{h.resolve=()=>resolve({data:{restoredFiles:["/a.txt"],failedFiles:[{file:"/b.txt",code:"conflict",message:"File changed"}],patchPartIDs:[]}});h.reject=()=>reject(new Error("Workspace unavailable"))})}},unrollback:async()=>{throw new Error("Redo must remain disabled")}}}}
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
    resolve: {
      alias: {
        "@/context/locale": locale,
        "@/context/sdk": sdkFile,
        "@": appSrc,
        lru_map: Bun.resolveSync("lru_map", path.resolve(appSrc, "../../../packages/ui")),
      },
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "lru_map"],
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

test("restore requires a preview, blocks duplicate clicks and retains partial failures for review", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByRole("button", { name: "Restore files (2)", exact: true }).click()
  const confirm = page.getByRole("button", { name: "Confirm restoration", exact: true })
  await confirm.waitFor()
  await page.getByText("Current content → Content to restore", { exact: true }).waitFor()
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            fixture: {
              calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
              previews: number
              resolve(): void
              reject(): void
            }
          }
        ).fixture.calls.length,
    ),
  ).toBe(0)
  await confirm.click()
  const busy = page.getByRole("button", { name: "Restoring…", exact: true })
  expect(await busy.isEnabled()).toBe(false)
  await busy.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            fixture: {
              calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
              previews: number
              resolve(): void
              reject(): void
            }
          }
        ).fixture.calls,
    ),
  ).toEqual([{ input: { sessionID: "ses_original", previewID: "preview-1" }, options: { throwOnError: true } }])
  await page.evaluate(() =>
    (
      window as unknown as {
        fixture: {
          calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
          previews: number
          resolve(): void
          reject(): void
        }
      }
    ).fixture.resolve(),
  )
  await page.getByRole("alert").filter({ hasText: "/b.txt: File changed" }).waitFor()
  expect(await confirm.isEnabled()).toBe(false)
  await page.getByRole("button", { name: "Refresh preview" }).click()
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          fixture: {
            calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
            previews: number
            resolve(): void
            reject(): void
          }
        }
      ).fixture.previews === 2,
  )
  expect(await confirm.isEnabled()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("lost restore replies can retry the same preview identity without creating another request", async () => {
  await page.goto(base)
  await page.locator("#open").click()
  await page.getByRole("button", { name: "Restore files (2)", exact: true }).click()
  const confirm = page.getByRole("button", { name: "Confirm restoration", exact: true })
  await confirm.click()
  await page.evaluate(() =>
    (
      window as unknown as {
        fixture: {
          calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
          previews: number
          resolve(): void
          reject(): void
        }
      }
    ).fixture.reject(),
  )
  await page.getByRole("alert").filter({ hasText: "Workspace unavailable" }).waitFor()
  expect(await confirm.isEnabled()).toBe(true)
  await confirm.click()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          fixture: {
            calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
            previews: number
            resolve(): void
            reject(): void
          }
        }
      ).fixture.calls.map((call) => call.input.previewID),
    ),
  ).toEqual(["preview-1", "preview-1"])
  await page.evaluate(() =>
    (
      window as unknown as {
        fixture: {
          calls: Array<{ input: { sessionID: string; previewID: string }; options: { throwOnError: boolean } }>
          previews: number
          resolve(): void
          reject(): void
        }
      }
    ).fixture.resolve(),
  )
  await page.getByRole("alert").filter({ hasText: "File changed" }).waitFor()
  await page.keyboard.press("Escape")
  expect(await page.getByRole("button", { name: "Restore files (2)", exact: true }).isVisible()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)
