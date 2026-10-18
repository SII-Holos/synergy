import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

let browser: Browser
let page: Page
let server: PreviewServer
let directory: string
const source = path.resolve(import.meta.dir, "../../../src/components/execution")
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-context-layout-")))
  await symlink(path.resolve(source, "../../../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const keys=["systemInstructions","toolDefinitions","userMessages","injectedContext","skills","assistantMessages","toolResults","attachments"]
    export const estimate=(tokens)=>({version:1,modelID:"model",providerID:"provider",capturedAt:1,estimator:{kind:"bounded-utf8",sampledCharacters:20,truncated:false},categories:Object.fromEntries(keys.map(category=>[category,{estimatedTokens:category==="userMessages"?tokens:0,items:category==="userMessages"?1:0}]))})
    export const first={sessionID:"session",callID:"first",nodeID:"first",runID:"round",started:1,requestNumber:1,roundNumber:1,status:"running",modelID:"model",providerID:"provider",inputTokens:null,contextLimit:1000,outputTokens:null,cacheHit:null,elapsedMs:null,retries:0,usage:null,estimate:estimate(20),compactedBefore:false,requestAvailable:true}
    export const requests=[]
    const client=createSynergyClient({baseUrl:"http://fixture.test",fetch:async(request)=>{
      const url=new URL(request.url); requests.push(url.pathname+url.search)
      if(url.pathname.endsWith("/history"))return Response.json({sessionID:"session",revision:1,items:[first],total:1,nextCursor:null})
      if(url.pathname.endsWith("/items"))return Response.json({callID:url.pathname.split("/").at(-2),nodeID:"first",status:"available",contentVersion:"v1",total:1,truncated:false,nextCursor:null,items:[{id:"source",category:"userMessages",path:["messages","0"],source:"stable source",precision:"source",characters:4,offset:0,bytes:6}]})
      return Response.json({text:'"body"',nextOffset:null})
    }})
    export const useSDK=()=>({client})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal } from "solid-js"
    import { Router, Route } from "@solidjs/router"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { ContextDashboardLayout } from ${JSON.stringify(path.join(source, "context-dashboard-layout.tsx"))}
    import { ContextComposition } from ${JSON.stringify(path.join(source, "context-composition.tsx"))}
    import { ContextRing } from ${JSON.stringify(path.join(source, "context-ring.tsx"))}
    import { ContextUsageStats } from ${JSON.stringify(path.join(source, "context-usage-stats.tsx"))}
    import { ContextTiming } from ${JSON.stringify(path.join(source, "context-timing.tsx"))}
    import { ContextBrowser } from ${JSON.stringify(path.join(source, "context-browser.tsx"))}
    import { ContextHistoryChart } from ${JSON.stringify(path.join(source, "context-chart.tsx"))}
    import { createExecutionContext } from ${JSON.stringify(path.resolve(source, "../../context/execution-context.ts"))}
    import {useSDK,first,estimate,requests} from "./sdk"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(source, "context-dashboard.css"))}
    const categories=["systemInstructions","toolDefinitions","userMessages","injectedContext","skills","assistantMessages","toolResults","attachments"].map((category,index)=>({category,precision:"source",items:index,estimatedTokens:100,attributedTokens:100}))
    const snapshot={callID:"selected",requestNumber:1,roundNumber:1,modelID:"test-model",inputTokens:1000,contextLimit:10000,usage:{categories,overhead:{attributedTokens:200}}}
    const i18n=setupI18n({locale:"en",messages:{en:{"context.dashboard.request":["Request ",["number"]],"context.dashboard.round":["Round ",["number"]," · last request"],"context.dashboard.historical":["Context for request ",["number"]],"execution.usage.tokenRate":[["value"]," tok/s"]}}})
    const [ring,setRing]=createSignal({value:"≥ 826.1万",alternatives:["≥ 826万"],accessible:"≥ 8,261,000"})
    Object.assign(window,{setRing})
    function Metrics(){
      const measured=known=>({known,unknown:0,total:known})
      const [tokens,setTokens]=createSignal({input:measured(1000),uncached:measured(200),cacheRead:measured(800),cacheWrite:{known:0,unknown:1,total:null},output:measured(200),reasoning:measured(50),total:measured(1200)})
      const [duration,setDuration]=createSignal(118000)
      const [rates,setRates]=createSignal({generation:{value:95.9321},endToEnd:{value:41.2718}})
      const summary=()=>({accounting:{calls:2,attempts:2,tokens:tokens()},own:{tokens:tokens()},descendants:{tokens:tokens()},cost:{state:"recorded",reported:[],estimates:[],missing:0,equivalent:null},cache:{ratio:0.8},elapsedMs:duration(),elapsedActive:false,latency:{ttft:{totalMs:duration()/4,samples:1,meanMs:duration()/4},generation:{totalMs:duration()/4,samples:1},request:{meanMs:duration()/2}},tools:[{calls:1,durationMs:duration()/2,timedSamples:1}],rates:rates(),outcomes:{retries:0}})
      Object.assign(window,{setTokens,setDuration,setRates})
      return <div class="context-dashboard"><ContextUsageStats summary={summary()} now={0}/><ContextTiming summary={summary()}/></div>
    }
    function Live(){
      const [selected,setSelected]=createSignal("");const [category,setCategory]=createSignal("");const [windowStart,setWindowStart]=createSignal("")
      let receive;let revision=1
      const history=createExecutionContext({client:useSDK().client,sessionID:()=>"session",runID:()=>"",active:()=>true,selected,connectionVersion:()=>1,subscribe:callback=>{receive=callback;return ()=>{}}})
      Object.assign(window,{live:{requests,send:(callID,number,tokens,actual)=>{
        const next={...first,callID,nodeID:callID,started:number,requestNumber:number,estimate:tokens==null?undefined:estimate(tokens),inputTokens:actual??null}
        if(actual!=null)next.usage={version:2,modelID:"model",providerID:"provider",totalInput:actual,categories:Object.entries(next.estimate.categories).map(([category,value])=>({...value,category,precision:"source",attributedTokens:category==="userMessages"?actual:0})),overhead:{attributedTokens:0},estimator:next.estimate.estimator,reconciliation:{mode:"residual",factor:1},capturedAt:2}
        receive({sessionID:"session",revision:++revision,contextUpserts:[next]})
      }}})
      return <div id="live" class="context-dashboard" style="height:600px;overflow:auto">
        <ContextComposition snapshot={history.state.displayedLatest} category={category()} onCategory={setCategory}/>
        <ContextBrowser selected={selected()} onSelect={setSelected} snapshot={history.snapshot()} history={history.state.items} category={category()} onCategory={setCategory} active={true}/>
        <ContextHistoryChart items={history.state.items} selectedSnapshot={history.snapshot()} windowStart={windowStart()} onWindowStart={setWindowStart} selected={selected()} onSelect={setSelected} grouping="request" onGrouping={()=>{}} delta={false} onDelta={()=>{}}/>
      </div>
    }
    function Chart(){
      const [items,setItems]=createSignal([])
      const [selected,setSelected]=createSignal("")
      const [grouping,setGrouping]=createSignal("request")
      const [delta,setDelta]=createSignal(false)
      const [windowStart,setWindowStart]=createSignal("")
      Object.assign(window,{chart:{
        samples:(values,start=0)=>setItems(values.map((value,position)=>{const index=position+start;return {...first,callID:String(index),nodeID:String(index),started:index,requestNumber:index+1,roundNumber:Math.floor(index/2)+1,runID:"round-"+Math.floor(index/2),inputTokens:value.tokens,estimate:value.tokens==null?undefined:estimate(value.tokens),elapsedMs:value.elapsedMs}})),
        select:setSelected,latest:()=>{setSelected("");setWindowStart("")},
        locale:locale=>{i18n.load(locale,{});i18n.activate(locale)},
      }})
      return <div class="context-dashboard"><ContextHistoryChart items={items()} windowStart={windowStart()} onWindowStart={setWindowStart} selected={selected()} onSelect={setSelected} grouping={grouping()} onGrouping={setGrouping} delta={delta()} onDelta={setDelta}/></div>
    }
    const Layout=()=><div class="context-dashboard-shell" style="height:100dvh"><div class="context-dashboard"><ContextDashboardLayout
      composition={<ContextComposition snapshot={snapshot} category="" onCategory={()=>{}}/>}
      metrics={<section class="context-usage-stats"><div class="context-usage-body"><ContextRing segments={[]} total={null} label="Cumulative usage" value={ring().value} caption="累计用量" fitValue={{alternatives:ring().alternatives,accessible:ring().accessible}}/><div/></div><div class="context-metrics">{["Cost","Time","Cache"].map(name=><button class="context-metric"><span>{name}</span><strong>1,234</strong></button>)}</div></section>}
      history={<section class="context-history"><h2>History</h2><div class="context-history-plot"/></section>}
      timing={<section class="context-timing"><h2>Timing</h2><div style="height:120px"/></section>}
      contents={<section class="context-browser"><h2>Contents</h2><label class="context-source-search"><input aria-label="Search sources"/></label><button id="reader">Read source</button><div style="height:210px"/></section>}
      events={<section class="context-events"><h2>Events</h2></section>}
      activity={<section class="context-activity"><h2>Task activity</h2></section>}
    /></div></div>
    render(()=><I18nProvider i18n={i18n}><Router><Route path="/" component={Layout}/><Route path="/metrics" component={Metrics}/><Route path="/chart" component={Chart}/><Route path="/session/:id" component={Live}/></Router></I18nProvider>, document.getElementById("root"))
  `,
  )
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    resolve: { alias: { "@/context/sdk": path.join(directory, "sdk.ts"), "@": path.resolve(source, "../..") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: path.join(directory, "dist"),
      minify: false,
      target: "esnext",
      lib: { entry: path.join(directory, "main.tsx"), formats: ["es"], fileName: "main", cssFileName: "styles" },
    },
  }
  const builder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solid from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; await build({...${JSON.stringify(options)},plugins:[solid()]});process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Context layout build failed")
  await Bun.write(
    path.join(directory, "dist/index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: directory,
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 60_000)
afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("live classification retains chart nodes, disclosures, source bodies and focus through estimate calibration", async () => {
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto(new URL("session/session", server.resolvedUrls!.local[0]!).href)
  const category = page.locator('[data-context-category="userMessages"]')
  await category.click()
  await page.locator(".context-item-heading").click()
  await page.locator(".execution-evidence-text").waitFor()
  const search = page.getByRole("searchbox")
  await search.fill("stable")
  await page.waitForTimeout(200)
  await page.locator(".context-item-heading").click()
  await page.locator(".execution-evidence-text").waitFor()
  await search.focus()
  await page.evaluate(() => {
    Object.assign(window, {
      retained: {
        category: document.querySelector('[data-context-category="userMessages"]'),
        item: document.querySelector(".context-item-heading"),
        bar: document.querySelector(".context-history-bar"),
        segment: document.querySelector(".context-capacity-track > span"),
        body: document.querySelector(".execution-evidence-text"),
        requests: (window as unknown as { live: { requests: string[] } }).live.requests.length,
      },
    })
  })
  const send = async (callID: string, number: number, tokens: number | null, actual?: number) =>
    page.evaluate(
      ({ callID, number, tokens, actual }) => {
        const host = window as unknown as {
          live: { send: (callID: string, number: number, tokens: number | null, actual?: number) => void }
        }
        host.live.send(callID, number, tokens, actual)
      },
      { callID, number, tokens, actual },
    )
  await send("second", 2, null)
  expect(await page.locator(".context-source-caption strong").textContent()).toContain("1")
  await send("first", 1, 20, 25)
  expect(await page.locator(".context-current-total strong").textContent()).toBe("25")
  const preserved = await page.evaluate(() => {
    const host = window as unknown as {
      retained: { category: Element; item: Element; bar: Element; segment: Element; body: Element; requests: number }
      live: { requests: string[] }
    }
    return {
      category: host.retained.category === document.querySelector('[data-context-category="userMessages"]'),
      item: host.retained.item === document.querySelector(".context-item-heading"),
      bar: host.retained.bar === document.querySelector(".context-history-bar"),
      segment: host.retained.segment === document.querySelector(".context-capacity-track > span"),
      body: host.retained.body === document.querySelector(".execution-evidence-text"),
      requests: host.live.requests.length === host.retained.requests,
      requestTrace: host.live.requests,
      expanded: host.retained.category.getAttribute("aria-expanded"),
      focus: document.activeElement?.getAttribute("type"),
    }
  })
  expect(preserved).toMatchObject({
    category: true,
    item: true,
    bar: true,
    segment: true,
    body: true,
    requests: true,
    expanded: "true",
    focus: "search",
  })
  await send("second", 2, 35)
  expect(await page.locator(".context-source-caption strong").textContent()).toContain("2")
  expect(await category.getAttribute("aria-expanded")).toBe("true")
  expect(await search.inputValue()).toBe("stable")
  await page.locator(".context-history-bar").first().click()
  await send("third", 3, 40)
  expect(await page.locator(".context-source-caption strong").textContent()).toContain("1")
})

test("known token components remain visible with incomplete usage and never double-count reasoning", async () => {
  await page.goto(new URL("metrics", server.resolvedUrls!.local[0]!).href)
  const arcs = page.locator(".context-usage-stats circle:not(.context-ring-track)")
  const values = () =>
    arcs.evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("stroke-dasharray")!.split(" ")[0])))
  expect((await values()).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100)
  expect(await arcs.count()).toBe(4)
  const update = (values: Record<string, { known: number; unknown: number; total: number | null }>) =>
    page.evaluate((values) => (window as unknown as { setTokens: (value: unknown) => void }).setTokens(values), values)
  const unknown = { known: 0, unknown: 1, total: null }
  const exact = (known: number) => ({ known, unknown: 0, total: known })
  await update({
    input: exact(1000),
    uncached: exact(200),
    cacheRead: unknown,
    cacheWrite: unknown,
    output: exact(200),
    reasoning: exact(50),
    total: exact(1200),
  })
  expect((await values()).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100 / 3)
  expect(await page.locator(".context-usage-stats").textContent()).toContain("unclassified")
  await update({
    input: { ...unknown, known: 1000 },
    uncached: { ...unknown, known: 200 },
    cacheRead: { ...unknown, known: 800 },
    cacheWrite: unknown,
    output: { ...unknown, known: 200 },
    reasoning: { ...unknown, known: 50 },
    total: { ...unknown, known: 500 },
  })
  expect((await values()).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100)
  expect(await arcs.count()).toBe(3)
  expect(await page.locator(".context-usage-stats .context-ring").getAttribute("aria-label")).toContain("≥ 500")
  await update(
    Object.fromEntries(
      ["input", "uncached", "cacheRead", "cacheWrite", "output", "reasoning", "total"].map((key) => [key, unknown]),
    ),
  )
  expect(await arcs.count()).toBe(0)
  expect(await page.locator(".context-usage-stats .context-ring").getAttribute("aria-label")).toContain("—")
  await update(
    Object.fromEntries(
      ["input", "uncached", "cacheRead", "cacheWrite", "output", "reasoning", "total"].map((key) => [key, exact(0)]),
    ),
  )
  expect(await arcs.count()).toBe(0)
  expect(await page.locator(".context-usage-stats .context-ring").getAttribute("aria-label")).toContain(": 0")
})

test("timing and usage details share one output speed without falling back to generation speed", async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(new URL("metrics", server.resolvedUrls!.local[0]!).href)
  await page.getByRole("button", { name: "Token usage details", exact: true }).click()
  const detail = page.locator(".execution-usage-popover")
  const speed = detail
    .locator("dl > div")
    .filter({ has: page.getByText("Output speed", { exact: true }) })
    .locator("dd")
  expect(await page.locator(".context-timing-rate").textContent()).toContain("Output speed")
  for (const value of [41.2718, null, 0]) {
    await page.evaluate(
      (value) => Reflect.get(window, "setRates")({ generation: { value: 95.9321 }, endToEnd: { value } }),
      value,
    )
    const expected = value == null ? "—" : value === 0 ? "0 tok/s" : "41.3 tok/s"
    expect(await page.locator(".context-timing-rate strong").textContent()).toBe(expected)
    expect(await speed.textContent()).toBe(expected)
    expect(await detail.locator("dd").filter({ hasText: "tok/s" }).count()).toBe(value == null ? 0 : 1)
  }
  await page.setViewportSize({ width: 375, height: 667 })
  await page.waitForFunction(() => {
    const box = document.querySelector(".execution-usage-popover")!.getBoundingClientRect()
    return box.x >= 0 && box.right <= innerWidth
  })
  expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.keyboard.press("Escape")
  await detail.waitFor({ state: "hidden" })
})

test("recorded durations use the token ring type scale and fit long values without overflow", async () => {
  await page.goto(new URL("metrics", server.resolvedUrls!.local[0]!).href)
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const duration of [118000, 3600000000]) {
      await page.evaluate(
        (duration) => (window as unknown as { setDuration(value: number): void }).setDuration(duration),
        duration,
      )
      await page.waitForTimeout(50)
      const result = await page.locator(".context-timing .context-ring").evaluate((ring) => {
        const text = ring.querySelector("div > strong")!
        const bounds = ring.getBoundingClientRect(),
          rect = text.getBoundingClientRect()
        const radius = (bounds.width * 62) / 160,
          cx = bounds.x + bounds.width / 2,
          cy = bounds.y + bounds.height / 2
        return {
          size: parseFloat(getComputedStyle(text).fontSize),
          inside: [rect.left, rect.right].every((x) =>
            [rect.top, rect.bottom].every((y) => Math.hypot(x - cx, y - cy) <= radius + 1),
          ),
        }
      })
      expect(result.inside).toBe(true)
      expect(result.size).toBeLessThanOrEqual(18)
      expect(result.size).toBeGreaterThanOrEqual(12)
      const captions = await page.locator(".context-ring").evaluateAll((rings) =>
        rings.map((ring) => {
          const bounds = ring.getBoundingClientRect(),
            caption = ring.querySelector("div > span")!.getBoundingClientRect()
          const radius = (bounds.width * 62) / 160,
            cx = bounds.x + bounds.width / 2,
            cy = bounds.y + bounds.height / 2
          return {
            text: ring.querySelector("div > span")!.textContent,
            diameter: bounds.width,
            width: caption.width,
            height: caption.height,
            inside: [caption.left, caption.right].every((x) =>
              [caption.top, caption.bottom].every((y) => Math.hypot(x - cx, y - cy) <= radius + 1),
            ),
          }
        }),
      )
      for (const caption of captions) expect(caption, JSON.stringify(caption)).toMatchObject({ inside: true })
    }
  }
})

test("cumulative token values fit real 108px and 80px rings across fonts, themes and zoom", async () => {
  await page.goto(server.resolvedUrls!.local[0]!)
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ["light", "dark"])
      for (const zoom of [1, 2])
        for (const font of ["sans-serif", "serif"]) {
          await page.emulateMedia({ colorScheme: theme as "light" | "dark" })
          await page.evaluate(
            ({ theme, zoom, font }) => {
              document.documentElement.removeAttribute("data-color-scheme")
              document.documentElement.style.colorScheme = theme
              document.body.style.zoom = String(zoom)
              document.querySelector<HTMLElement>(".context-ring")!.style.fontFamily = font
            },
            { theme, zoom, font },
          )
          for (const value of ["≥ 826.1万", "≥ 8261.5万亿", "≥ 8.3M", "≥ 8261.5T"]) {
            await page.evaluate((value) => {
              const host = window as unknown as {
                setRing: (value: { value: string; alternatives: string[]; accessible: string }) => void
              }
              host.setRing({ value, alternatives: [value.replace(/\.\d+/, "")], accessible: "≥ 8,261,000" })
            }, value)
            await page.waitForTimeout(40)
            const dimensions = await page.locator(".context-ring").evaluate((ring) => {
              const text = ring.querySelector("div > strong")!
              const bounds = ring.getBoundingClientRect()
              const rect = text.getBoundingClientRect()
              const radius = (bounds.width * 62) / 160
              const cx = bounds.x + bounds.width / 2
              const cy = bounds.y + bounds.height / 2
              return {
                font: parseFloat(getComputedStyle(text).fontSize),
                geometry: {
                  width: bounds.width,
                  height: bounds.height,
                  textWidth: rect.width,
                  textHeight: rect.height,
                  offset: rect.top - cy,
                  font: getComputedStyle(text).fontFamily,
                },
                inside: [rect.left, rect.right].every((x) =>
                  [rect.top, rect.bottom].every((y) => Math.hypot(x - cx, y - cy) <= radius + 1),
                ),
                centered: Math.abs((rect.left + rect.right) / 2 - cx) < 1,
                value: text.textContent,
                label: ring.getAttribute("aria-label"),
              }
            })
            expect(dimensions).toMatchObject({ inside: true, centered: true, label: "Cumulative usage: ≥ 8,261,000" })
            expect(dimensions.font).toBeGreaterThanOrEqual(12)
            expect(dimensions.font).toBeLessThanOrEqual(18)
            expect([value, value.replace(/\.\d+/, "")]).toContain(dimensions.value)
          }
        }
  }
  await page.evaluate(() => {
    document.body.style.zoom = "1"
  })
  await page.emulateMedia({ colorScheme: "light" })
  const artifacts = path.resolve(import.meta.dir, "../../../../../.artifacts/context-usage")
  await mkdir(artifacts, { recursive: true })
  for (const [width, size] of [
    [375, 80],
    [1280, 108],
  ]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(server.resolvedUrls!.local[0]!)
    await page.locator(".context-ring").waitFor()
    await page.waitForTimeout(50)
    await page.locator(".context-ring").screenshot({ path: path.join(artifacts, `token-ring-${size}.png`) })
  }
}, 60_000)
for (const width of [320, 375, 560, 800, 1280, 1989]) {
  test(`context reading layout fits ${width}px without stretching its columns`, async () => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(server.resolvedUrls!.local[0]!)
    await page.locator(".context-composition").waitFor()
    const result = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector)!
        const rect = el.getBoundingClientRect()
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width }
      }
      const scroller = document.querySelector(".context-dashboard")!
      const style = getComputedStyle(scroller)
      return {
        availableWidth: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        composition: box(".context-composition"),
        content: box(".context-browser"),
        timing: box(".context-timing"),
        history: box(".context-history"),
        metric: box(".context-metrics"),
        overflow: scroller.scrollWidth > scroller.clientWidth,
        clippedLabels: [...document.querySelectorAll(".context-legend-row > span:nth-child(2)")].filter(
          (label) => label.scrollWidth > label.clientWidth,
        ).length,
      }
    })
    expect(result.overflow).toBe(false)
    expect(result.clippedLabels).toBe(0)
    if (result.availableWidth >= 760) {
      expect(result.content.x).toBeGreaterThan(result.composition.right)
      expect(result.content.y).toBeLessThan(340)
      expect(result.history.width).toBeLessThanOrEqual(790)
      expect(result.metric.bottom - result.metric.y).toBeLessThan(160)
    } else {
      expect(result.content.y).toBeGreaterThan(result.history.bottom)
      expect(result.timing.y).toBeGreaterThan(result.history.bottom)
      if (width === 560) expect(result.history.y).toBeLessThan(640)
    }
  })
}
test("context columns follow the content breakpoint after padding and scrollbar space", async () => {
  await page.setViewportSize({ width: 960, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]!)
  const inset = await page.locator(".context-dashboard").evaluate((element) => {
    const style = getComputedStyle(element)
    return innerWidth - element.clientWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  })
  for (const available of [759, 760, 759, 760]) {
    await page.setViewportSize({ width: available + inset, height: 800 })
    const geometry = await page.evaluate(() => {
      const composition = document.querySelector(".context-composition")!.getBoundingClientRect()
      const content = document.querySelector(".context-browser")!.getBoundingClientRect()
      const scroller = document.querySelector(".context-dashboard")!
      const style = getComputedStyle(scroller)
      return {
        available: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        sideBySide: content.x > composition.right,
        overflow: scroller.scrollWidth > scroller.clientWidth,
      }
    })
    expect(geometry.available).toBe(available)
    expect(geometry.sideBySide).toBe(available >= 760)
    expect(geometry.overflow).toBe(false)
  }
})
test("changing layout retains the reader node, typed search and keyboard focus", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]!)
  const search = page
    .getByRole("searchbox", { name: "Search sources" })
    .or(page.getByRole("textbox", { name: "Search sources" }))
  await search.fill("requirements")
  await page.evaluate(() => {
    document.querySelector("input")!.dataset.retained = "yes"
  })
  for (const width of [375, 1989, 560, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await search.inputValue()).toBe("requirements")
    expect(await search.getAttribute("data-retained")).toBe("yes")
    expect(await search.evaluate((element) => document.activeElement === element)).toBe(true)
  }
})

async function chartSamples(samples: Array<{ tokens: number | null; elapsedMs: number | null }>, start = 0) {
  await page.evaluate(({ values, start }) => Reflect.get(window, "chart").samples(values, start), {
    values: samples,
    start,
  })
  await settleChart()
}

async function settleChart() {
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity,
        ),
  )
}

async function chartGeometry() {
  return page.evaluate(() => {
    const plot = document.querySelector(".context-chart-bars")!
    const viewport = document.querySelector(".context-chart-scroll") ?? plot
    const bounds = viewport.getBoundingClientRect()
    const visible = (x: number) => x >= bounds.left && x <= bounds.right
    const svg = document.querySelector<SVGSVGElement>(".context-timing-overlay")
    const svgBounds = svg?.getBoundingClientRect()
    return {
      width: viewport.clientWidth,
      scrollWidth: viewport.scrollWidth,
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, height: bounds.height },
      bars: [...plot.querySelectorAll(".context-history-bar")]
        .map((bar) => {
          const rect = bar.getBoundingClientRect()
          const positive = [...bar.querySelectorAll(".context-bar-positive > span")].map(
            (segment) => segment.getBoundingClientRect().height,
          )
          const negative = [...bar.querySelectorAll(".context-bar-negative > span")].map(
            (segment) => segment.getBoundingClientRect().height,
          )
          return {
            x: rect.x + rect.width / 2,
            positive: positive.reduce((a, b) => a + b, 0),
            negative: negative.reduce((a, b) => a + b, 0),
          }
        })
        .filter((bar) => visible(bar.x)),
      points: [...plot.querySelectorAll(".context-timing-point")]
        .map((point) => {
          const [x, y] = point.getAttribute("d")!.slice(1).split(" ")[0].split(",").map(Number)
          return {
            x: svgBounds!.left + (x / 100) * svgBounds!.width,
            y: svgBounds!.top + (y / 100) * svgBounds!.height,
          }
        })
        .filter((point) => visible(point.x)),
      tokenTicks: [...document.querySelectorAll(".context-chart-scale:not(.context-time-scale) > span")].map(
        (el) => el.textContent,
      ),
      timeTicks: [...document.querySelectorAll(".context-time-scale > span")].map((el) => el.textContent),
    }
  })
}

test("long histories show the latest 24 aligned requests with scales limited to the visible window", async () => {
  await page.setViewportSize({ width: 560, height: 800 })
  await page.goto(new URL("chart", server.resolvedUrls!.local[0]!).href)
  await chartSamples(
    Array.from({ length: 231 }, (_, i) => ({ tokens: (i + 1) * 1000, elapsedMs: i === 0 ? 154000 : 18000 })),
  )
  const geometry = await chartGeometry()
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.width * 9)
  expect(await page.getByRole("slider").count()).toBe(0)
  expect(geometry.bars).toHaveLength(24)
  for (let i = 0; i < geometry.bars.length; i++) {
    expect(geometry.bars[i].x).toBeGreaterThanOrEqual(geometry.bounds.left)
    expect(geometry.bars[i].x).toBeLessThanOrEqual(geometry.bounds.right)
    expect(Math.abs(geometry.bars[i].x - geometry.points[i].x)).toBeLessThan(1)
  }
  expect(geometry.bars.at(-1)!.positive / geometry.bounds.height).toBeGreaterThan(0.9)
  expect(geometry.timeTicks[0]).toBe("00:20")
  expect(await page.locator(".context-chart-caption").textContent()).toBe("Request 208Request 231")
})

test("five aligned ticks and independent vertical scales survive updates, timing visibility and narrow locales", async () => {
  await page.setViewportSize({ width: 560, height: 800 })
  await page.goto(new URL("chart", server.resolvedUrls!.local[0]!).href)
  const samples = [
    { tokens: 425000, elapsedMs: 154000 },
    { tokens: 210000, elapsedMs: 40000 },
    { tokens: 148000, elapsedMs: 18000 },
  ]
  await chartSamples(samples)
  const original = await chartGeometry()
  expect(original.tokenTicks).toHaveLength(5)
  expect(original.timeTicks).toHaveLength(5)
  await chartSamples(samples.map((item) => ({ ...item, elapsedMs: item.elapsedMs * 60 })))
  const longer = await chartGeometry()
  expect(longer.tokenTicks).toEqual(original.tokenTicks)
  expect(longer.bars.map((bar) => bar.positive)).toEqual(original.bars.map((bar) => bar.positive))
  await chartSamples(samples.map((item) => ({ ...item, tokens: item.tokens * 100 })))
  const larger = await chartGeometry()
  expect(larger.timeTicks).toEqual(original.timeTicks)
  expect(larger.points.map((point) => point.y)).toEqual(original.points.map((point) => point.y))
  await page.locator(".context-timing-toggle").click()
  expect((await chartGeometry()).bars.map((bar) => bar.positive)).toEqual(larger.bars.map((bar) => bar.positive))
  await page.locator(".context-timing-toggle").click()
  for (const settings of [
    { width: 320, zoom: 1, direction: "ltr" },
    { width: 375, zoom: 1, direction: "ltr" },
    { width: 560, zoom: 1, direction: "ltr" },
    { width: 640, zoom: 2, direction: "ltr" },
    { width: 375, zoom: 1, direction: "rtl" },
  ]) {
    await page.setViewportSize({ width: settings.width, height: 800 })
    await page.evaluate(({ zoom, direction }) => {
      Reflect.get(window, "chart").locale("zh-CN")
      document.body.style.zoom = String(zoom)
      document.body.dir = direction
    }, settings)
    const labels = await page.locator(".context-chart-scale > span").evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        return {
          lines: range.getClientRects().length,
          inside: rect.left >= 0 && rect.right <= innerWidth,
          y: rect.top + rect.height / 2,
        }
      }),
    )
    expect(labels.every((label) => label.lines === 1 && label.inside)).toBe(true)
    const geometry = await chartGeometry()
    for (let i = 0; i < geometry.bars.length; i++) {
      expect(Math.abs(geometry.bars[i].x - geometry.points[i].x)).toBeLessThan(1)
    }
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(labels[i].y - labels[i + 5].y)).toBeLessThan(1)
      expect(Math.abs(labels[i].y - (geometry.bounds.top + (geometry.bounds.height * i) / 4))).toBeLessThan(1.5)
    }
  }
})

test("signed token changes retain their own zero while elapsed timing remains nonnegative", async () => {
  await page.setViewportSize({ width: 560, height: 800 })
  await page.goto(new URL("chart", server.resolvedUrls!.local[0]!).href)
  await chartSamples([
    { tokens: 100, elapsedMs: null },
    { tokens: 300, elapsedMs: 0 },
    { tokens: 100, elapsedMs: 4000 },
    { tokens: 200, elapsedMs: 2000 },
  ])
  const full = await chartGeometry()
  await page.getByRole("button", { name: "Change", exact: true }).click()
  await settleChart()
  const delta = await chartGeometry()
  expect(delta.tokenTicks).toHaveLength(5)
  expect(delta.tokenTicks[2]).toBe("0")
  expect(delta.timeTicks).toEqual(full.timeTicks)
  expect(delta.points).toEqual(full.points)
  expect(Math.abs(delta.bars[1].positive - delta.bounds.height / 2)).toBeLessThan(1)
  expect(Math.abs(delta.bars[2].negative - delta.bounds.height / 2)).toBeLessThan(1)
  await page.getByRole("button", { name: "Rounds", exact: true }).click()
  const rounds = await chartGeometry()
  expect(rounds.bars).toHaveLength(2)
  expect(rounds.points).toHaveLength(2)
  expect(rounds.timeTicks).toHaveLength(5)
})

test("history navigation follows the latest requests and anchors manual browsing during incoming updates", async () => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(new URL("chart", server.resolvedUrls!.local[0]!).href)
  const samples = Array.from({ length: 60 }, (_, i) => ({ tokens: 100 + i, elapsedMs: 1000 + i * 100 }))
  await chartSamples(samples)
  const caption = page.locator(".context-chart-caption")
  expect(await caption.textContent()).toBe("Request 37Request 60")
  await page.locator(".context-chart-scroll").hover()
  await page.mouse.wheel(-10000, 0)
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 1Request 24",
  )
  expect(await caption.textContent()).toBe("Request 1Request 24")
  await page
    .locator(".context-history-bar")
    .first()
    .evaluate((el) => (el.dataset.retained = "yes"))
  await chartSamples([...samples, { tokens: 10000, elapsedMs: 120000 }])
  expect(await caption.textContent()).toBe("Request 1Request 24")
  expect(await page.locator(".context-history-bar").first().getAttribute("data-retained")).toBe("yes")
  expect((await chartGeometry()).timeTicks[0]).toBe("00:04")
  await page.locator(".context-chart-scroll").evaluate((el) => el.scrollTo({ left: el.clientWidth }))
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 25Request 48",
  )
  expect(await caption.textContent()).toBe("Request 25Request 48")
  await page.locator(".context-chart-scroll").evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 38Request 61",
  )
  expect(await caption.textContent()).toBe("Request 38Request 61")
  await chartSamples([...samples, { tokens: 10000, elapsedMs: 120000 }, { tokens: 20000, elapsedMs: 8000 }])
  expect(await caption.textContent()).toBe("Request 39Request 62")
  await page.evaluate(() => Reflect.get(window, "chart").select("9"))
  expect(await page.locator(".context-history-bar[aria-pressed=true]").getAttribute("aria-label")).toContain(
    "Request 10",
  )
  expect(await caption.textContent()).toBe("Request 10Request 33")
  await page.getByRole("button", { name: "Change", exact: true }).click()
  await settleChart()
  expect(await page.getByRole("button", { name: /^Request 10 ·/ }).getAttribute("data-gap")).toBe("false")
  expect((await chartGeometry()).bars[0].positive).toBeGreaterThan(0)
  await page.locator(".context-chart-scroll").evaluate((el) => el.scrollTo({ left: 0 }))
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 1Request 24",
  )
  await page.getByRole("button", { name: /^Request 24 ·/ }).focus()
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Request 25 ·"))
  expect(await caption.textContent()).toBe("Request 2Request 25")
  await page.getByRole("button", { name: /^Request 2 ·/ }).focus()
  await page.keyboard.press("ArrowLeft")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Request 1 ·"))
  expect(await caption.textContent()).toBe("Request 1Request 24")
})

test("prepending earlier requests keeps the manually viewed window and its focused bar", async () => {
  await page.setViewportSize({ width: 560, height: 800 })
  await page.goto(new URL("chart", server.resolvedUrls!.local[0]!).href)
  await page.locator(".context-chart-scroll").evaluate((el) => (el.style.width = "399px"))
  await settleChart()
  const samples = Array.from({ length: 30 }, (_, i) => ({ tokens: 100 + i, elapsedMs: 4000 }))
  await chartSamples(samples, 100)
  await page.locator(".context-chart-scroll").evaluate((el) => el.scrollTo({ left: 0 }))
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 101Request 124",
  )
  await page.locator(".context-history-bar").first().focus()
  await chartSamples([...samples, ...samples], 70)
  expect(await page.locator(".context-chart-caption").textContent()).toBe("Request 101Request 124")
  expect(
    await page.getByRole("button", { name: /^Request 101 ·/ }).evaluate((el) => document.activeElement === el),
  ).toBe(true)
  await page.locator(".context-chart-scroll").evaluate((el) => el.scrollBy({ left: -el.clientWidth }))
  await page.waitForFunction(
    () => document.querySelector(".context-chart-caption")?.textContent === "Request 77Request 100",
  )
})
