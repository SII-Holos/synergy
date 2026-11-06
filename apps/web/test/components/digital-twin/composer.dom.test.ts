import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

type Control = {
  capability(value: "selected" | "absent" | "unknown"): void
  active(value: boolean): void
  session(value: string): void
  scope(value: string): void
  connection(value: string): void
  model(value: string): void
  composing(value: boolean): void
  mode(value: "normal" | "shell"): void
  blocked(value: boolean): void
  submission(value: "pending" | "failed" | "accepted" | "queued"): void
  automatic(value: boolean | undefined): void
  complete(): void
  editSource(): void
  metadata(): void
  touch(): void
  running(value: boolean): void
  composer(value: boolean): void
  stored(): unknown[]
  dismiss(): void
  accept(): Promise<boolean>
  resolve(index: number, candidate?: string): void
  reject(index: number): void
  requests(): boolean[]
  ghost(): string | undefined
  prediction(): { busy: boolean; disabled: boolean } | undefined
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
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    import {setupI18n} from "@lingui/core"
    import {withOptimisticMessagePending} from "@/context/session-optimistic-message"
    export const [selection,setSelection]=createSignal({features:["digital-twin"]})
    export const [active,setActive]=createSignal(true)
    export const [session,setSession]=createSignal("session")
    export const [scope,setScope]=createSignal("scope")
    export const [connection,setConnection]=createSignal("http://same-server.test")
    export const [model,setModel]=createSignal("model")
    export const [running,setRunning]=createSignal(false)
    export const [composerShown,setComposerShown]=createSignal(true)
    export const [submission,setSubmission]=createSignal()
    export const [inbox,setInbox]=createStore({})
    export const [config,setConfig]=createStore({digitalTwin:{automatic:true}})
    const listeners=new Map(), requests=[]
    export const events={on(type,handler){const entries=listeners.get(type)||new Set();entries.add(handler);listeners.set(type,entries);return ()=>entries.delete(handler)}}
    export const emit=(type,properties)=>listeners.get(type)?.forEach(handler=>handler({properties}))
    export const sdk={get url(){return connection()},get scopeKey(){return scope()},connected:()=>true,capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false},event:events,client:{
      session:{turnExecution:async ({rootIDs})=>({data:rootIDs.map(rootID=>({rootID,status:"completed"}))})},
      digitalTwin:{predictNextInput:({digitalTwinInput},options)=>new Promise((resolve,reject)=>requests.push({input:digitalTwinInput,signal:options.signal,resolve,reject}))}
    }}
    export const useSDK=()=>sdk
    export const useSync=()=>({data:{config,inbox,session:[{id:session()}]}})
    export const messages=()=>[{id:"root",sessionID:session(),role:"user",isRoot:true,time:{created:1}},{id:"reply",sessionID:session(),role:"assistant",rootID:"root",time:{created:2,completed:3},finish:"stop"},
      ...(submission()&&submission()!=="failed"?[{id:"next",sessionID:session(),role:"user",isRoot:true,time:{created:4},metadata:submission()==="accepted"?undefined:withOptimisticMessagePending(undefined)}]:[])]
    export const useGlobalSDK=()=>({drafts:{hasDraftSession:()=>false}})
    export const useViewActivity=()=>active
    const fixtureI18n=setupI18n({locale:"en",messages:{en:{}}})
    export const useLocale=()=>({i18n:fixtureI18n,fmt:{relative:()=>"now",time:value=>String(value),date:value=>String(value),number:value=>String(value)},controller:{activeLocale:()=>"en",generation:()=>0}})
    export const controls={capability:value=>setSelection(value==="unknown"?undefined:{features:value==="selected"?["digital-twin"]:[]}),active:setActive,session:setSession,scope:setScope,connection:setConnection,model:setModel,running:setRunning,
      composer:setComposerShown,
      submission:value=>{setSubmission(value);setInbox(session(),value==="queued"?[{id:"queued",messageID:"next"}]:[]);setRunning(value!=="failed")},
      stored:()=>Object.keys(localStorage).filter(key=>key.endsWith(":digital-twin")).map(key=>JSON.parse(localStorage.getItem(key))),
      automatic:value=>setConfig("digitalTwin","automatic",value),
      complete:()=>emit("session.root.completed",{sessionID:session(),rootID:"root",assistantID:"reply"}),
      editSource:()=>emit("message.part.summary",{summary:{sessionID:session()}}),
      metadata:()=>{emit("session.updated",{info:{id:session()}});emit("message.updated",{info:{sessionID:session()}})},
      requests:()=>requests.map(value=>value.signal.aborted),
      reject:index=>requests[index].reject(new Error("Fixture prediction failed")),
      resolve:(index,candidate="再检查一下 API 的边界")=>requests[index].resolve({data:{proposalID:"proposal-"+index,candidate,stamp:requests[index].input.expected}})}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createMemo,createSignal,Show} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {MarkedProvider} from "@ericsanchezok/synergy-ui/context/marked"
    import {Icon} from "@ericsanchezok/synergy-ui/icon"
    import {getSemanticIcon} from "@ericsanchezok/synergy-ui/semantic-icon"
    import {DigitalTwinComposer} from "@/components/digital-twin/composer"
    import {DigitalTwinBackground} from "@/components/digital-twin/background"
    import {PromptAddMenu} from "@/components/prompt-input/add-menu"

    import {DigitalTwinSettings} from "@/components/digital-twin/settings"
    import {ComposerDocumentController} from "@/components/prompt-input/composer-document"
    import {DefaultComposer} from "@/plugin/default-composer"
    import {ComposerPresentation,bindComposerPresentation} from "@/components/prompt-input/composer-presentation"
    import {sdk,session,model,running,composerShown,messages,controls,setConfig} from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    const [text,setText]=createSignal(""),[settings,setSettings]=createSignal({automatic:true,model:""})
    const [mode,setMode]=createSignal("normal"),[blocked,setBlocked]=createSignal(false)
    const controller=new ComposerDocumentController({read:()=>({sessionId:session(),text:text(),selection:{start:0,end:0},mode:mode()}),applyEdits:edits=>{for(const edit of edits)setText(value=>value.slice(0,edit.range.start)+edit.text+value.slice(edit.range.end))}})
    const bound=new URLSearchParams(location.search).has("bound")
    const [predictionApi,setPredictionApi]=createSignal()
    const addMenuSections=createMemo(()=>[{id:"prediction",label:"Assist",items:[{id:"predict-next",label:"Predict next input",icon:getSemanticIcon("action.predict"),disabled:!predictionApi()||predictionApi().disabled(),onSelect:()=>predictionApi()?.predict()}]}])
    window.twinFixture={...controls,mode:value=>{setMode(value);controller.changed()},blocked:setBlocked,composing:value=>controller.setComposing(value),touch:()=>controller.changed(),ghost:()=>controller.completion()?.text,dismiss:()=>controller.dismissCompletion(),accept:()=>controller.acceptCompletion(),prediction:()=>{const api=predictionApi();return api?{busy:api.busy(),disabled:api.disabled()}:undefined}}

    const [completionRevision,setCompletionRevision]=createSignal(0)
    controller.subscribe(()=>setCompletionRevision(value=>value+1))
    let editor
    const input={readOnly:()=>false,current:()=>({mode:"normal",text:text(),revision:0}),composing:()=>controller.composing(),setComposing:value=>controller.setComposing(value),className:()=>"",dragging:()=>false,primaryAction:()=>"submit",submit:async()=>{},editor:{
      label:()=>"Completion preview",mount:element=>{editor=element;return ()=>{editor=undefined}},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{},
      placeholder:()=>text()?undefined:"Describe a task",
      completion:()=>{completionRevision();const value=controller.completion();return value?{prefix:"",text:value.text}:undefined}
    },render:part=>part==="toolbar"?(bound?<div class="prompt-input-toolbar"><PromptAddMenu sections={addMenuSections()}/></div>:<div class="prompt-input-toolbar flex justify-end"><div class="prompt-input-toolbar-actions flex items-center gap-1.5">
      <Show when={sdk.capabilities.has("digital-twin")&&composerShown()}><DigitalTwinComposer controller={controller} focusEditor={()=>editor?.focus()} sessionID={session()} messages={messages()} status={{type:running()?"busy":"idle"}} blocked={blocked()} modelKey={model()}/></Show>

      <button type="button" aria-label="Microphone" class="prompt-input-toolbar-icon-button flex items-center justify-center"><Icon name={getSemanticIcon("prompt.voice")} size="small"/></button>
    </div></div>):null}
    bindComposerPresentation(input,{state:new ComposerPresentation(),preview:()=>({text:text(),references:[]})})
    function Contents(){return <>
      <DigitalTwinSettings value={settings()} models={[{providerId:"fixture",providerName:"Fixture",modelId:"large",modelName:"Large"}]} change={value=>{setSettings(value);setConfig("digitalTwin","automatic",value.automatic)}}/>
      <DigitalTwinBackground/>
      <Show when={bound}><DigitalTwinComposer controller={controller} focusEditor={()=>editor?.focus()} sessionID={session()} messages={messages()} status={{type:running()?"busy":"idle"}} blocked={blocked()} modelKey={model()} bind={setPredictionApi}/></Show>

      <DefaultComposer context={{input}}/>
      <textarea aria-label="Draft" value={text()} onInput={event=>{setText(event.currentTarget.value);controller.changed()}}/>
    </>}
    render(()=><I18nProvider i18n={i18n}><ThemeProvider><MarkedProvider><div class="synergy-workbench-canvas"><Contents/></div></MarkedProvider></ThemeProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [
      ...["sdk", "sync", "view-residency", "global-sdk", "locale"].map((name) => ({
        find: new RegExp("^@/context/" + name + "$"),
        replacement: path.join(directory, "services.ts"),
      })),
      { find: "@", replacement: source },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
  expect(errors).toEqual([])
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
  expect(await button.getAttribute("aria-busy")).toBe("true")
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
  expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
  expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
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

test.each([
  { colorScheme: "dark" as const, reducedMotion: "no-preference" as const },
  { colorScheme: "light" as const, reducedMotion: "no-preference" as const },
  { colorScheme: "dark" as const, reducedMotion: "reduce" as const },
])("prediction distinguishes unavailable and pending states: %o", async ({ colorScheme, reducedMotion }) => {
  const page = await browser.newPage({ colorScheme, reducedMotion })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    const draft = page.getByRole("textbox", { name: "Draft" })
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Predict next input"]')?.hasAttribute("disabled"),
    )
    const activeColor = await button.locator("svg").evaluate((element) => getComputedStyle(element).color)
    await draft.fill("自己的草稿")
    expect(await button.isDisabled()).toBe(true)
    const disabledColor = await button.locator("svg").evaluate((element) => getComputedStyle(element).color)
    expect(disabledColor).not.toBe(activeColor)
    const background = await button.evaluate((element) => getComputedStyle(element).backgroundColor)
    await button.hover()
    const hovered = await button.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})))
      return getComputedStyle(element).backgroundColor
    })
    expect(hovered).toBe(background)
    await button.click({ force: true })
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(0)
    await draft.fill("")
    const restingBounds = (await button.boundingBox())!
    await button.click()
    expect(await button.getAttribute("aria-busy")).toBe("true")
    expect(await button.isDisabled()).toBe(true)
    const loadingBounds = (await button.boundingBox())!
    expect(loadingBounds.width).toBe(restingBounds.width)
    expect(loadingBounds.height).toBe(restingBounds.height)
    const animations = await button.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations === Infinity).length,
    )
    if (reducedMotion === "reduce") expect(animations).toBe(0)
    else expect(animations).toBeGreaterThan(0)
    await button.hover()
    expect(await page.getByRole("tooltip").innerText()).toBe("Predicting next input…")
    await button.click({ force: true })
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await button.getAttribute("aria-busy")).toBe("false")
    expect(await button.isEnabled()).toBe(true)
    expect(await button.locator("svg").evaluate((element) => getComputedStyle(element).color)).toBe(activeColor)
    expect(
      await button.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getTiming().iterations === Infinity).length,
      ),
    ).toBe(0)
    await button.click()
    await page.evaluate(() => window.twinFixture.reject(1))
    await page.getByRole("status").getByText("Prediction unavailable. Try again.", { exact: true }).waitFor()
    expect(await button.getAttribute("aria-busy")).toBe("false")
    expect(await button.isEnabled()).toBe(true)
    await button.click()
    await draft.fill("新草稿")
    expect((await page.evaluate(() => window.twinFixture.requests()))[2]).toBe(true)
    expect(await button.getAttribute("aria-busy")).toBe("false")
    expect(await button.isDisabled()).toBe(true)
    expect(await button.locator("svg").evaluate((element) => getComputedStyle(element).color)).toBe(disabledColor)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("a generated suggestion survives background activity, navigation and reload without another request", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    await button.click()
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    await page.clock.install()
    await page.clock.runFor(60_000)
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    await page.evaluate(() => window.twinFixture.active(false))
    await page.evaluate(() => window.twinFixture.active(true))
    await page.evaluate(() => window.twinFixture.metadata())
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    const automatic = page.getByRole("switch", { name: "Automatic next-input prediction" })
    await automatic.focus()
    await automatic.press("Space")
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    await page.evaluate(() => window.twinFixture.session("other"))
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    await page.evaluate(() => window.twinFixture.session("session"))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    await page.evaluate(() => window.twinFixture.scope("other-scope"))
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    await page.evaluate(() => window.twinFixture.scope("scope"))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    await page.evaluate(() => window.twinFixture.connection("http://other-server.test"))
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    await page.evaluate(() => window.twinFixture.connection("http://same-server.test"))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    await page.evaluate(() => window.twinFixture.capability("unknown"))
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    await page.evaluate(() => window.twinFixture.capability("selected"))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
    await page.reload()
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await page.getByText("再检查一下 API 的边界", { exact: true }).isVisible()).toBe(true)
    expect(await page.getByText("Describe a task", { exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(0)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("unsent edits and temporary blockers hide saved suggestions without discarding them", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const draft = page.getByRole("textbox", { name: "Draft" })
    await page.getByRole("button", { name: "Predict next input", exact: true }).click()
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    const saved = await page.evaluate(() => window.twinFixture.stored())
    for (const action of ["edit", "accept", "composition", "blocked", "mode", "running"] as const) {
      if (action === "edit") await draft.fill("自己的草稿")
      if (action === "accept") expect(await page.evaluate(() => window.twinFixture.accept())).toBe(true)
      if (action === "composition") await page.evaluate(() => window.twinFixture.composing(true))
      if (action === "blocked") await page.evaluate(() => window.twinFixture.blocked(true))
      if (action === "mode") await page.evaluate(() => window.twinFixture.mode("shell"))
      if (action === "running") await page.evaluate(() => window.twinFixture.running(true))
      expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
      expect(await page.evaluate(() => window.twinFixture.stored())).toEqual(saved)
      if (action === "edit" || action === "accept") await draft.fill("")
      if (action === "composition") await page.evaluate(() => window.twinFixture.composing(false))
      if (action === "blocked") await page.evaluate(() => window.twinFixture.blocked(false))
      if (action === "mode") await page.evaluate(() => window.twinFixture.mode("normal"))
      if (action === "running") await page.evaluate(() => window.twinFixture.running(false))
      expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    }
    await draft.fill("尚未发出的草稿")
    await page.evaluate(() => window.twinFixture.submission("pending"))
    await draft.fill("")
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    expect(await page.evaluate(() => window.twinFixture.stored())).toEqual(saved)
    await draft.fill("尚未发出的草稿")
    await page.evaluate(() => window.twinFixture.submission("failed"))
    await page.evaluate(() => window.twinFixture.composer(false))
    await page.evaluate(() => window.twinFixture.composer(true))
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
    await draft.fill("")
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
    await draft.fill("刷新前的草稿")
    await page.reload()
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(0)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("dismissed suggestions and suggestions superseded by accepted input do not return after reload", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    for (const action of ["dismiss", "accepted", "queued"] as const) {
      await page.goto(fixture.url)
      await page.getByRole("button", { name: "Predict next input", exact: true }).click()
      await page.evaluate(() => window.twinFixture.resolve(0))
      await page.waitForFunction(() => !!window.twinFixture.ghost())
      if (action === "dismiss") await page.evaluate(() => window.twinFixture.dismiss())
      else await page.evaluate((state) => window.twinFixture.submission(state), action)
      expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
      await page.reload()
      await page.getByRole("button", { name: "Predict next input", exact: true }).waitFor()
      expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()
      expect(await page.getByText("Describe a task", { exact: true }).isVisible()).toBe(true)
      expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(0)
    }
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("prediction feedback stays visible until dismissed, and a draft edit clears it", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    const status = page.getByRole("status").filter({ hasText: "Prediction unavailable" })
    const draft = page.getByRole("textbox", { name: "Draft" })
    await button.click()
    await page.evaluate(() => window.twinFixture.reject(0))
    expect(await status.innerText()).toBe("Prediction unavailable. Try again.")
    // A notice that disappears on a timer is indistinguishable from a button
    // that does nothing, so it now waits for the user.
    await page.clock.install()
    await page.clock.runFor(60_000)
    expect(await status.isVisible()).toBe(true)
    expect(await draft.inputValue()).toBe("")
    expect(await button.isEnabled()).toBe(true)
    await page.getByRole("button", { name: "Dismiss prediction message", exact: true }).click()
    expect(await status.count()).toBe(0)

    await button.click()
    await page.evaluate(() => window.twinFixture.reject(1))
    expect(await status.innerText()).toBe("Prediction unavailable. Try again.")
    await draft.fill("自己的草稿")
    expect(await status.count()).toBe(0)
    expect(await draft.inputValue()).toBe("自己的草稿")
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("a manual prediction survives the caret moving out of the editor", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    await button.waitFor()
    await page.evaluate(() => window.twinFixture.touch())
    await button.click()
    // Every click focuses the editor, which bumps the composer revision. That
    // must not invalidate the request it just started: an answer the server had
    // already produced used to be discarded here, with no suggestion and no
    // failure — the reported symptom.
    await page.evaluate(() => window.twinFixture.touch())
    await page.evaluate(() => window.twinFixture.touch())
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await page.evaluate(() => window.twinFixture.requests())).toHaveLength(1)
    expect(await page.evaluate(() => window.twinFixture.requests()[0])).toBe(false)
    expect(await page.getByText("再检查一下 API 的边界", { exact: true }).isVisible()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("the two rendered settings retain manual prediction when automatic prediction is off", async () => {
  await page.goto(fixture.url)
  const toggle = page.getByRole("switch", { name: "Automatic next-input prediction" })
  expect(await toggle.isChecked()).toBe(true)
  const model = page.getByRole("button", { name: /^Prediction model:/ })
  expect(await model.innerText()).toBe("Follow current Session model")
  expect(await page.getByRole("switch").count()).toBe(1)
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
  await model.focus()
  await model.press("ArrowDown")
  await page.getByRole("option", { name: "Fixture / Large", exact: true }).click()
  expect(await model.innerText()).toBe("Fixture / Large")
  await model.press("ArrowDown")
  expect(await page.getByRole("option", { name: "Fixture / Large", exact: true }).getAttribute("aria-selected")).toBe(
    "true",
  )
  await page.getByRole("listbox", { name: "Prediction model" }).press("Escape")
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Prediction model: Fixture / Large",
  )
  expect(await model.innerText()).toBe("Fixture / Large")
  await model.press("ArrowDown")
  await page.getByRole("option", { name: "Follow current Session model", exact: true }).click()
  expect(await model.innerText()).toBe("Follow current Session model")
  expect(errors).toEqual([])
})

test.each([
  { width: 900, colorScheme: "dark" as const, hasTouch: false },
  { width: 375, colorScheme: "light" as const, hasTouch: false },
  { width: 375, colorScheme: "dark" as const, hasTouch: true },
])(
  "prediction stays beside the microphone without covering editor content: %o",
  async ({ width, colorScheme, hasTouch }) => {
    const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme, hasTouch })
    page.setDefaultTimeout(4000)
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(fixture.url)
      const button = page.getByRole("button", { name: "Predict next input", exact: true })
      await button.waitFor()
      const editor = page.getByRole("textbox", { name: "Completion preview" })
      const expand = page.getByRole("button", { name: "Expand editor", exact: true })
      const microphone = page.getByRole("button", { name: "Microphone", exact: true })
      const actionBounds = (await button.boundingBox())!
      const editorBounds = (await editor.boundingBox())!
      const expandBounds = (await expand.boundingBox())!
      const microphoneBounds = (await microphone.boundingBox())!
      expect(actionBounds.y).toBeGreaterThanOrEqual(editorBounds.y + editorBounds.height)
      expect(actionBounds.x).toBeGreaterThan(editorBounds.x + editorBounds.width / 2)
      expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(microphoneBounds.x)
      expect(
        Math.abs(actionBounds.y + actionBounds.height / 2 - microphoneBounds.y - microphoneBounds.height / 2),
      ).toBeLessThan(1)
      expect(expandBounds.y).toBeLessThan(editorBounds.y + 16)
      const textEnd = await editor.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.right - Number.parseFloat(getComputedStyle(element).paddingInlineEnd)
      })
      expect(textEnd).toBeLessThanOrEqual(expandBounds.x)
      expect(await button.innerText()).toBe("")
      if (hasTouch) {
        expect(actionBounds.width).toBeGreaterThanOrEqual(44)
        expect(actionBounds.height).toBeGreaterThanOrEqual(44)
      }
      const model = page.getByRole("button", { name: /^Prediction model:/ })
      await model.click()
      const menu = page.getByRole("listbox", { name: "Prediction model" })
      await menu.waitFor()
      const menuBounds = (await menu.boundingBox())!
      expect(menuBounds.x).toBeGreaterThanOrEqual(0)
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width)
      await menu.press("Escape")
      await button.hover()
      expect(await page.getByRole("tooltip").innerText()).toBe("Predict next input")
      await expand.click()
      expect(errors).toEqual([])
      await page.getByRole("button", { name: "Collapse editor", exact: true }).waitFor({ state: "visible" })
      expect(await button.isVisible()).toBe(true)
      const expandedAction = (await button.boundingBox())!
      const expandedMicrophone = (await microphone.boundingBox())!
      expect(expandedAction.x + expandedAction.width).toBeLessThanOrEqual(expandedMicrophone.x)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  },
)

test("an unconfigured composer predicts only after an explicit request", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    await button.waitFor()
    await page.evaluate(async () => {
      window.twinFixture.automatic(undefined)
      window.twinFixture.complete()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([])
    await button.click()
    await page.waitForFunction(() => window.twinFixture.requests().length === 1)
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
  } finally {
    await page.close()
  }
})

test("automatic prediction still runs for a Session the user is not viewing", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    await button.waitFor()
    // Leaving a Session unmounts its composer, so nothing inside it can notice the
    // turn that finishes while the user is elsewhere. The Scope-level predictor
    // has to cover exactly that turn and leave the suggestion where that composer
    // will read it when it mounts again.
    await page.evaluate(() => window.twinFixture.composer(false))
    expect(await button.count()).toBe(0)
    await page.evaluate(() => window.twinFixture.complete())
    await page.waitForFunction(() => window.twinFixture.requests().length === 1)
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => window.twinFixture.stored().length === 1)
    const [record] = await page.evaluate(() => window.twinFixture.stored())
    expect(record).toMatchObject({
      version: 1,
      suggestion: { rootID: "root", assistantID: "reply", text: "再检查一下 API 的边界" },
    })
    await page.evaluate(() => window.twinFixture.composer(true))
    await page.waitForFunction(() => !!window.twinFixture.ghost())

    expect(await page.getByText("再检查一下 API 的边界", { exact: true }).isVisible()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("a background prediction reaches a composer mounted before its response", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.getByRole("button", { name: "Predict next input", exact: true }).waitFor()
    await page.evaluate(() => {
      window.twinFixture.composer(false)
      window.twinFixture.complete()
    })
    await page.waitForFunction(() => window.twinFixture.requests().length === 1)
    await page.evaluate(() => window.twinFixture.composer(true))
    await page.getByRole("button", { name: "Predict next input", exact: true }).waitFor()
    await page.evaluate(() => window.twinFixture.resolve(0))
    await page.waitForFunction(() => !!window.twinFixture.ghost(), undefined, { timeout: 2000 })
    expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([false])
  } finally {
    await page.close()
  }
})

test.each(["setting", "capability", "connection"] as const)(
  "background prediction rejects obsolete %s results",
  async (change) => {
    const page = await browser.newPage()
    try {
      await page.goto(fixture.url)
      await page.getByRole("button", { name: "Predict next input", exact: true }).waitFor()
      await page.evaluate(() => {
        window.twinFixture.composer(false)
        window.twinFixture.complete()
      })
      await page.waitForFunction(() => window.twinFixture.requests().length === 1)
      await page.evaluate((change) => {
        if (change === "setting") window.twinFixture.automatic(false)
        if (change === "capability") window.twinFixture.capability("unknown")
        if (change === "connection") window.twinFixture.connection("http://another-server.test")
      }, change)
      expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([true])
      await page.evaluate(() => window.twinFixture.resolve(0))
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      expect(await page.evaluate(() => window.twinFixture.stored())).toEqual([])
      if (change === "connection") {
        await page.evaluate(() => window.twinFixture.complete())
        await page.waitForFunction(() => window.twinFixture.requests().length === 2)
        await page.evaluate(() => window.twinFixture.resolve(1))
        await page.waitForFunction(() => window.twinFixture.stored().length === 1)
      }
    } finally {
      await page.close()
    }
  },
)

test("a bound narrow menu keeps prediction busy, failure and success feedback on the page", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url + "?bound")
    const add = page.getByRole("button", { name: "Add", exact: true })
    await add.waitFor()
    // In this layout the add menu is the only prediction entry, so the feedback
    // it triggers has to be visible on the page instead of implied by the item.
    expect(await page.getByRole("button", { name: "Predict next input", exact: true }).count()).toBe(0)
    await page.evaluate(async () => {
      window.twinFixture.automatic(undefined)
      window.twinFixture.complete()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    expect(await page.evaluate(() => window.twinFixture.requests())).toEqual([])
    await page.waitForFunction(() => window.twinFixture.prediction()?.disabled === false)
    expect(await page.locator('[data-slot="twin-prediction-status"]').count()).toBe(0)

    const choosePrediction = async () => {
      await add.click()
      const dialog = page.getByRole("dialog", { name: "Add", exact: true })
      await dialog.waitFor()
      await dialog.getByRole("button", { name: /Predict next input/ }).click()
      await dialog.waitFor({ state: "detached" })
    }

    await choosePrediction()
    await page.waitForFunction(() => window.twinFixture.requests().length === 1)
    expect(await page.locator('[data-slot="twin-prediction-status"]').allInnerTexts()).toEqual([
      "Predicting next input…",
    ])
    expect(await page.evaluate(() => window.twinFixture.prediction()?.busy)).toBe(true)

    await page.evaluate(() => window.twinFixture.reject(0))
    await page.waitForFunction(() => window.twinFixture.prediction()?.busy === false)
    expect(await page.locator('[data-slot="twin-prediction-status"]').allInnerTexts()).toEqual([
      "Prediction unavailable. Try again.",
    ])
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBeUndefined()

    await page.waitForFunction(() => window.twinFixture.prediction()?.disabled === false)
    await choosePrediction()
    await page.waitForFunction(() => window.twinFixture.requests().length === 2)
    expect(await page.locator('[data-slot="twin-prediction-status"]').allInnerTexts()).toEqual([
      "Predicting next input…",
    ])
    await page.evaluate(() => window.twinFixture.resolve(1))
    await page.waitForFunction(() => !!window.twinFixture.ghost())
    expect(await page.evaluate(() => window.twinFixture.ghost())).toBe("再检查一下 API 的边界")
    expect(await page.locator('[data-slot="twin-prediction-status"]').count()).toBe(0)
    expect(await page.getByText("再检查一下 API 的边界", { exact: true }).isVisible()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})
