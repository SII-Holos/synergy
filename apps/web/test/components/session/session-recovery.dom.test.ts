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
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".session-recovery-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `import { setupI18n } from "@lingui/core"; import { messages } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}; export const i18n = setupI18n({locale:"en",messages:{en:messages}}); export const useLocale = () => ({i18n});`,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createStore } from "solid-js/store"
    import { I18nProvider } from "@lingui/solid"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
    import { SessionInbox } from ${JSON.stringify(`/@fs/${source}/components/session/session-inbox.tsx`)}
    import { PendingTimelineItem } from ${JSON.stringify(`/@fs/${source}/components/session/pending-timeline-item.tsx`)}
    import { SessionTransitionCard } from ${JSON.stringify(`/@fs/${source}/components/session/session-transition-card.tsx`)}
    import { createNewSessionTransitionAcceptedProgress, createSessionTransitionHandoffErrorProgress } from ${JSON.stringify(`/@fs/${source}/components/session/session-transition-progress.ts`)}
    import { i18n } from "./locale"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const item = { id: "inb_one", sessionID: "s1", messageID: "m1", mode: "steer", summary: { title: "Original direction", preview: "Preserve my direction" }, source: {type:"user"}, time:{created:1}, orderKey:"1", message:{parts:[{type:"text",text:"Preserve my direction"}],variant:"high"} }
    const [data, setData] = createStore({ inbox: {s1:[item]}, session:[], message:{}, part:{} })
    window.removedItems = []
    window.activeItems = [item]
    window.removeCalls = 0
    window.restoreCalls = 0
    const client = { session: {
      inboxRemoved: async () => ({data:window.removedItems}),
      inboxRemove: async () => { window.removeCalls++; if (window.failRemove) throw {data:{message:"Removal offline"}}; window.removedItems = [item]; window.activeItems = []; },
      inboxRestore: async () => { window.restoreCalls++; if (window.failRestore) throw {data:{message:"Restore offline"}}; window.removedItems = []; window.activeItems = [item]; if (window.lostRestore) throw new Error("Lost response"); },
    } }
    const sync = { data, session: { refresh: async () => setData("inbox", "s1", window.activeItems) } }
    const accepted = createNewSessionTransitionAcceptedProgress()
    const failed = createSessionTransitionHandoffErrorProgress({ kind:accepted.kind,steps:accepted.steps,error:{code:"ProviderUnavailable",message:"Diagnostic preserved"} })
    const mode = new URLSearchParams(location.search).get("mode")
    render(() => <I18nProvider i18n={i18n}><MarkedProvider><DialogProvider>
      {mode === "pending" ? <PendingTimelineItem item={{...item,mode:"task",status:"failed",failReason:"Attachment invalid"}} rollbackActive={false} hasCanonicalRoot={false} onRemove={async () => {window.removeCalls++; await new Promise(resolve => setTimeout(resolve, 150)); if (window.failRemove) throw new Error("Removal offline")}} /> : mode === "transition" ? <SessionTransitionCard progress={failed} onRetry={() => {window.retryCount = (window.retryCount ?? 0)+1}} /> : <SessionInbox sessionID="s1" sdk={{client}} sync={sync} />}
    </DialogProvider></MarkedProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: { alias: { "@/context/locale": path.join(directory, "locale.ts"), "@": source } },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod", "fuzzysort"],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface RecoveryWindow extends Window {
  failRemove: boolean
  failRestore: boolean
  lostRestore: boolean
  removeCalls: number
  restoreCalls: number
  retryCount: number
}

test("failed removal retains the message and restoration is visible and retryable", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Session inbox", exact: true }).click()
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRemove = true))
  await page.getByRole("button", { name: "Queued message actions", exact: true }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("button", { name: "Retry removal" }).waitFor()
  expect(await page.getByRole("button", { name: /Preserve my direction/ }).count()).toBe(1)
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRemove = false))
  await page.getByRole("button", { name: "Retry removal" }).click()
  await page.getByRole("heading", { name: "Removed messages" }).waitFor()
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRestore = true))
  await page.getByRole("button", { name: "Restore", exact: true }).click()
  await page.getByRole("button", { name: "Retry restore" }).waitFor()
  await page.getByText("Error details", { exact: true }).click()
  await page.getByText("Restore offline", { exact: true }).waitFor()
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRestore = false))
  await page.getByRole("button", { name: "Retry restore" }).click()
  await page.getByRole("button", { name: /Preserve my direction/ }).waitFor()
  expect(await page.getByRole("heading", { name: "Removed messages" }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("lost restore response is checked before another restore request", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Session inbox", exact: true }).click()
  await page.getByRole("button", { name: "Queued message actions", exact: true }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("heading", { name: "Removed messages" }).waitFor()
  await page.evaluate(() => ((window as unknown as RecoveryWindow).lostRestore = true))
  await page.getByRole("button", { name: "Restore", exact: true }).click()
  await page.getByRole("button", { name: "Retry restore" }).click()
  await page.getByRole("button", { name: /Preserve my direction/ }).waitFor()
  expect(await page.evaluate(() => (window as unknown as RecoveryWindow).restoreCalls)).toBe(1)
  expect(errors).toEqual([])
})

test("failed initialization stops spinners and exposes one recovery action with diagnostics at 375px", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${url}?mode=transition`)
  await page.getByRole("alert").waitFor()
  expect(await page.locator(".session-transition-step-spinner").count()).toBe(0)
  expect(await page.getByText("Failed", { exact: true }).count()).toBe(1)
  await page.getByText("Error details", { exact: true }).click()
  await page.getByText("ProviderUnavailable: Diagnostic preserved").waitFor()
  await page.getByRole("button", { name: "Retry initialization" }).click()
  expect(await page.evaluate(() => (window as unknown as RecoveryWindow).retryCount)).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test("failed initial message has an accurate status and its timeline withdrawal can recover", async () => {
  await page.setViewportSize({ width: 800, height: 812 })
  await page.goto(`${url}?mode=pending`)
  await page.getByText("Failed", { exact: true }).waitFor()
  expect(await page.getByText("Paused", { exact: true }).count()).toBe(0)
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRemove = true))
  const withdraw = page.getByRole("button", { name: "Withdraw", exact: true })
  await withdraw.click()
  expect(await withdraw.isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Retry removal" }).waitFor()
  expect(await page.getByText("Preserve my direction", { exact: true }).count()).toBe(1)
  await page.evaluate(() => ((window as unknown as RecoveryWindow).failRemove = false))
  await page.getByRole("button", { name: "Retry removal" }).click()
  await page.getByRole("alert").waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as unknown as RecoveryWindow).removeCalls)).toBe(2)
  expect(errors).toEqual([])
})
