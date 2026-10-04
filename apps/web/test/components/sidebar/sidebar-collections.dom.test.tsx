import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
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
    const motion = query.get("motion") === "1"
    const [projects, setProjects] = createSignal(motion ? [
      {id:"project-two",name:"Project two",expanded:true},
      {id:"project-three",name:"Project three",expanded:true},
      {id:"project-one",name:"Project one",expanded:false},
    ] : [{id:"project-one",name:"Project one",expanded:true}])
    const [projectLoaded, setProjectLoaded] = createSignal(query.get("lazy") !== "1")
    const entry = (id, category, title) => ({id,category,title,scopeID:category === "project" ? "project-one" : "home",scopeType:category === "project" ? "project" : "home",lastActivityAt:1,pinned:0,archived:false,tags:["review"]})
    const recent = Array.from({length:60},(_,i)=>entry("recent-"+i,"home","Recent session "+i+" with a deliberately long title to exercise truncation"))
    const home = [entry("home-one","home","Home session")]
    const channel = [{...entry("channel-one","channel","Channel session"),chatId:"chat-one",chatName:"Team channel",channelType:"feishu"}]
    const background = [entry("background-one","background","Background session")]
    const projectEntries = scope => motion
      ? Array.from({length:scope.id === "project-one" ? 10 : 2},(_,i)=>entry(scope.id+"-session-"+i,"project",scope.name+" session "+i))
      : [entry("project-session","project","Project session")]
    const expand = (id, expanded) => setProjects(previous=>previous.map(scope=>scope.id===id ? {...scope,expanded}:scope))
    window.sidebarFixture = {
      refresh:()=>setProjects(previous=>previous.map(scope=>({...scope}))),
      reorder:()=>setProjects(previous=>[previous.at(-1),...previous.slice(0,-1)]),
      finishLoad:()=>setProjectLoaded(true),
    }
    export const useLayout = () => ({
      sidebar:{opened,width,resize,setOccupiedWidth:()=>{},close:()=>setOpened(false),toggle:()=>setOpened(!opened())},
      nav:{recentEntries:()=>recent,hasMoreRecent:()=>!loaded(),loadMoreNav:()=>setLoaded(true),
        rootNavEntries:kind=>({home,channel,background})[kind]||[],hasMoreRootNavSection:()=>false,
        scopeIndexLoaded:()=>true,navEntries:()=>Object.fromEntries(projects().filter(scope=>scope.id!=="project-one"||projectLoaded()).map(scope=>[scope.id,{items:projectEntries(scope)}])),
        projectNavEntries:scope=>scope.id!=="project-one"||projectLoaded() ? projectEntries(scope) : [],
        unreadCompletionCount:unread,acknowledgeAllCompletionNotices:async()=>{setUnread(0);return {acknowledgedCount:1}},
        loadScopeNav:()=>{},
      },
      scopes:{list:()=>projects().map(scope=>({...scope,time:{created:1,updated:1}})),isSupplemental:()=>false,expand:id=>expand(id,true),collapse:id=>expand(id,false)},
      channelProjection:()=>({channelAccounts:[]}),
    })
    export const useGlobalSync = () => ({data:{scope:[],provider:{all:[],authHealth:{}}},sessionStatus:{},permissions:{},questions:{},cortex:[]})
    export const useGlobalSDK = () => ({url:"fixture",connected:()=>true,capabilities:{has:id=>query.get("core")!=="1"||["local-runtime","plugin-host"].includes(id),load:async()=>{}},event:{listen:()=>()=>{}},drafts:{hasDraftSession:()=>false},client:{global:{nav:{recent:async({tag})=>({data:{items:[entry("tag-result","home","History matching "+tag)],total:1,nextCursor:null}})}}}})
    export const useHolos = () => ({loaded:false,state:{social:{},identity:{loggedIn:false},connection:{status:"disabled"}}})
    export const useProductUpdate = () => ({notice:()=>({visible:false})})
    export const usePlatform = () => ({platform:"web"})
    export const useTheme = () => ({mode:()=>query.get("mode")||"dark"})
    export const useDialog = () => ({show:()=>{}})
    export const useCommand = () => ({ trigger() {} })
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
    "@/context/command",
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
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "fuzzysort"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
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

async function projectAction(action: "refresh" | "reorder" | "finishLoad") {
  await page.evaluate((action) => {
    const fixture = (window as unknown as { sidebarFixture: Record<typeof action, () => void> }).sidebarFixture
    fixture[action]()
  }, action)
}

async function prepareProjectMotion(query = "") {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await open(`?motion=1${query}`)
  await page.locator('[data-scope-id="project-one"] .sb-project-chevron-btn').scrollIntoViewIfNeeded()
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  expect(await page.locator(".sb-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(500)
}

function recordProjectMotion() {
  return page.evaluate(
    () =>
      new Promise<Array<{ top: number; scroll: number; heading: number; account: number; transforms: string[] }>>(
        (resolve) => {
          const row = document.querySelector('[data-scope-id="project-one"] .sb-project-row')!
          const list = document.querySelector(".sb-scroll")!
          const heading = document.querySelector(".sb-projects-header-actions")!
          const account = document.querySelector(".sidebar-account-hub")!
          const frames: Array<{ top: number; scroll: number; heading: number; account: number; transforms: string[] }> =
            []
          const started = performance.now()
          const sample = () => {
            frames.push({
              top: row.getBoundingClientRect().top,
              scroll: list.scrollTop,
              heading: heading.getBoundingClientRect().top,
              account: account.getBoundingClientRect().top,
              transforms: [...list.querySelectorAll("[data-scope-id]")].map(
                (element) => getComputedStyle(element).transform,
              ),
            })
            if (performance.now() - started < 500) requestAnimationFrame(sample)
            else resolve(frames)
          }
          sample()
        },
      ),
  )
}

for (const lazy of [false, true])
  test(`project expansion after scrolling keeps its title and sidebar stable (${lazy ? "delayed" : "cached"} sessions)`, async () => {
    await prepareProjectMotion(lazy ? "&lazy=1" : "")
    const toggle = page.locator('[data-scope-id="project-one"] .sb-project-chevron-btn')
    const recording = recordProjectMotion()
    await toggle.click()
    if (lazy) {
      expect(await toggle.getAttribute("aria-busy")).toBe("true")
      await projectAction("finishLoad")
    }
    const frames = await recording
    for (const frame of frames) {
      expect(Math.abs(frame.top - frames[0]!.top)).toBeLessThanOrEqual(1)
      expect(Math.abs(frame.scroll - frames[0]!.scroll)).toBeLessThanOrEqual(1)
      expect(Math.abs(frame.heading - frames[0]!.heading)).toBeLessThanOrEqual(1)
      expect(Math.abs(frame.account - frames[0]!.account)).toBeLessThanOrEqual(1)
      expect(frame.transforms.every((transform) => transform === "none")).toBe(true)
    }
    expect(await page.locator('[data-session-id="project-one-session-0"]').isVisible()).toBe(true)
    expect(await toggle.evaluate((element) => document.activeElement === element)).toBe(true)
    expect(errors).toEqual([])
  })

test("equivalent project refresh after scrolling does not animate existing rows", async () => {
  await prepareProjectMotion()
  const recording = recordProjectMotion()
  await projectAction("refresh")
  const frames = await recording
  expect(frames.every((frame) => frame.transforms.every((transform) => transform === "none"))).toBe(true)
  expect(
    Math.max(...frames.map((frame) => frame.top)) - Math.min(...frames.map((frame) => frame.top)),
  ).toBeLessThanOrEqual(1)
})

test("rapid disclosure reversals retain the project title, focus and sibling disclosures", async () => {
  await prepareProjectMotion("&width=230&mode=light")
  const toggle = page.locator('[data-scope-id="project-one"] .sb-project-chevron-btn')
  const recording = recordProjectMotion()
  await toggle.click()
  await toggle.press("Space")
  await toggle.press("Enter")
  const frames = await recording
  expect(
    Math.max(...frames.map((frame) => frame.top)) - Math.min(...frames.map((frame) => frame.top)),
  ).toBeLessThanOrEqual(1)
  expect(await toggle.getAttribute("aria-expanded")).toBe("true")
  expect(await toggle.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(
    await page.locator('[data-scope-id="project-two"] .sb-project-chevron-btn').getAttribute("aria-expanded"),
  ).toBe("true")
  expect(
    await page.locator('[data-scope-id="project-three"] .sb-project-chevron-btn').getAttribute("aria-expanded"),
  ).toBe("true")
  expect(errors).toEqual([])
})

test("reordering after expansion uses current geometry and live reduced motion cancels only owned animations", async () => {
  await prepareProjectMotion()
  await page.locator('[data-scope-id="project-one"] .sb-project-chevron-btn').click()
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"))
  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".sb-projects [data-scope-id]")]
    const container = rows[0]!.parentElement!
    const origin = container.getBoundingClientRect().top
    const state = window as unknown as { sidebarRows?: HTMLElement[]; sidebarForeign?: Animation }
    state.sidebarRows = rows
    state.sidebarForeign = rows[0]!.animate([{ opacity: 0.8 }, { opacity: 0.8 }], { duration: 10000 })
    return Object.fromEntries(rows.map((row) => [row.dataset.scopeId!, row.getBoundingClientRect().top - origin]))
  })
  await projectAction("reorder")
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".sb-projects [data-scope-id]")].some((row) =>
      row
        .getAnimations()
        .some((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => frame.transform)),
    ),
  )
  const movement = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".sb-projects [data-scope-id]")]
    const origin = rows[0]!.parentElement!.getBoundingClientRect().top
    const state = window as unknown as { sidebarRows: HTMLElement[] }
    return rows.map((row) => {
      const animation = row
        .getAnimations()
        .find((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => frame.transform))
      const translation = new DOMMatrix(getComputedStyle(row).transform).m42
      return {
        id: row.dataset.scopeId!,
        retained: state.sidebarRows.includes(row),
        target: row.getBoundingClientRect().top - origin - translation,
        from: new DOMMatrix(
          animation
            ? ((animation.effect as KeyframeEffect).getKeyframes()[0]?.transform as string | undefined)
            : undefined,
        ).m42,
      }
    })
  })
  expect(movement[0]?.id).toBe("project-one")
  for (const row of movement) {
    expect(row.retained).toBe(true)
    expect(Math.abs(row.from - (before[row.id]! - row.target))).toBeLessThanOrEqual(1)
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".sb-projects [data-scope-id]")].every((row) =>
      row
        .getAnimations()
        .every((animation) => (animation.effect as KeyframeEffect).getKeyframes().every((frame) => !frame.transform)),
    ),
  )
  expect(await page.evaluate(() => (window as unknown as { sidebarForeign: Animation }).sidebarForeign.playState)).toBe(
    "running",
  )
  await projectAction("reorder")
  expect(
    await page
      .locator(".sb-projects [data-scope-id]")
      .evaluateAll((rows) => rows.every((row) => getComputedStyle(row).transform === "none")),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("same-frame project reorders settle to the final order without replaying intermediate movement", async () => {
  await prepareProjectMotion()
  const recording = recordProjectMotion()
  await page.evaluate(() => {
    const fixture = (window as unknown as { sidebarFixture: { reorder: () => void } }).sidebarFixture
    fixture.reorder()
    fixture.reorder()
    fixture.reorder()
  })
  const frames = await recording
  expect(frames.every((frame) => frame.transforms.every((transform) => transform === "none"))).toBe(true)
  expect(
    await page
      .locator(".sb-projects [data-scope-id]")
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.scopeId)),
  ).toEqual(["project-two", "project-three", "project-one"])
})

test("an interrupted reorder resumes from visible positions and leaves user scrolling in control", async () => {
  await prepareProjectMotion()
  await projectAction("reorder")
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".sb-projects [data-scope-id]")].some((row) => row.getAnimations().length > 0),
  )
  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".sb-projects [data-scope-id]")]
    const origin = rows[0]!.parentElement!.getBoundingClientRect().top
    const positions = Object.fromEntries(
      rows.map((row) => [row.dataset.scopeId!, row.getBoundingClientRect().top - origin]),
    )
    ;(window as unknown as { sidebarFixture: { reorder: () => void } }).sidebarFixture.reorder()
    return positions
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  const starts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".sb-projects [data-scope-id]")]
    const origin = rows[0]!.parentElement!.getBoundingClientRect().top
    return rows.map((row) => {
      const animation = row.getAnimations()[0]
      const translation = new DOMMatrix(getComputedStyle(row).transform).m42
      const from = animation
        ? new DOMMatrix((animation.effect as KeyframeEffect).getKeyframes()[0]?.transform as string).m42
        : 0
      return { id: row.dataset.scopeId!, start: row.getBoundingClientRect().top - origin - translation + from }
    })
  })
  for (const row of starts) expect(Math.abs(row.start - before[row.id]!)).toBeLessThanOrEqual(1)
  const selectedScroll = await page.locator(".sb-scroll").evaluate((element) => {
    element.scrollTop -= 100
    return element.scrollTop
  })
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"))
  expect(await page.locator(".sb-scroll").evaluate((element) => element.scrollTop)).toBe(selectedScroll)
  expect(errors).toEqual([])
})

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

test("a core composition retains local navigation without optional channel surfaces", async () => {
  await open("?core=1")
  for (const label of ["最近", "首页", "后台", "项目"])
    expect(await page.getByRole("button", { name: label, exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "频道", exact: true }).count()).toBe(0)
  expect(await page.locator(".sb-global-btn").allTextContents()).toEqual(["插件"])
  await page.getByRole("button", { name: "首页", exact: true }).press("Enter")
  await page.getByText("Home session", { exact: true }).waitFor({ state: "visible" })
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
