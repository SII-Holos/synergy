import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

type Control = {
  capability(value: "selected" | "absent" | "unknown"): void
  active(value: boolean): void
  session(value: string): void
  model(value: string): void
  composing(value: boolean): void
  complete(): void
  editSource(): void
  resolve(index: number): void
  requests(): boolean[]
  ghost(): string | undefined
}
declare global {
  interface Window {
    twinFixture: Control
  }
}
let directory: string, fixture: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".twin-fixture-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    export const [selection,setSelection]=createSignal({features:["digital-twin"]})
    export const [active,setActive]=createSignal(true)
    export const [session,setSession]=createSignal("session")
    export const [model,setModel]=createSignal("model")
    export const [config,setConfig]=createStore({digitalTwin:{automatic:true}})
    const listeners=new Map(), requests=[]
    export const events={on(type,handler){const entries=listeners.get(type)||new Set();entries.add(handler);listeners.set(type,entries);return ()=>entries.delete(handler)}}
    export const emit=(type,properties)=>listeners.get(type)?.forEach(handler=>handler({properties}))
    export const sdk={url:"http://same-server.test",scopeKey:"scope",connected:()=>true,capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false},event:events,client:{
      session:{turnExecution:async ({rootIDs})=>({data:rootIDs.map(rootID=>({rootID,status:"completed"}))})},
      digitalTwin:{predictNextInput:({digitalTwinInput},options)=>new Promise(resolve=>requests.push({input:digitalTwinInput,signal:options.signal,resolve}))}
    }}
    export const useSDK=()=>sdk
    export const useSync=()=>({data:{config}})
    export const useViewActivity=()=>active
    export const controls={capability:value=>setSelection(value==="unknown"?undefined:{features:value==="selected"?["digital-twin"]:[]}),active:setActive,session:setSession,model:setModel,
      complete:()=>emit("session.root.completed",{sessionID:session(),rootID:"root",assistantID:"reply"}),
      editSource:()=>emit("message.part.summary",{summary:{sessionID:session()}}),
      requests:()=>requests.map(value=>value.signal.aborted),
      resolve:index=>requests[index].resolve({data:{proposalID:"proposal-"+index,candidate:"再检查一下 API 的边界",stamp:requests[index].input.expected}})}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,Show} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {DigitalTwinComposer} from "@/components/digital-twin/composer"
    import {DigitalTwinSettings} from "@/components/digital-twin/settings"
    import {ComposerDocumentController} from "@/components/prompt-input/composer-document"
    import {DefaultComposerEditor} from "@/plugin/default-composer-editor"
    import {sdk,session,model,controls,setConfig} from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    const [text,setText]=createSignal(""),[settings,setSettings]=createSignal({automatic:true,model:""})
    const controller=new ComposerDocumentController({read:()=>({sessionId:session(),text:text(),selection:{start:0,end:0},mode:"normal"}),applyEdits:edits=>{for(const edit of edits)setText(value=>value.slice(0,edit.range.start)+edit.text+value.slice(edit.range.end))}})
    window.twinFixture={...controls,composing:value=>controller.setComposing(value),ghost:()=>controller.completion()?.text}
    const messages=()=>[{id:"root",sessionID:session(),role:"user",isRoot:true,time:{created:1}},{id:"reply",sessionID:session(),role:"assistant",rootID:"root",time:{created:2,completed:3},finish:"stop"}]
    const [completionRevision,setCompletionRevision]=createSignal(0)
    controller.subscribe(()=>setCompletionRevision(value=>value+1))
    let editor
    const input={readOnly:()=>false,current:()=>({mode:"normal"}),setComposing:value=>controller.setComposing(value),editor:{
      label:()=>"Completion preview",mount:element=>{editor=element;return ()=>{editor=undefined}},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{},
      placeholder:()=>text()?undefined:"Describe a task",
      completion:()=>{completionRevision();const value=controller.completion();return value?{prefix:"",text:value.text}:undefined}
    }}
    function Contents(){return <>
      <DigitalTwinSettings value={settings()} models={[{providerId:"fixture",providerName:"Fixture",modelId:"large",modelName:"Large"}]} change={value=>{setSettings(value);setConfig("digitalTwin","automatic",value.automatic)}}/>
      <DefaultComposerEditor context={{input}} onError={error=>{throw error}}/>
      <textarea aria-label="Draft" value={text()} onInput={event=>{setText(event.currentTarget.value);controller.changed()}}/>
      <Show when={sdk.capabilities.has("digital-twin")}><DigitalTwinComposer controller={controller} focusEditor={()=>editor?.focus()} sessionID={session()} messages={messages()} status={{type:"idle"}} blocked={false} modelKey={model()}/></Show>
    </>}
    render(()=><I18nProvider i18n={i18n}><ThemeProvider><Contents/></ThemeProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [
      ...["sdk", "sync", "view-residency"].map((name) => ({
        find: new RegExp("^@/context/" + name + "$"),
        replacement: path.join(directory, "services.ts"),
      })),
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(4000)
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("rendered composer requires a fresh completion event and fences drafts, reconnects and source edits", async () => {
  await page.goto(fixture.url)
  const button = page.getByRole("button", { name: "Predict next input", exact: true })
  await button.waitFor()
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Predict next input"]')?.hasAttribute("disabled"),
  )
  expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([])
  expect(await page.getByText("Describe a task", { exact: true }).count()).toBe(1)
  await page.evaluate(() => window.twinFixture.complete())
  await page.waitForFunction(() => window.twinFixture.requests().length === 1)
  await page.evaluate(() => window.twinFixture.resolve(0))
  await page.waitForFunction(() => !!window.twinFixture.ghost())
  expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("")
  expect(await page.getByText("再检查一下 API 的边界", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByText("Describe a task", { exact: true }).count()).toBe(0)
  await page.evaluate(() => window.twinFixture.complete())
  expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
  await page.getByRole("textbox", { name: "Draft" }).fill("自己的草稿")
  expect(await button.isDisabled()).toBe(true)
  expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
  await page.getByRole("textbox", { name: "Draft" }).fill("")
  await button.click()
  await page.evaluate(() => window.twinFixture.capability("unknown"))
  expect(await button.count()).toBe(0)
  expect((await page.evaluate(() => window.twinFixture.requests()))[1]).toBe(true)
  await page.evaluate(() => {
    window.twinFixture.resolve(1)
    window.twinFixture.capability("absent")
  })
  expect(await button.count()).toBe(0)
  await page.evaluate(() => window.twinFixture.capability("selected"))
  await button.click()
  await page.evaluate(() => window.twinFixture.editSource())
  await page.waitForFunction(() => window.twinFixture.requests()[2])
  await page.evaluate(() => window.twinFixture.resolve(2))
  expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
  await button.click()
  await page.evaluate(() => window.twinFixture.session("another"))
  await page.waitForFunction(() => window.twinFixture.requests()[3])
  await page.evaluate(() => window.twinFixture.resolve(3))
  expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
  await page.evaluate(() => window.twinFixture.composing(true))
  expect(await button.isDisabled()).toBe(true)
  await page.evaluate(() => window.twinFixture.composing(false))
  await button.click()
  await page.evaluate(() => window.twinFixture.model("another-model"))
  await page.waitForFunction(() => window.twinFixture.requests()[4])
  expect(errors).toEqual([])
})

test("the two rendered settings retain manual prediction when automatic prediction is off", async () => {
  await page.goto(fixture.url)
  const toggle = page.getByRole("switch", { name: "Automatic next-input prediction" })
  expect(await toggle.isChecked()).toBe(true)
  const model = page.getByRole("combobox", { name: "Prediction model" })
  expect(await model.inputValue()).toBe("")
  expect(await page.getByRole("switch").count()).toBe(1)
  expect(await page.getByRole("combobox").count()).toBe(1)
  await toggle.focus()
  await toggle.press("Space")
  expect(await toggle.isChecked()).toBe(false)
  await page.evaluate(() => window.twinFixture.complete())
  expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([])
  await page.getByRole("button", { name: "Predict next input", exact: true }).click()
  expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
  expect(
    await page
      .getByRole("textbox", { name: "Completion preview" })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.evaluate(() => window.twinFixture.resolve(0))
  await page.waitForFunction(() => !!window.twinFixture.ghost())
  expect(
    await page
      .getByRole("textbox", { name: "Completion preview" })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.getByRole("button", { name: "Predict next input", exact: true }).click()
  await page.getByRole("textbox", { name: "Draft" }).focus()
  await page.evaluate(() => window.twinFixture.resolve(1))
  await page.waitForFunction(() => !!window.twinFixture.ghost())
  expect(
    await page.getByRole("textbox", { name: "Draft" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await model.selectOption("fixture/large")
  expect(await model.inputValue()).toBe("fixture/large")
  expect(errors).toEqual([])
})
