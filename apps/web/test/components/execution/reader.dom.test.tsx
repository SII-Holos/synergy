import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

let browser: Browser
let page: Page
let server: PreviewServer
let directory: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-reader-fixture-")))
  await symlink(path.resolve(source, "../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const small=new URL(location.href).searchParams.has("small")
    const ndjson=new URL(location.href).searchParams.has("ndjson")
    const mediaType=ndjson?"application/x-ndjson":"application/json"
    const text=ndjson?[{type:"text-delta",text:"Response"},{type:"finish"}].map(line=>JSON.stringify(line)).join("\\n")+"\\n":JSON.stringify({messages:[{role:"user",content:small?"Read README.md":"中文𐐀\\n".repeat(1900000)+"END_NEEDLE"}],temperature:0.1})
    const bytes=new TextEncoder().encode(text)
    const digest=crypto.subtle.digest("SHA-256",bytes).then(hash=>[...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,"0")).join(""))
    const fixture={bytes:bytes.length,copies:0,copiedBytes:0,cancelled:0,sections:0,escaped:0,reads:[] as number[],slow:false,invalid:new URL(location.href).searchParams.has("invalid"),partial:false}
    Object.assign(window,{fixture})
    document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!event.defaultPrevented)fixture.escaped++})
    Object.defineProperty(navigator,"clipboard",{value:{writeText:async(value:string)=>{fixture.copies++;fixture.copiedBytes=new TextEncoder().encode(value).byteLength}}})
    const client=createSynergyClient({baseUrl:"http://fixture.local",fetch:async(request:Request)=>{
      const url=new URL(request.url)
      const version=url.searchParams.get("version")
      const contentVersion="fixture-v1"
      const headers={"content-type":"application/json"}
      if(version&&version!==contentVersion) return Response.json({name:"RangeError"},{status:400})
      if(url.pathname.endsWith("/sections")){fixture.sections++;return Response.json({contentVersion,format:"text",items:[],total:0,nextCursor:null,truncated:false})}
      if(url.pathname.endsWith("/search")){
        const query=url.searchParams.get("query")!
        const index=text.lastIndexOf(query)
        return Response.json({contentVersion,status:"complete",items:index<0?[]:[{offset:new TextEncoder().encode(text.slice(0,index)).byteLength,bytes:query.length,preview:query}],nextCursor:null})
      }
      if(url.pathname.endsWith("/download")){
        let offset=0
        return new Response(new ReadableStream({async pull(controller){
          if(fixture.slow) await new Promise(resolve=>setTimeout(resolve,30))
          if(request.signal.aborted){fixture.cancelled++;controller.close();return}
          if(offset===bytes.length){controller.close();return}
          const end=Math.min(bytes.length,offset+65536);controller.enqueue(bytes.slice(offset,end));offset=end
        },cancel(){fixture.cancelled++}}),{headers:{"content-type":mediaType}})
      }
      const offset=Number(url.searchParams.get("offset")??0),limit=Number(url.searchParams.get("limit")??65536)
      fixture.reads.push(offset)
      if((bytes[offset]&192)===128) return Response.json({name:"RangeError"},{status:400})
      let end=Math.min(bytes.length,offset+limit)
      while(end<bytes.length&&(bytes[end]&192)===128)end--
      return Response.json({contentVersion,sha256:fixture.invalid?"bad":await digest,offset,bytes:bytes.length,text:new TextDecoder("utf-8",{fatal:true}).decode(bytes.slice(offset,end)),nextOffset:end<bytes.length?end:null,status:fixture.partial?"partial":"complete",mediaType}, {headers})
    }})
    export const useSDK=()=>({client})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {EvidenceReader} from ${JSON.stringify(source + "/components/execution/reader.tsx")}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(source + "/components/execution/execution.css")}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><main class="execution-panel" style="height:700px;width:426px"><EvidenceReader sessionID="root" nodeID="tool" field="request" revision={1}/></main></I18nProvider>,document.getElementById("root"))
  `,
  )
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: {
      alias: [
        { find: "@/context/sdk", replacement: path.join(directory, "services.ts") },
        { find: "@", replacement: source },
      ],
    },
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
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solidPlugin from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; await build({... ${JSON.stringify(options)}, plugins:[solidPlugin()]}); process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Execution fixture build failed")
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
  page = await browser.newPage({ viewport: { width: 480, height: 900 } })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
}, 120_000)
afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("saved requests open as a labeled code block with local copy and no representation selection", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?small=1")
  const block = page.getByRole("region", { name: "Saved request", exact: true })
  await block.getByRole("heading", { name: "Saved request", exact: true }).waitFor({ timeout: 3000 })
  expect(await block.locator("code").textContent()).toContain('"messages"')
  expect(await block.locator("code").textContent()).toContain("Read README.md")
  expect(await page.getByRole("button", { name: "Sections", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Raw JSON", exact: true }).count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { fixture: { sections: number } }).fixture.sections)).toBe(0)
  await block.getByRole("button", { name: "Copy complete JSON" }).click()
  await block.getByText("Copied complete content", { exact: true }).waitFor()
  await block.getByRole("button", { name: "Content actions" }).click()
  await page.getByRole("button", { name: "Search this entire content", exact: true }).press("Escape")
  expect(await page.evaluate(() => (window as unknown as { fixture: { escaped: number } }).fixture.escaped)).toBe(0)
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Content actions")
  await block.getByRole("button", { name: "Content actions" }).click()
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download complete content", exact: true }).click(),
  ])
  const saved = await download.path()
  if (!saved) throw new Error("Evidence block did not download")
  expect(await Bun.file(saved).text()).toBe(
    JSON.stringify({ messages: [{ role: "user", content: "Read README.md" }], temperature: 0.1 }),
  )
  await page.goto(server.resolvedUrls!.local[0]!)
})

test("twenty megabytes of Unicode remain searchable and readable without chunk navigation", async () => {
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator(".execution-content-row").first().waitFor()
  expect(
    await page.evaluate(() => Number((window as unknown as { fixture: { bytes: number } }).fixture.bytes)),
  ).toBeGreaterThan(20_000_000)
  await page.getByRole("button", { name: "Content actions" }).click()
  await page.getByRole("button", { name: "Search this entire content" }).click()
  await page.getByRole("textbox", { name: "Search this entire content" }).fill("END_NEEDLE")
  await page.locator(".execution-content-matches").getByRole("button", { name: "END_NEEDLE" }).click()
  await page.locator(".execution-content-row").filter({ hasText: "END_NEEDLE" }).waitFor()
  const viewport = page.locator(".execution-content-viewport > div")
  await viewport.evaluate((element) => {
    element.scrollTop = 1
    element.dispatchEvent(new Event("scroll"))
  })
  await page.waitForFunction(() => (window as unknown as { fixture: { reads: number[] } }).fixture.reads.length > 3)
  expect(errors).toEqual([])
  expect(await page.locator(".execution-content-row").count()).toBeLessThanOrEqual(120)
  expect(await page.getByRole("alert").count()).toBe(0)
})

test("copy uses the entire pinned version, cancellation releases the stream, and invalid checksums never copy", async () => {
  await page.getByRole("button", { name: "Copy complete JSON" }).click()
  await page.getByText("Copied complete content", { exact: true }).waitFor()
  const copied = await page.evaluate(() => {
    const f = (window as unknown as { fixture: { copies: number; copiedBytes: number; bytes: number } }).fixture
    return { copies: f.copies, copiedBytes: f.copiedBytes, bytes: f.bytes }
  })
  expect(copied.copies).toBe(1)
  expect(copied.copiedBytes).toBe(copied.bytes)
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { slow: boolean } }).fixture.slow = true
  })
  await page.getByRole("button", { name: "Copy complete JSON" }).click()
  await page.getByRole("button", { name: "Cancel reading" }).click()
  await page.waitForFunction(() => (window as unknown as { fixture: { cancelled: number } }).fixture.cancelled > 0)
  expect(await page.evaluate(() => (window as unknown as { fixture: { copies: number } }).fixture.copies)).toBe(1)
  await page.goto(page.url() + "?invalid=1")
  await page.locator(".execution-content-row").first().waitFor()
  await page.getByRole("button", { name: "Copy complete JSON" }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate(() => (window as unknown as { fixture: { copies: number } }).fixture.copies)).toBe(0)
}, 30_000)

test("recorded response streams copy their complete JSON lines without parsing them as a single object", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?ndjson=1")
  await page.locator(".execution-content-row").first().waitFor()
  await page.getByRole("button", { name: "Copy complete content", exact: true }).click()
  await page.getByText("Copied complete content", { exact: true }).waitFor({ timeout: 3000 })
  const copied = await page.evaluate(() => {
    const f = (window as unknown as { fixture: { copies: number; copiedBytes: number; bytes: number } }).fixture
    return { copies: f.copies, copiedBytes: f.copiedBytes, bytes: f.bytes }
  })
  expect(copied.copies).toBe(1)
  expect(copied.copiedBytes).toBe(copied.bytes)
  await page.getByRole("button", { name: "Content actions" }).click()
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download complete content", exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toEndWith(".jsonl")
  const saved = await download.path()
  if (!saved) throw new Error("Response stream did not download")
  expect(await Bun.file(saved).text()).toBe('{"type":"text-delta","text":"Response"}\n{"type":"finish"}\n')
  expect(errors).toEqual([])
}, 15_000)
