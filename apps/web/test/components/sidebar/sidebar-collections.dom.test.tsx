import { afterAll, afterEach, beforeAll, beforeEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(30000)

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".sidebar-collections-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "state.tsx"),
    `
    import { createSignal } from "solid-js"
    const query = new URLSearchParams(location.search)
    const [width, resize] = createSignal(Number(query.get("width") || 300))
    const [opened, setOpened] = createSignal(true)
    const [unread, setUnread] = createSignal(1)
    const [loaded, setLoaded] = createSignal(false)
    const [expanded, setExpanded] = createSignal(true)
    const entry = (id, category, title) => ({id,category,title,scopeID:category === "project" ? "project-one" : "home",scopeType:category === "project" ? "project" : "home",lastActivityAt:1,pinned:0,archived:false,tags:["review"]})
    const recent = Array.from({length:60},(_,i)=>entry("recent-"+i,"home","Recent session "+i+" with a deliberately long title to exercise truncation"))
    const home = [entry("home-one","home","Home session")]
    const channel = [{...entry("channel-one","channel","Channel session"),chatId:"chat-one",chatName:"Team channel",channelType:"feishu"}]
    const background = [entry("background-one","background","Background session")]
    const scope = {id:"project-one",directory:"/fixture/project",name:"Project one",worktree:"/fixture/project",get expanded(){return expanded()},time:{created:1,updated:1}}
    export const useLayout = () => ({
      sidebar:{opened,width,resize,close:()=>setOpened(false),toggle:()=>setOpened(!opened())},
      nav:{recentEntries:()=>recent,hasMoreRecent:()=>!loaded(),loadMoreNav:()=>setLoaded(true),
        rootNavEntries:kind=>({home,channel,background})[kind]||[],hasMoreRootNavSection:()=>false,
        scopeIndexLoaded:()=>true,navEntries:()=>({"project-one":{items:[]}}),
        projectNavEntries:()=>[entry("project-session","project","Project session")],
        unreadCompletionCount:unread,acknowledgeAllCompletionNotices:async()=>{setUnread(0);return {acknowledgedCount:1}},
        loadScopeNav:()=>{},
      },
      scopes:{list:()=>[scope],isSupplemental:()=>false,expand:()=>setExpanded(true),collapse:()=>setExpanded(false)},
      channelProjection:()=>({channelAccounts:[]}),
    })
    export const useGlobalSync = () => ({data:{scope:[],provider:{all:[],authHealth:{}}},sessionStatus:{},permissions:{},questions:{},cortex:[]})
    export const useGlobalSDK = () => ({url:"fixture",connected:()=>true,event:{listen:()=>()=>{}},drafts:{hasDraftSession:()=>false},client:{global:{nav:{recent:async({tag})=>({data:{items:[entry("tag-result","home","History matching "+tag)],total:1,nextCursor:null}})}}}})
    export const useHolos = () => ({loaded:false,state:{social:{},identity:{loggedIn:false},connection:{status:"disabled"}}})
    export const useProductUpdate = () => ({notice:()=>({visible:false})})
    export const usePlatform = () => ({platform:"web"})
    export const useTheme = () => ({mode:()=>query.get("mode")||"dark"})
    export const useDialog = () => ({show:()=>{}})
    export const useConfirm = () => async()=>false
    export const useHolosAgentActions = () => ({})
    export const useProjectDirectoryPicker = () => ({pickProjectDirectories:async()=>undefined})
    export const useExtensionOutlet = () => {}
    export const DialogScopeEdit = () => null
    export const SettingsDialog = () => null
    export const SlotOutlet = () => null
    export const Tooltip = props => props.children
    export const showToast = () => {}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {Sidebar} from ${JSON.stringify(`/@fs/${source}/components/sidebar/sidebar.tsx`)}
    import {Router,Route} from "@solidjs/router"
    import {messages as en} from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import {messages as zh} from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/app-shell/mobile-drawer.css`)}
    const locale=new URLSearchParams(location.search).get("locale")||"zh-CN"
    const i18n=setupI18n({locale,messages:{en,"zh-CN":zh}})
    render(()=> <I18nProvider i18n={i18n}><Router><Route path="*all" component={()=> <div style="height:100vh"><Sidebar onSearchOpen={()=>{}}/></div>}/></Router></I18nProvider>,document.getElementById("root"))
  `,
  )
  // Keep the real registry and built-in ordering without loading page implementations.
  await Bun.write(
    path.join(directory, "navigation.ts"),
    `
    import ${JSON.stringify(`/@fs/${source}/plugin/builtin-navigation.tsx`)}
    export {listNavigation,navigationEntryLabel,subscribeNavigation} from ${JSON.stringify(`/@fs/${source}/plugin/registries/navigation-registry.ts`)}
  `,
  )
  const boundaries = [
    "@/context/layout",
    "@/context/global-sync",
    "@/context/global-sdk",
    "@/context/holos",
    "@/context/platform",
    "@/context/product-update",
    "@/components/holos/agent-actions",
    "@/components/dialog/project-directory-picker",
    "@/components/dialog/dialog-scope-edit",
    "@/components/dialog/confirm-dialog",
    "@/components/settings",
    "@/plugin/slot-outlet",
    "@ericsanchezok/synergy-ui/context/extension-outlet",
    "@ericsanchezok/synergy-ui/context/dialog",
    "@ericsanchezok/synergy-ui/theme",
    "@ericsanchezok/synergy-ui/tooltip",
    "@ericsanchezok/synergy-ui/toast",
  ]
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        ...boundaries.map((find) => ({
          find: new RegExp("^" + find + "$"),
          replacement: path.join(directory, "state.tsx"),
        })),
        { find: /^@\/plugin$/, replacement: path.join(directory, "navigation.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`)
  })
})

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(query = "") {
  errors.length = 0
  await page.goto(url + query)
  await page
    .locator(".sb-root")
    .waitFor({ timeout: 10000 })
    .catch((error) => {
      throw new Error([...errors, String(error)].join("\n"))
    })
  expect(errors).toEqual([])
}

test("five vertical categories retain independent disclosure state and unique headings", async () => {
  await open()
  expect(await page.getByRole("tab").count()).toBe(0)
  const categories = ["最近", "首页", "频道", "后台", "项目"]
  for (const [index, label] of categories.entries()) {
    const toggle = page.getByRole("button", { name: label, exact: true })
    expect(await toggle.getAttribute("aria-expanded")).toBe(index === 0 || index === 4 ? "true" : "false")
    expect(await page.getByText(label, { exact: true }).count()).toBe(1)
  }
  for (const [label, title] of [
    ["首页", "Home session"],
    ["频道", "Channel session"],
    ["后台", "Background session"],
  ]) {
    const toggle = page.getByRole("button", { name: label, exact: true })
    await toggle.press("Enter")
    await page.getByText(title, { exact: true }).waitFor({ state: "visible" })
    expect(await page.getByRole("button", { name: "最近", exact: true }).getAttribute("aria-expanded")).toBe("true")
  }
  for (const title of ["Home session", "Channel session", "Background session", "Project session"])
    expect(await page.getByText(title, { exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "最近", exact: true }).press("Space")
  expect(await page.locator('[data-session-id="recent-0"]').isVisible()).toBe(false)
  expect(await page.locator('[data-session-id="recent-0"]').evaluate((el) => !!el.closest("[inert]"))).toBe(true)
  expect(await page.getByText("Home session", { exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "最近", exact: true }).press("Enter")
  expect(await page.locator('[data-session-id="recent-0"]').isVisible()).toBe(true)
  expect(errors).toEqual([])
})

test("tools precede tags and vertical categories while the list scrolls independently", async () => {
  await open()
  const before = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
    return {
      tools: rect(".sb-globals").bottom,
      tags: rect(".sb-session-tag-filter").bottom,
      recent: rect(".sb-recent-header").top,
      account: rect(".sidebar-account-hub").top,
    }
  })
  expect(before.tools).toBeLessThan(before.tags)
  expect(before.tags).toBeLessThanOrEqual(before.recent)
  expect(await page.locator(".sb-global-btn").allTextContents()).toEqual(["日程", "看板", "知识库", "性能", "插件"])
  await page.locator(".sb-scroll").evaluate((element) => {
    element.scrollTop = 500
  })
  expect(await page.locator(".sb-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await page.locator(".sb-globals").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    before.tools,
  )
  expect(await page.locator(".sidebar-account-hub").evaluate((element) => element.getBoundingClientRect().top)).toBe(
    before.account,
  )
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(800)
})

for (const width of [230, 300, 420])
  test(`categories stay within a ${width}px sidebar in both locales`, async () => {
    for (const locale of ["zh-CN", "en"]) {
      await open(`?width=${width}&locale=${locale}`)
      const geometry = await page.evaluate(() => {
        const root = document.querySelector(".sb-root")!
        const list = document.querySelector(".sb-scroll")!
        const bounds = root.getBoundingClientRect()
        return {
          listInside: list.getBoundingClientRect().right <= bounds.right,
          contentOverflow: list.scrollWidth - list.clientWidth,
          outside: [...list.querySelectorAll("button,input")].filter((element) => {
            if (element.closest("[inert]")) return false
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && (rect.left < bounds.left || rect.right > bounds.right)
          }).length,
        }
      })
      expect(geometry).toEqual({ listInside: true, contentOverflow: 0, outside: 0 })
    }
  })

test("tag search retains global results, recent pagination and unread acknowledgement", async () => {
  await open()
  await page.getByRole("button", { name: "全部标为已读", exact: true }).click()
  expect(await page.getByRole("button", { name: "全部标为已读", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "加载更多", exact: true }).click()
  expect(await page.getByRole("button", { name: "加载更多", exact: true }).count()).toBe(0)
  const tags = page.getByRole("searchbox")
  await tags.fill("review")
  await tags.press("Enter")
  await page.getByText("History matching review", { exact: true }).waitFor()
  await page.getByRole("button", { name: "全部", exact: true }).click()
  expect(await page.locator('[data-session-id="recent-0"]').isVisible()).toBe(true)
  await page.reload()
  await page.locator('[data-session-id="recent-0"]').waitFor()
  expect(errors).toEqual([])
})

test("nested channel and project disclosures remain keyboard-operable", async () => {
  await open()
  await page.getByRole("button", { name: "频道", exact: true }).press("Enter")
  const channel = page.getByRole("button", { name: "Team channel", exact: true })
  await channel.press("Enter")
  await page.getByText("Channel session", { exact: true }).waitFor({ state: "hidden" })
  await channel.press("Space")
  await page.getByText("Channel session", { exact: true }).waitFor({ state: "visible" })
  await page.getByRole("button", { name: "折叠项目", exact: true }).press("Enter")
  await page.getByText("Project session", { exact: true }).waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "展开项目", exact: true }).press("Space")
  await page.getByText("Project session", { exact: true }).waitFor({ state: "visible" })
  expect(errors).toEqual([])
})
