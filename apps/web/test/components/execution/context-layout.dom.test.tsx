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
    import { ContextBrowser } from ${JSON.stringify(path.join(source, "context-browser.tsx"))}
    import { ContextHistoryChart } from ${JSON.stringify(path.join(source, "context-chart.tsx"))}
    import { createExecutionContext } from ${JSON.stringify(path.resolve(source, "../../context/execution-context.ts"))}
    import {useSDK,first,estimate,requests} from "./sdk"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(source, "context-dashboard.css"))}
    const categories=["systemInstructions","toolDefinitions","userMessages","injectedContext","skills","assistantMessages","toolResults","attachments"].map((category,index)=>({category,precision:"source",items:index,estimatedTokens:100,attributedTokens:100}))
    const snapshot={callID:"selected",requestNumber:1,roundNumber:1,modelID:"test-model",inputTokens:1000,contextLimit:10000,usage:{categories,overhead:{attributedTokens:200}}}
    const i18n=setupI18n({locale:"en",messages:{en:{"context.dashboard.historical":["Context for request ",["number"]]}}})
    const [ring,setRing]=createSignal({value:"≥ 826.1万",alternatives:["≥ 826万"],accessible:"≥ 8,261,000"})
    Object.assign(window,{setRing})
    function Live(){
      const [selected,setSelected]=createSignal("");const [category,setCategory]=createSignal("")
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
        <ContextHistoryChart items={history.state.items} selectedSnapshot={history.snapshot()} selected={selected()} onSelect={setSelected} grouping="request" onGrouping={()=>{}} delta={false} onDelta={()=>{}}/>
      </div>
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
    render(()=><I18nProvider i18n={i18n}><Router><Route path="/" component={Layout}/><Route path="/session/:id" component={Live}/></Router></I18nProvider>, document.getElementById("root"))
  `,
  )
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    resolve: { alias: { "@/context/sdk": path.join(directory, "sdk.ts") } },
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
