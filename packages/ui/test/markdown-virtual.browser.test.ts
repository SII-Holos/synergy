import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let directory: string
let server: ViteDevServer
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".markdown-virtual-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { batch, createSignal } from "solid-js"
    import { VList as JsxVList, Virtualizer as JsxVirtualizer, WindowVirtualizer as JsxWindowVirtualizer } from ${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/virtua/lib/solid/index.jsx"))}
    import { VList as MjsVList, Virtualizer as MjsVirtualizer, WindowVirtualizer as MjsWindowVirtualizer } from ${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/virtua/lib/solid/index.mjs"))}
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { Markdown } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown.tsx"))}
    import { MarkedProvider } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/context/marked.tsx"))}
    import { ResourceOpenProvider } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/context/resource-open.tsx"))}
    import { attachmentFromReference } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/attachment-card-utils.ts"))}
    import { configureClipboard } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/clipboard-core.ts"))}
    import { MarkdownDocumentView } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown-document-view.tsx"))}
    import { createMarkdownParser } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/context/markdown-parser.ts"))}
    import { parseMarkdownDocument } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/context/markdown-document.ts"))}
    import { createMarkdownStreamController } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown-stream.ts"))}
    import ${JSON.stringify(path.resolve(import.meta.dir, "../src/components/markdown.css"))}
    const code = "const original = '保持原文';\\n".repeat(2000)
    const [text,setText] = createSignal("$E=mc^2$\\n\\n" + Array.from({length:5000},(_,index)=>"paragraph " + index + " **bold**\\n\\n").join("") + "\\n\`\`\`ts\\n" + code + "\`\`\`")
    const [streaming,setStreaming] = createSignal(false)
    const [identity,setIdentity] = createSignal(0)
    const copies: string[] = []
    const opened: string[] = []
    const resources = {
      resolveUrl(reference) { return reference.kind === "asset" ? location.origin + "/asset/" + reference.url.slice(8) : reference.kind === "workspace-file" && reference.path === "/image.svg" ? location.origin + reference.path : undefined },
      open: async resource => { if (resource.kind === "asset") opened.push(resource.url); return {status: "opened"} },
    }
    configureClipboard({writer: value=>{ copies.push(value);return true }})
    const i18n = setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><MarkedProvider><ResourceOpenProvider value={resources}><div id="scroller" data-scroll-viewport="vertical" style="height:480px;overflow:auto;width:720px"><div id="horizontal-host"><Markdown text={text()} streaming={streaming()} cacheKey={"fixture:"+identity()} /></div></div></ResourceOpenProvider></MarkedProvider></I18nProvider>,document.getElementById("root")!)
    Object.assign(window,{markdownFixture:{setText,setStreaming,beginStream(text:string){batch(()=>{setIdentity(value=>value+1);setText(text);setStreaming(true)})},copies,code,opened}, async paragraphRanges(text:string){const parser=createMarkdownParser();try{return (await parseMarkdownDocument(parser,text)).blocks.map(block=>block.source)}finally{parser.dispose()}}, async runStreamProbe(){
      const root=document.createElement("div")
      root.dataset.component="markdown";root.style.cssText="position:fixed;top:0;width:300px"
      document.body.append(root)
      const controller=createMarkdownStreamController(root)
      let text="prefix ".repeat(2000)
      controller.update(text)
      const first=root.querySelector("p")!.firstChild as Text
      const caret=document.createRange();caret.setStart(first,12);caret.collapse(true)
      document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(caret)
      for(const suffix of ["e","́","👩","‍","🔬","🇨","🇳",...Array(2000).fill("x")]) {text+=suffix;controller.update(text)}
      const pending=root.querySelectorAll('[data-stream-arrival]').length
      controller.end()
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT)
      const nodes:Text[]=[];while(walker.nextNode())nodes.push(walker.currentNode as Text)
      const result={pending,nodes:nodes.length,text:root.textContent===text,caret:document.getSelection()!.anchorOffset,source:controller.sourceAt(nodes[0],text.indexOf("👩")),expected:text.indexOf("👩"),graphemes:["é","👩‍🔬","🇨🇳"].every(cluster=>root.textContent!.includes(cluster))}
      document.getSelection()!.removeAllRanges();root.remove()
      return result
    }, async compareLayoutCache(change:string){
      const parser=createMarkdownParser()
      const document=await parseMarkdownDocument(parser,Array.from({length:80},(_,index)=>"\\n\\n\u0060\u0060\u0060txt\\n"+("cache-row-"+index+": "+"wide text ".repeat(14)+"\\n").repeat(10)+"\u0060\u0060\u0060\\n").join(""))
      const hosts=[]
      const mount=(width:number, cache?, changed=false)=>{
        const scroller=window.document.createElement("div")
        scroller.style.cssText="position:fixed;top:0;left:0;height:280px;overflow:auto;width:"+width+"px"
        const root=window.document.createElement("div")
        root.dataset.component="markdown"
        root.style.setProperty("--font-family-mono",changed&&change==="mono"?"serif":"monospace")
        root.style.setProperty("--font-size-small",changed&&change==="code size"?"22px":"14px")
        scroller.append(root);window.document.body.append(scroller);hosts.push(scroller)
        let saved
        const dispose=render(()=><MarkdownDocumentView root={root} document={document} cache={cache} cacheUpdated={value=>saved=value} enhance={()=>()=>{}}/>,root)
        return {root,dispose,cache:()=>saved}
      }
      const wide=mount(720)
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
      wide.dispose()
      const cache=wide.cache()
      const width=change==="width"?420:720
      const reused=mount(width,cache,true),fresh=mount(width,undefined,true)
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
      const layout=(root:HTMLElement)=>({height:root.getBoundingClientRect().height,blocks:[...root.querySelectorAll<HTMLElement>("[data-markdown-block]")].map(block=>({index:block.dataset.markdownBlock,top:block.getBoundingClientRect().top-root.getBoundingClientRect().top,height:block.getBoundingClientRect().height}))})
      const result={cached:!!cache,reused:layout(reused.root),fresh:layout(fresh.root)}
      reused.dispose();fresh.dispose();for(const host of hosts)host.remove();parser.dispose()
      return result
    }, async mountColdVerticalOwner(){
      const parser=createMarkdownParser()
      const parsed=await parseMarkdownDocument(parser,Array.from({length:1000},(_,index)=>"Cold owner paragraph "+index+". "+"Reading stays in this viewport. ".repeat(4)+"\\n\\n").join(""))
      const scroller=document.createElement("div")
      scroller.id="cold-scroller";scroller.dataset.scrollViewport="vertical"
      scroller.style.cssText="position:fixed;top:0;left:0;height:280px;overflow:auto;width:480px"
      const horizontal=document.createElement("div")
      horizontal.style.overflowX="auto"
      const root=document.createElement("div")
      root.dataset.component="markdown"
      horizontal.append(root);scroller.append(horizontal);document.body.append(scroller)
      const initial={scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight}
      const dispose=render(()=><MarkdownDocumentView root={root} document={parsed} cacheUpdated={()=>{}} enhance={()=>()=>{}}/>,root)
      Object.assign(window,{coldOwner:{scroller,root,dispose:()=>{dispose();scroller.remove();parser.dispose()}}})
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
      return {...initial,count:root.querySelectorAll("[data-markdown-block]").length}
    }, async stationaryScroll(entry:string, windowed:boolean){
      const host=document.createElement("div")
      host.style.cssText="position:absolute;top:0;left:0;width:300px;height:200px"
      document.body.append(host)
      window.scrollTo(0,0)
      const Component=windowed?(entry==="index.jsx"?JsxWindowVirtualizer:MjsWindowVirtualizer):(entry==="index.jsx"?JsxVList:MjsVList)
      const offsets:number[]=[]
      let handle
      const dispose=render(()=><Component ref={value=>handle=value} data={[24]} itemSize={24} onScroll={()=>offsets.push(windowed?window.scrollY:host.firstElementChild.scrollTop)}>{height=><div style={{height:height+"px"}}>Short reading window</div>}</Component>,host)
      try {
        await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
        handle.restoreToIndex(0,0)
        const viewport=windowed?window:host.firstElementChild as HTMLElement
        const before=offsets.length
        if(windowed)window.scrollTo(0,1)
        else viewport.scrollTop=1
        viewport.dispatchEvent(new Event("scroll"))
        return {before,after:offsets.length,offset:offsets.at(-1),pointer:getComputedStyle(host.querySelector("div div")!).pointerEvents}
      } finally {dispose();host.remove()}
    }, async mountMeasured(entry:string, sizes:number[], windowed:boolean){
      const scroller=document.createElement("div")
      scroller.style.cssText=windowed?"position:absolute;top:137px;left:0;width:300px":"position:fixed;top:0;left:0;width:300px;height:200px;overflow:auto"
      const values=Array.from({length:320},(_,index)=>37+index%11)
      const spacer=document.createElement("div")
      spacer.style.height=values.reduce((sum,size)=>sum+size,0)+"px"
      const host=document.createElement("div")
      host.append(spacer)
      scroller.append(host)
      document.body.append(scroller)
      const offset=values.slice(0,100).reduce((sum,size)=>sum+size,0)
      if(windowed)window.scrollTo(0,137+offset)
      else scroller.scrollTop=offset
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
      const Component=windowed?(entry==="index.jsx"?JsxWindowVirtualizer:MjsWindowVirtualizer):(entry==="index.jsx"?JsxVirtualizer:MjsVirtualizer)
      host.style.minHeight=spacer.style.height
      spacer.remove()
      let handle
      const [increase,setIncrease]=createSignal(0)
      const dispose=render(()=><Component ref={value=>handle=value} data={values} initialSizes={sizes} scrollRef={windowed?undefined:scroller}>{(height,index)=><div data-probe-row={index()} style={{height:height+increase()+"px"}}>Row {index()}</div>}</Component>,host)
      host.style.minHeight=""
      return {scroller,handle,setIncrease,dispose:()=>{dispose();scroller.remove();if(windowed)window.scrollTo(0,0)}}
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="gray"/></svg>',
  )
  server = await createServer({
    configFile: false,
    root: directory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      // Vite maps port 0 to its default: https://github.com/vitejs/vite/blob/v7.1.4/packages/vite/src/node/server/index.ts
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, ".."), path.resolve(import.meta.dir, "../../../node_modules")] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => errors.push(error.message))
  const address = server.httpServer!.address() as { port: number }
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.waitForSelector("[data-markdown-block]", { timeout: 20_000 })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("real worker rendering bounds huge Markdown DOM and preserves full code and trusted math copying", async () => {
  await page.waitForSelector("[data-markdown-block]", { timeout: 20_000 })
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(await page.locator("p").count()).toBeLessThan(100)
  expect(await page.locator('[data-katex-copy="true"]').count()).toBe(1)
  await page.locator('[data-katex-copy="true"]').first().click()
  expect(
    await page.evaluate(
      () => (window as unknown as { markdownFixture: { copies: string[] } }).markdownFixture.copies[0],
    ),
  ).toBe("E=mc^2")
  await page.locator("#scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForSelector('[data-slot="markdown-code-copy-text"]')
  await page.locator('[data-slot="markdown-code-header"] button').last().click()
  expect(
    await page.evaluate(() => {
      const fixture = (window as unknown as { markdownFixture: { copies: string[]; code: string } }).markdownFixture
      return fixture.copies.at(-1) === fixture.code.trimEnd()
    }),
  ).toBe(true)
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(errors).toEqual([])
}, 30_000)

test("a new Markdown version replaces the old worker document without stale blocks", async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.evaluate(() =>
    (window as unknown as { markdownFixture: { setText(text: string): void } }).markdownFixture.setText(
      "New **version**",
    ),
  )
  await page.waitForFunction(
    () => document.querySelector('[data-component="markdown"]')?.textContent === "New version\n",
  )
  expect(await page.locator("[data-markdown-block]").count()).toBe(0)
  expect(errors).toEqual([])
})

test("the lazy worker loads a real TypeScript grammar for normal code", async () => {
  await page.evaluate(() =>
    (window as unknown as { markdownFixture: { setText(text: string): void } }).markdownFixture.setText(
      "```ts\nconst answer: number = 42\n```",
    ),
  )
  await page.waitForSelector("pre.shiki code span[style]")
  expect(await page.locator("pre.shiki code").textContent()).toContain("const answer: number = 42")
  expect(errors).toEqual([])
})

test("virtual Markdown remounts managed links with the same resource opener", async () => {
  await page.evaluate(() => {
    const fixture = (window as unknown as { markdownFixture: { setText: (text: string) => void } }).markdownFixture
    fixture.setText(
      "Start\n\n" + "Long paragraph before resource.\n\n".repeat(2500) + "[Report.pdf](asset://3333333333333333.pdf)",
    )
  })
  await page.waitForSelector("[data-markdown-block]")
  const link = page.getByRole("button", { name: "Report.pdf", exact: true })
  const reachEnd = async () => {
    for (let frame = 0; frame < 20; frame++) {
      await page.locator("#scroller").evaluate(async (element) => {
        element.scrollTop = element.scrollHeight
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      if (await link.isVisible()) return
    }
    await link.waitFor({ timeout: 1000 })
  }
  await reachEnd()
  await link.focus()
  await page.keyboard.press("Enter")
  expect(await page.evaluate<string | undefined>("window.markdownFixture.opened.at(-1)")).toBe(
    "asset://3333333333333333.pdf",
  )
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.locator("#scroller").evaluate((element) => {
    element.scrollTop = 0
  })
  await link.waitFor({ state: "detached" })
  await reachEnd()
  expect(await link.getAttribute("href")).toBeNull()
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(errors).toEqual([])
}, 20000)

test.each(["index.jsx", "index.mjs"].flatMap((entry) => [false, true].map((windowed) => [entry, windowed] as const)))(
  "%s publishes unchanged native offsets without leaving idle (window=%s)",
  async (entry, windowed) => {
    const result = await page.evaluate(
      async ({ entry, windowed }) =>
        (
          window as unknown as {
            stationaryScroll(
              entry: string,
              windowed: boolean,
            ): Promise<{
              before: number
              after: number
              offset: number
              pointer: string
            }>
          }
        ).stationaryScroll(entry, windowed),
      { entry, windowed },
    )
    expect(result.after).toBe(result.before + 1)
    expect(result.offset).toBe(0)
    expect(result.pointer).not.toBe("none")
    expect(errors).toEqual([])
  },
)

test.each(
  ["index.jsx", "index.mjs"].flatMap((entry) =>
    [false, true].flatMap((windowed) => ["wheel", "Space"].map((input) => [entry, windowed, input] as const)),
  ),
)(
  "%s accepts mounted measurements once and releases to native input (window=%s, input=%s)",
  async (entry, windowed, input) => {
    const before = await page.evaluate(
      async ({ entry, windowed }) => {
        const fixture = window as unknown as {
          mountMeasured(
            entry: string,
            sizes: number[],
            windowed: boolean,
          ): Promise<{
            scroller: HTMLElement
            handle: { restoreToIndex(index: number, offset: number): void }
            setIncrease(value: number): void
            dispose(): void
          }>
          activeProbe?: { scroller: HTMLElement; dispose(): void }
        }
        const probe = await fixture.mountMeasured(
          entry,
          Array.from({ length: 320 }, (_, index) => 37 + (index % 11)),
          windowed,
        )
        fixture.activeProbe = probe
        probe.setIncrease(20)
        probe.handle.restoreToIndex(100, 7)
        const target = probe.scroller.querySelector<HTMLElement>('[data-probe-row="100"]')!
        const offset = target.getBoundingClientRect().top - (windowed ? 0 : probe.scroller.getBoundingClientRect().top)
        probe.scroller.tabIndex = 0
        probe.scroller.focus({ preventScroll: true })
        return {
          offset,
          pointer: getComputedStyle(target).pointerEvents,
          scroll: windowed ? window.scrollY : probe.scroller.scrollTop,
        }
      },
      { entry, windowed },
    )
    expect(Math.abs(before.offset + 7)).toBeLessThan(2)
    expect(before.pointer).not.toBe("none")
    if (input === "wheel") {
      await page.evaluate(() => {
        const probe = (window as unknown as { activeProbe: { scroller: HTMLElement } }).activeProbe
        probe.scroller.dataset.inputProbe = "true"
      })
      if (windowed) await page.mouse.move(250, 300)
      else await page.locator('[data-input-probe="true"]').hover()
      await page.mouse.wheel(0, 96)
    } else await page.keyboard.press("Space")
    const frames = await page.evaluate(async (windowed) => {
      const fixture = window as unknown as { activeProbe: { scroller: HTMLElement; dispose(): void } }
      const frames: number[] = []
      await new Promise<void>((resolve) => {
        const sample = () => {
          frames.push(windowed ? window.scrollY : fixture.activeProbe.scroller.scrollTop)
          if (frames.length === 30) resolve()
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      fixture.activeProbe.dispose()
      return frames
    }, windowed)
    expect(frames.at(-1)!).toBeGreaterThan(before.scroll + 20)
    expect(frames.every((value, index) => !index || value >= frames[index - 1] - 2)).toBe(true)
    expect(errors).toEqual([])
  },
  30_000,
)

test.each(["index.jsx", "index.mjs"])(
  "%s restores through content-box measurements unaffected by border and transform",
  async (entry) => {
    const result = await page.evaluate(async (entry) => {
      const fixture = window as unknown as {
        mountMeasured(
          entry: string,
          sizes: number[],
          windowed: boolean,
        ): Promise<{
          scroller: HTMLElement
          handle: { cache: [number[], number]; restoreToIndex(index: number, offset: number): void }
          dispose(): void
        }>
      }
      const probe = await fixture.mountMeasured(
        entry,
        Array.from({ length: 320 }, (_, index) => 37 + (index % 11)),
        false,
      )
      const row = probe.scroller.querySelector<HTMLElement>('[data-probe-row="100"]')!,
        wrapper = row.parentElement!
      wrapper.style.padding = "3.25px 0"
      wrapper.style.border = "1.25px solid transparent"
      wrapper.style.boxSizing = "border-box"
      wrapper.style.transform = "scaleY(1.2)"
      probe.handle.restoreToIndex(100, 0)
      const accepted = probe.handle.cache[0][100]
      const delivered = await new Promise<number>((resolve) => {
        const observer = new ResizeObserver((entries) => {
          observer.disconnect()
          resolve(entries[0].contentRect.height)
        })
        observer.observe(wrapper)
      })
      probe.dispose()
      return { accepted, delivered }
    }, entry)
    expect(Math.abs(result.accepted - result.delivered)).toBeLessThan(0.05)
    expect(errors).toEqual([])
  },
)

test.each([
  ["index.jsx", false],
  ["index.mjs", false],
  ["index.jsx", true],
  ["index.mjs", true],
])("%s accepts existing measurements before paint (window=%s)", async (entry, windowed) => {
  const result = await page.evaluate(
    async ({ entry, windowed }) => {
      const values = Array.from({ length: 320 }, (_, index) => 37 + (index % 11))
      const fixture = window as unknown as {
        mountMeasured(
          entry: string,
          sizes: number[],
          windowed: boolean,
        ): Promise<{ scroller: HTMLElement; dispose(): void }>
      }
      const probe = await fixture.mountMeasured(entry, values, windowed)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const target = probe.scroller.querySelector<HTMLElement>('[data-probe-row="100"]')
      const offset = target
        ? target.getBoundingClientRect().top - (windowed ? 0 : probe.scroller.getBoundingClientRect().top)
        : null
      const count = probe.scroller.querySelectorAll("[data-probe-row]").length
      const diagnostics = {
        offset,
        count,
        pointer: target ? getComputedStyle(target).pointerEvents : null,
        scroll: windowed ? window.scrollY : probe.scroller.scrollTop,
        rows: [...probe.scroller.querySelectorAll("[data-probe-row]")].map((node) =>
          node.getAttribute("data-probe-row"),
        ),
        bounds: probe.scroller.getBoundingClientRect().toJSON(),
      }
      probe.dispose()
      return diagnostics
    },
    { entry, windowed },
  )
  if (process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT)
    await Bun.write(
      process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT + entry + windowed + ".json",
      JSON.stringify(result, null, 2),
    )
  expect(result.offset).not.toBeNull()
  expect(Math.abs(result.offset!)).toBeLessThan(2)
  expect(result.count).toBeLessThan(30)
  expect(result.pointer).not.toBe("none")
})

test.each(["width", "mono", "code size"])(
  "a terminal measurement cache expires when %s changes",
  async (change) => {
    const result = await page.evaluate(
      (change) =>
        (
          window as unknown as {
            compareLayoutCache(change: string): Promise<{ cached: boolean; reused: unknown; fresh: unknown }>
          }
        ).compareLayoutCache(change),
      change,
    )
    expect(result.cached).toBe(true)
    expect(result.reused).toEqual(result.fresh)
    expect(errors).toEqual([])
  },
  30_000,
)

test("real arrival animations retain one settled Text run, Unicode, provenance and caret", async () => {
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        runStreamProbe(): Promise<{
          pending: number
          nodes: number
          text: boolean
          caret: number
          source: number
          expected: number
          graphemes: boolean
        }>
      }
    ).runStreamProbe(),
  )
  expect(result.pending).toBeLessThanOrEqual(32)
  expect(result.nodes).toBe(1)
  expect(result.text).toBe(true)
  expect(result.graphemes).toBe(true)
  expect(result.caret).toBe(12)
  expect(result.source).toBe(result.expected)
  expect(errors).toEqual([])
})

test("a large streamed answer preserves the paragraph being read through terminal virtualization", async () => {
  await page.waitForSelector("[data-markdown-block]")
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement)?.blur()
    const fixture = (window as unknown as { markdownFixture: { beginStream(text: string): void } }).markdownFixture
    fixture.beginStream(
      Array.from(
        { length: 180 },
        (_, index) =>
          `Handoff paragraph ${index}. ${"Settled prose stays readable while the worker prepares its virtual document. ".repeat(6)}\n\n`,
      ).join(""),
    )
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-component="markdown"] p').length >= 180)
  await page
    .locator('[data-component="markdown"] p')
    .filter({ hasText: /^Handoff paragraph 90\./ })
    .scrollIntoViewIfNeeded()
  await page.locator("#scroller").hover()
  await page.mouse.wheel(0, -48)
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  const frames = await page.evaluate(async () => {
    const scroller = document.getElementById("scroller")!
    const root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
    const top = scroller.getBoundingClientRect().top
    const reading = [...root.querySelectorAll<HTMLParagraphElement>("p")].find((paragraph) => {
      const bounds = paragraph.getBoundingClientRect()
      return bounds.bottom > top && bounds.top < top + scroller.clientHeight
    })!
    const target = reading.textContent!.match(/^Handoff paragraph \d+\./)![0]
    const offset = reading.getBoundingClientRect().top - top
    const samples: Array<{ present: boolean; offset: number | null; virtual: boolean }> = []
    const fixture = (window as unknown as { markdownFixture: { setStreaming(value: boolean): void } }).markdownFixture
    fixture.setStreaming(false)
    await new Promise<void>((resolve) => {
      const sample = () => {
        const paragraph = [...root.querySelectorAll<HTMLParagraphElement>("p")].find((node) =>
          node.textContent?.startsWith(target),
        )
        samples.push({
          present: !!root.textContent && root.getBoundingClientRect().height > 0,
          offset: paragraph ? paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null,
          virtual: !!root.querySelector("[data-markdown-block]"),
        })
        if (samples.length >= 90) resolve()
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    return { offset, samples, scrollTop: scroller.scrollTop }
  })
  if (process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT)
    await Bun.write(process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT, JSON.stringify(frames, null, 2))
  expect(frames.samples.some((sample) => sample.virtual)).toBe(true)
  expect(frames.samples.every((sample) => sample.present && sample.offset !== null)).toBe(true)
  expect(
    Math.max(...frames.samples.map((sample) => Math.abs((sample.offset ?? Infinity) - frames.offset))),
  ).toBeLessThan(2)
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(20)
  expect(errors).toEqual([])
}, 20000)

const prose = Array.from(
  { length: 180 },
  (_, index) => `Review paragraph ${index}. ${"Stable reading content. ".repeat(24)}\n\n`,
).join("")
type HandoffCase = {
  name: string
  text: string
  target: string
  image?: boolean
  windowed?: boolean
  narrow?: boolean
  horizontal?: boolean
}
const handoffCases: HandoffCase[] = [
  {
    name: "a code block with leading blank lines",
    text:
      "```txt\n\n\n" +
      Array.from({ length: 1000 }, (_, index) => `code-line-${index}: preserved original content`).join("\n") +
      "\n```",
    target: "code-line-300:",
  },
  {
    name: "a continuation table with its repeated header",
    text:
      "| Heading | Value |\n|---|---|\n" +
      Array.from({ length: 1000 }, (_, index) => `| table-row-${index} | preserved original value |`).join("\n"),
    target: "table-row-45",
  },
  {
    name: "an interior line of a giant paragraph",
    text: "prefix words ".repeat(1600) + "Interior reading target " + "following words ".repeat(4000),
    target: "Interior reading target",
  },
  {
    name: "an image before the first text",
    text: "![Reading image](/image.svg)\n\n" + prose,
    target: "Reading image",
    image: true,
  },
  { name: "window scrolling with a nonzero root margin", text: prose, target: "Review paragraph 80.", windowed: true },
  { name: "narrow resized typography and reduced motion", text: prose, target: "Review paragraph 80.", narrow: true },
  {
    name: "a giant paragraph inside a horizontal overflow ancestor",
    text: "prefix words ".repeat(1600) + "Interior reading target " + "following words ".repeat(4000),
    target: "Interior reading target",
    horizontal: true,
  },
]

test("disjoint selections retain only their own Markdown blocks", async () => {
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.waitForSelector("[data-markdown-block]")
  await page.evaluate(() => {
    document.getElementById("scroller")!.style.cssText = "height:900px;overflow:auto;width:720px"
    ;(window as unknown as { markdownFixture: { setText(text: string): void } }).markdownFixture.setText(
      Array.from(
        { length: 600 },
        (_, index) =>
          `> [Selected quote ${index}](https://example.com) Reading a retained quote.\n\n[Selected paragraph ${index}](https://example.com) Reading a retained paragraph.\n\n`,
      ).join(""),
    )
  })
  await page.getByRole("link", { name: "Selected quote 0", exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll("[data-markdown-block]").length >= 9)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-markdown-block]")].slice(0, 9)
    const ranges = [
      [0, 2],
      [4, 6],
    ].map(([start, end]) => {
      const range = document.createRange()
      range.setStart(rows[start], 0)
      range.setEnd(rows[end], rows[end].childNodes.length)
      return range
    })
    Object.assign(window, { selectedMarkdownBlocks: rows })
    Object.defineProperty(document, "getSelection", {
      configurable: true,
      value: () => ({
        rangeCount: ranges.length,
        getRangeAt: (index: number) => ranges[index],
      }),
    })
    rows[8].querySelector<HTMLElement>("a")!.focus({ preventScroll: true })
    document.dispatchEvent(new Event("selectionchange"))
  })
  try {
    await page.locator("#scroller").evaluate((element) => (element.style.height = "280px"))
    await page.locator("#scroller").hover()
    await page.mouse.wheel(0, 100_000)
    await page.waitForFunction(
      () => !(window as unknown as { selectedMarkdownBlocks: HTMLElement[] }).selectedMarkdownBlocks[3].isConnected,
    )
    expect(
      await page.evaluate(() =>
        (window as unknown as { selectedMarkdownBlocks: HTMLElement[] }).selectedMarkdownBlocks.map(
          (row) => row.isConnected,
        ),
      ),
    ).toEqual([true, true, true, false, true, true, true, false, true])
  } finally {
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "getSelection")
      ;(document.activeElement as HTMLElement)?.blur()
      document.dispatchEvent(new Event("selectionchange"))
    })
  }
}, 30_000)

test("selection and focus postpone terminal adoption until their owner releases", async () => {
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
    ;(document.activeElement as HTMLElement)?.blur()
    const scroller = document.getElementById("scroller")!
    scroller.style.cssText = "height:480px;overflow:auto;width:720px"
    document.getElementById("root")!.style.paddingTop = "37px"
    window.scrollTo(0, 0)
    ;(window as unknown as { markdownFixture: { beginStream(text: string): void } }).markdownFixture.beginStream(
      Array.from(
        { length: 180 },
        (_, index) => `[Focus target ${index}](https://example.com) ${"Reading the settled stream. ".repeat(20)}\n\n`,
      ).join(""),
    )
  })
  const link = page.getByRole("link", { name: "Focus target 80", exact: true })
  await link.scrollIntoViewIfNeeded()
  await page.locator("#scroller").hover()
  await page.mouse.wheel(0, 48)
  const selected = await link.evaluate((element) => {
    ;(element as HTMLElement).focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(element)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    return document.getSelection()!.toString()
  })
  const protectedFrames = await page.evaluate(async () => {
    ;(window as unknown as { markdownFixture: { setStreaming(value: boolean): void } }).markdownFixture.setStreaming(
      false,
    )
    const states: Array<{ selected: string; virtual: boolean }> = []
    await new Promise<void>((resolve) => {
      const sample = () => {
        states.push({
          selected: document.getSelection()!.toString(),
          virtual: !!document.querySelector("[data-markdown-block]"),
        })
        if (states.length === 45) resolve()
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    return states
  })
  expect(protectedFrames.every((frame) => frame.selected === selected && !frame.virtual)).toBe(true)
  await page.evaluate(() => document.getSelection()?.removeAllRanges())
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  expect(await page.locator("[data-markdown-block]").count()).toBe(0)
  expect(await link.evaluate((element) => element === document.activeElement)).toBe(true)
  await link.evaluate((element) => (element as HTMLElement).blur())
  await page.waitForSelector("[data-markdown-block]", { timeout: 20_000 })
  expect(await page.locator("[data-markdown-block]").count()).toBeLessThan(30)
  expect(errors).toEqual([])
}, 30_000)

test.each([false, true].flatMap((windowed) => ["wheel", "Space"].map((input) => [windowed, input] as const)))(
  "pending terminal adoption follows native input (window=%s, input=%s)",
  async (windowed, input) => {
    await page.evaluate(
      ({ windowed, text }) => {
        document.getSelection()?.removeAllRanges()
        ;(document.activeElement as HTMLElement)?.blur()
        const scroller = document.getElementById("scroller")!
        scroller.style.cssText = windowed
          ? "height:auto;overflow:visible;width:720px"
          : "height:480px;overflow:auto;width:720px"
        if (windowed) scroller.removeAttribute("data-scroll-viewport")
        else scroller.dataset.scrollViewport = "vertical"
        scroller.tabIndex = 0
        document.getElementById("root")!.style.paddingTop = "137px"
        window.scrollTo(0, 0)
        ;(window as unknown as { markdownFixture: { beginStream(text: string): void } }).markdownFixture.beginStream(
          text,
        )
      },
      { windowed, text: prose },
    )
    const paragraph = page.getByText(/^Review paragraph 80\./).first()
    await paragraph.scrollIntoViewIfNeeded()
    const prior = await page.evaluate((windowed) => {
      const scroller = document.getElementById("scroller")!
      const paragraph = [...scroller.querySelectorAll("p")].find((node) =>
        node.textContent?.startsWith("Review paragraph 80."),
      )!
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      document.getSelection()!.addRange(range)
      scroller.focus({ preventScroll: true })
      ;(window as unknown as { markdownFixture: { setStreaming(value: boolean): void } }).markdownFixture.setStreaming(
        false,
      )
      return windowed ? window.scrollY : scroller.scrollTop
    }, windowed)
    if (input === "wheel") {
      if (windowed) await page.mouse.move(700, 300)
      else await page.locator("#scroller").hover()
      await page.mouse.wheel(0, 96)
    } else await page.keyboard.press("Space")
    await page.waitForFunction(
      ({ windowed, prior }) =>
        (windowed ? window.scrollY : document.getElementById("scroller")!.scrollTop) > prior + 20,
      { windowed, prior },
    )
    await page.evaluate(async (windowed) => {
      let previous = windowed ? window.scrollY : document.getElementById("scroller")!.scrollTop
      let stable = 0
      await new Promise<void>((resolve, reject) => {
        let frames = 0
        const sample = () => {
          const current = windowed ? window.scrollY : document.getElementById("scroller")!.scrollTop
          stable = current === previous ? stable + 1 : 0
          previous = current
          if (stable === 3) resolve()
          else if (++frames === 60) reject(new Error("native input did not settle"))
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
    }, windowed)
    const result = await page.evaluate(async (windowed) => {
      const scroller = document.getElementById("scroller")!,
        root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
      const viewportTop = windowed ? 0 : scroller.getBoundingClientRect().top
      const reading = [...root.querySelectorAll("p")].find(
        (node) =>
          node.getBoundingClientRect().top >= viewportTop && node.getBoundingClientRect().top < viewportTop + 400,
      )!
      const label = reading.textContent!.match(/^Review paragraph \d+\./)![0]
      const before = reading.getBoundingClientRect().top - viewportTop
      document.getSelection()!.removeAllRanges()
      const frames: Array<number | null> = []
      await new Promise<void>((resolve) => {
        const sample = () => {
          const paragraph = [...root.querySelectorAll("p")].find((node) => node.textContent?.startsWith(label))
          frames.push(
            paragraph
              ? paragraph.getBoundingClientRect().top - (windowed ? 0 : scroller.getBoundingClientRect().top)
              : null,
          )
          if (frames.length === 45) resolve()
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      return { before, frames, count: root.querySelectorAll("[data-markdown-block]").length }
    }, windowed)
    expect(result.frames.every((value) => value !== null)).toBe(true)
    expect(Math.max(...result.frames.map((value) => Math.abs(value! - result.before)))).toBeLessThan(2)
    expect(result.count).toBeGreaterThan(0)
    expect(errors).toEqual([])
  },
  30_000,
)

test.each([
  ["prose", prose, "Review paragraph 80."],
  ["code", handoffCases[0].text, handoffCases[0].target],
] as const)(
  "terminal adoption preserves in-flight native Space for %s against its stream control",
  async (name, text, target) => {
    const run = async (adopt: boolean) => {
      await page.evaluate((text) => {
        document.getSelection()?.removeAllRanges()
        ;(document.activeElement as HTMLElement)?.blur()
        const scroller = document.getElementById("scroller")!
        delete (scroller as unknown as { scrollTop?: number }).scrollTop
        scroller.style.cssText = "height:480px;overflow:auto;width:720px"
        scroller.dataset.scrollViewport = "vertical"
        scroller.tabIndex = 0
        document.getElementById("root")!.style.paddingTop = "137px"
        window.scrollTo(0, 0)
        ;(window as unknown as { markdownFixture: { beginStream(text: string): void } }).markdownFixture.beginStream(
          text,
        )
      }, text)
      await page.getByText(target, { exact: false }).first().waitFor()
      const before = await page.evaluate(
        ({ adopt, target }) => {
          const scroller = document.getElementById("scroller")!,
            root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let range: Range | undefined
          while (walker.nextNode()) {
            const node = walker.currentNode as Text,
              offset = node.data.indexOf(target)
            if (offset < 0) continue
            range = document.createRange()
            range.setStart(node, offset)
            range.setEnd(node, offset + target.length)
            break
          }
          if (!range) throw new Error("native Space reading glyph missing")
          scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 144
          scroller.focus({ preventScroll: true })
          document.getSelection()!.addRange(range)
          if (adopt)
            (
              window as unknown as { markdownFixture: { setStreaming(value: boolean): void } }
            ).markdownFixture.setStreaming(false)
          const receipts: Array<{ before: number; after: number; virtual: boolean }> = []
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
          Object.defineProperty(scroller, "scrollTop", {
            configurable: true,
            get() {
              return descriptor.get!.call(scroller)
            },
            set(value: number) {
              const before = descriptor.get!.call(scroller)
              descriptor.set!.call(scroller, value)
              receipts.push({
                before,
                after: descriptor.get!.call(scroller),
                virtual: !!root.querySelector("[data-markdown-block]"),
              })
            },
          })
          Object.assign(window, { scrollReceipts: receipts })
          return {
            scroll: scroller.scrollTop,
            point: range.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            focused: document.activeElement === scroller,
          }
        },
        { adopt, target },
      )
      expect(before.focused).toBe(true)
      await page.keyboard.press("Space")
      await page.waitForFunction((prior) => document.getElementById("scroller")!.scrollTop > prior + 20, before.scroll)
      const result = await page.evaluate(async (target) => {
        const scroller = document.getElementById("scroller")!,
          root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
        const atRelease = scroller.scrollTop
        document.getSelection()!.removeAllRanges()
        const frames: Array<number | null> = []
        await new Promise<void>((resolve) => {
          const sample = () => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            let point: number | null = null
            while (walker.nextNode()) {
              const node = walker.currentNode as Text,
                offset = node.data.indexOf(target)
              if (offset < 0) continue
              const range = document.createRange()
              range.setStart(node, offset)
              range.setEnd(node, offset + target.length)
              point = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              break
            }
            frames.push(point)
            if (frames.length === 45) resolve()
            else requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        const receipts = (
          window as unknown as { scrollReceipts: Array<{ before: number; after: number; virtual: boolean }> }
        ).scrollReceipts
        delete (scroller as unknown as { scrollTop?: number }).scrollTop
        return { atRelease, frames, receipts, virtual: !!root.querySelector("[data-markdown-block]") }
      }, target)
      return { before, ...result }
    }
    const control = await run(false),
      adopted = await run(true)
    const controlMotion = control.before.point - control.frames.at(-1)!,
      adoptedMotion = adopted.before.point - adopted.frames.at(-1)!
    if (process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT)
      await Bun.write(
        process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT + "native-space-" + name + "-control.json",
        JSON.stringify({ control, adopted, controlMotion, adoptedMotion }, null, 2),
      )
    expect(controlMotion).toBeGreaterThan(350)
    expect(adopted.atRelease - adopted.before.scroll).toBeLessThan(controlMotion - 100)
    expect(adopted.virtual).toBe(true)
    expect(adopted.frames.every((value) => value !== null)).toBe(true)
    expect(adopted.frames.every((value, index) => !index || value! <= adopted.frames[index - 1]! + 2)).toBe(true)
    expect(Math.abs(adoptedMotion - controlMotion)).toBeLessThan(2)
    if (name === "code")
      expect(adopted.receipts.some((receipt) => receipt.virtual && Math.abs(receipt.after - receipt.before) > 10)).toBe(
        true,
      )
    expect(errors).toEqual([])
  },
  30_000,
)

test.each(handoffCases.map((scenario) => [scenario.name, scenario] as const))(
  "terminal handoff preserves %s",
  async (_name, scenario) => {
    await page.emulateMedia({ reducedMotion: scenario.narrow ? "reduce" : "no-preference" })
    await page.evaluate((scenario) => {
      document.getSelection()?.removeAllRanges()
      ;(document.activeElement as HTMLElement)?.blur()
      const scroller = document.getElementById("scroller")!
      scroller.style.overflow = scenario.windowed ? "visible" : "auto"
      if (scenario.windowed) scroller.removeAttribute("data-scroll-viewport")
      else scroller.dataset.scrollViewport = "vertical"
      scroller.style.height = scenario.windowed ? "auto" : "480px"
      scroller.style.width = scenario.narrow ? "420px" : "720px"
      scroller.style.fontSize = scenario.narrow ? "18px" : ""
      document.getElementById("horizontal-host")!.style.overflowX = scenario.horizontal ? "auto" : ""
      document.getElementById("root")!.style.paddingTop = scenario.windowed ? "137px" : "37px"
      window.scrollTo(0, 0)
      ;(window as unknown as { markdownFixture: { beginStream(text: string): void } }).markdownFixture.beginStream(
        scenario.text,
      )
    }, scenario)
    const target = scenario.image
      ? page.getByRole("img", { name: scenario.target, exact: true })
      : page.getByText(scenario.target, { exact: false }).first()
    await target.waitFor({ timeout: 20_000 })
    if (scenario.image)
      await target.evaluate(
        (image) =>
          new Promise<void>((resolve) => {
            if ((image as HTMLImageElement).complete) resolve()
            else image.addEventListener("load", () => resolve(), { once: true })
          }),
      )
    await page.evaluate(({ target, image, windowed }) => {
      const scroller = document.getElementById("scroller")!
      const root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
      const point = () => {
        if (image) return root.querySelector("img")!.getBoundingClientRect().top
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode as Text
          const offset = node.data.indexOf(target)
          if (offset < 0) continue
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + target.length)
          return range.getBoundingClientRect().top
        }
        throw new Error("reading target missing before handoff")
      }
      const delta = point() - (windowed ? 0 : scroller.getBoundingClientRect().top) - 50
      if (windowed) window.scrollBy(0, delta)
      else scroller.scrollTop += delta
    }, scenario)
    if (scenario.windowed) await page.mouse.move(700, 300)
    else await page.locator("#scroller").hover()
    await page.mouse.wheel(0, 48)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    const ranges =
      scenario.target === "Interior reading target"
        ? await page.evaluate(
            async (text) =>
              (
                window as unknown as { paragraphRanges(text: string): Promise<Array<{ start: number; end: number }>> }
              ).paragraphRanges(text),
            scenario.text,
          )
        : undefined
    const result = await page.evaluate(
      async ({ target, image, windowed, horizontal, text, ranges }) => {
        const scroller = document.getElementById("scroller")!
        const root = scroller.querySelector<HTMLElement>('[data-component="markdown"]')!
        const point = () => {
          if (image) return root.querySelector("img")?.getBoundingClientRect().top
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode as Text
            const offset = node.data.indexOf(target)
            if (offset < 0) continue
            const range = document.createRange()
            range.setStart(node, offset)
            range.setEnd(node, offset + target.length)
            return range.getBoundingClientRect().top
          }
        }
        const offset = () => {
          const top = point()
          return top === undefined ? null : top - (windowed ? 0 : scroller.getBoundingClientRect().top)
        }
        let readingSource: number | undefined
        if (ranges) {
          const paragraph = root.querySelector("p")!
          const targetSource = text.indexOf(target)
          const viewportTop = windowed ? 0 : scroller.getBoundingClientRect().top
          for (let source = Math.max(0, targetSource - 200); source <= targetSource; source++) {
            if (/\s/.test(text[source])) continue
            let relative = source
            const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
            let top: number | undefined
            while (walker.nextNode()) {
              const node = walker.currentNode as Text
              if (relative >= node.length) {
                relative -= node.length
                continue
              }
              const range = document.createRange()
              range.setStart(node, relative)
              range.setEnd(node, relative + 1)
              top = range.getBoundingClientRect().top
              break
            }
            if (top !== undefined && top >= viewportTop) {
              readingSource = source
              break
            }
          }
          if (readingSource === undefined) throw new Error("known source reading point missing")
        }
        const readingOffset = () => {
          if (readingSource === undefined) return offset()
          const index = ranges!.findIndex((range) => readingSource! >= range.start && readingSource! < range.end)
          const paragraph =
            root.querySelector<HTMLElement>('[data-markdown-block="' + index + '"] p') ??
            root.querySelector<HTMLElement>("p")
          if (!paragraph) return null
          let relative = root.querySelector("[data-markdown-block]")
            ? readingSource - ranges![index].start
            : readingSource
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode as Text
            if (relative >= node.length) {
              relative -= node.length
              continue
            }
            const range = document.createRange()
            range.setStart(node, relative)
            range.setEnd(node, relative + 1)
            return range.getBoundingClientRect().top - (windowed ? 0 : scroller.getBoundingClientRect().top)
          }
          return null
        }
        const before = readingOffset()
        const frames: Array<number | null> = []
        const targetFrames: Array<number | null> = []
        ;(
          window as unknown as { markdownFixture: { setStreaming(value: boolean): void } }
        ).markdownFixture.setStreaming(false)
        await new Promise<void>((resolve) => {
          const frame = () => {
            frames.push(readingOffset())
            targetFrames.push(offset())
            if (frames.length === (horizontal ? 90 : 45)) resolve()
            else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
        return {
          before,
          frames,
          targetFrames,
          source: readingSource,
          targetHeight: image ? root.querySelector("img")!.getBoundingClientRect().height : 0,
          count: root.querySelectorAll("[data-markdown-block]").length,
          reserved: root.style.minHeight,
        }
      },
      { ...scenario, ranges },
    )
    if (process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT)
      await Bun.write(
        process.env.SYNERGY_BROWSER_MARKDOWN_OUTPUT + scenario.name + ".json",
        JSON.stringify(result, null, 2),
      )
    expect(result.before).not.toBeNull()
    expect(result.frames.every((value) => value !== null)).toBe(true)
    expect(
      result.targetFrames.every(
        (value) => value !== null && (scenario.image ? value + result.targetHeight > 0 : value >= 0) && value < 480,
      ),
    ).toBe(true)
    expect(Math.max(...result.frames.map((value) => Math.abs((value ?? Infinity) - result.before!)))).toBeLessThan(2)
    expect(result.count).toBeGreaterThan(0)
    expect(result.count).toBeLessThan(30)
    expect(result.reserved).toBe("")
    expect(errors).toEqual([])
  },
  30_000,
)

test("an initially empty vertical owner keeps terminal scrolling after its document overflows", async () => {
  const initial = await page.evaluate(() =>
    (
      window as unknown as {
        mountColdVerticalOwner(): Promise<{ scrollHeight: number; clientHeight: number; count: number }>
      }
    ).mountColdVerticalOwner(),
  )
  try {
    expect(initial.scrollHeight).toBe(initial.clientHeight)
    expect(initial.count).toBeLessThan(30)
    await page.locator("#cold-scroller").hover()
    await page.mouse.wheel(0, 2000)
    await page.waitForFunction(() => document.querySelector("#cold-scroller")!.scrollTop > 1000)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await page.locator("#cold-scroller [data-markdown-block]").count()).toBeLessThan(30)
    expect(await page.locator("#cold-scroller").textContent()).not.toContain("Cold owner paragraph 0.")
    expect(errors).toEqual([])
  } finally {
    await page.evaluate(() => (window as unknown as { coldOwner: { dispose(): void } }).coldOwner.dispose())
  }
}, 30_000)
