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
  automatic(value: boolean | undefined): void
  complete(): void
  editSource(): void
  metadata(): void
  running(value: boolean): void
  dismiss(): void
  accept(): Promise<boolean>
  resolve(index: number, candidate?: string | null): void
  reject(index: number): void
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
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    export const [selection,setSelection]=createSignal({features:["digital-twin"]})
    export const [active,setActive]=createSignal(true)
    export const [session,setSession]=createSignal("session")
    export const [scope,setScope]=createSignal("scope")
    export const [connection,setConnection]=createSignal("http://same-server.test")
    export const [model,setModel]=createSignal("model")
    export const [running,setRunning]=createSignal(false)
    export const [config,setConfig]=createStore({digitalTwin:{automatic:true}})
    const listeners=new Map(), requests=[]
    export const events={on(type,handler){const entries=listeners.get(type)||new Set();entries.add(handler);listeners.set(type,entries);return ()=>entries.delete(handler)}}
    export const emit=(type,properties)=>listeners.get(type)?.forEach(handler=>handler({properties}))
    export const sdk={get url(){return connection()},get scopeKey(){return scope()},connected:()=>true,capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false},event:events,client:{
      session:{turnExecution:async ({rootIDs})=>({data:rootIDs.map(rootID=>({rootID,status:"completed"}))})},
      digitalTwin:{predictNextInput:({digitalTwinInput},options)=>new Promise((resolve,reject)=>requests.push({input:digitalTwinInput,signal:options.signal,resolve,reject}))}
    }}
    export const useSDK=()=>sdk
    export const useSync=()=>({data:{config}})
    export const useViewActivity=()=>active
    export const controls={capability:value=>setSelection(value==="unknown"?undefined:{features:value==="selected"?["digital-twin"]:[]}),active:setActive,session:setSession,scope:setScope,connection:setConnection,model:setModel,running:setRunning,
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
    import {createSignal,Show} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {MarkedProvider} from "@ericsanchezok/synergy-ui/context/marked"
    import {Icon} from "@ericsanchezok/synergy-ui/icon"
    import {getSemanticIcon} from "@ericsanchezok/synergy-ui/semantic-icon"
    import {DigitalTwinComposer} from "@/components/digital-twin/composer"
    import {DigitalTwinSettings} from "@/components/digital-twin/settings"
    import {ComposerDocumentController} from "@/components/prompt-input/composer-document"
    import {DefaultComposer} from "@/plugin/default-composer"
    import {ComposerPresentation,bindComposerPresentation} from "@/components/prompt-input/composer-presentation"
    import {sdk,session,model,running,controls,setConfig} from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    const [text,setText]=createSignal(""),[settings,setSettings]=createSignal({automatic:true,model:""})
    const controller=new ComposerDocumentController({read:()=>({sessionId:session(),text:text(),selection:{start:0,end:0},mode:"normal"}),applyEdits:edits=>{for(const edit of edits)setText(value=>value.slice(0,edit.range.start)+edit.text+value.slice(edit.range.end))}})
    window.twinFixture={...controls,composing:value=>controller.setComposing(value),ghost:()=>controller.completion()?.text,dismiss:()=>controller.dismissCompletion(),accept:()=>controller.acceptCompletion()}
    const messages=()=>[{id:"root",sessionID:session(),role:"user",isRoot:true,time:{created:1}},{id:"reply",sessionID:session(),role:"assistant",rootID:"root",time:{created:2,completed:3},finish:"stop"}]
    const [completionRevision,setCompletionRevision]=createSignal(0)
    controller.subscribe(()=>setCompletionRevision(value=>value+1))
    let editor
    const input={readOnly:()=>false,current:()=>({mode:"normal",text:text(),revision:0}),composing:()=>controller.composing(),setComposing:value=>controller.setComposing(value),className:()=>"",dragging:()=>false,primaryAction:()=>"submit",submit:async()=>{},editor:{
      label:()=>"Completion preview",mount:element=>{editor=element;return ()=>{editor=undefined}},beforeInput:()=>{},input:()=>{},paste:async()=>{},keyDown:()=>{},
      placeholder:()=>text()?undefined:"Describe a task",
      completion:()=>{completionRevision();const value=controller.completion();return value?{prefix:"",text:value.text}:undefined}
    },render:part=>part==="toolbar"?<div class="prompt-input-toolbar flex justify-end"><div class="prompt-input-toolbar-actions flex items-center gap-1.5">
      <Show when={sdk.capabilities.has("digital-twin")}><DigitalTwinComposer controller={controller} focusEditor={()=>editor?.focus()} sessionID={session()} messages={messages()} status={{type:running()?"busy":"idle"}} blocked={false} modelKey={model()}/></Show>
      <button type="button" aria-label="Microphone" class="prompt-input-toolbar-icon-button flex items-center justify-center"><Icon name={getSemanticIcon("prompt.voice")} size="small"/></button>
    </div></div>:null}
    bindComposerPresentation(input,{state:new ComposerPresentation(),preview:()=>({text:text(),references:[]})})
    function Contents(){return <>
      <DigitalTwinSettings value={settings()} models={[{providerId:"fixture",providerName:"Fixture",modelId:"large",modelName:"Large"}]} change={value=>{setSettings(value);setConfig("digitalTwin","automatic",value.automatic)}}/>
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
      ...["sdk", "sync", "view-residency"].map((name) => ({
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

test("handled suggestions and suggestions superseded by new work do not return after reload", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    for (const action of ["dismiss", "edit", "accept", "new-work"] as const) {
      await page.goto(fixture.url)
      await page.getByRole("button", { name: "Predict next input", exact: true }).click()
      await page.evaluate(() => window.twinFixture.resolve(0))
      await page.waitForFunction(() => !!window.twinFixture.ghost())
      if (action === "dismiss") await page.evaluate(() => window.twinFixture.dismiss())
      if (action === "edit") await page.getByRole("textbox", { name: "Draft" }).fill("自己的草稿")
      if (action === "accept") expect(await page.evaluate(() => window.twinFixture.accept())).toBe(true)
      if (action === "new-work") await page.evaluate(() => window.twinFixture.running(true))
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

test("prediction feedback expires without input and a retry receives its own reading time", async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(fixture.url)
    const button = page.getByRole("button", { name: "Predict next input", exact: true })
    const status = page.getByRole("status").filter({ hasText: /No clear continuation yet|Prediction unavailable/ })
    const draft = page.getByRole("textbox", { name: "Draft" })
    await button.click()
    await page.clock.install()
    await page.evaluate(() => window.twinFixture.resolve(0, null))
    expect(await status.innerText()).toBe("No clear continuation yet.")
    await page.clock.runFor(3000)
    expect(await status.isVisible()).toBe(true)
    await page.clock.runFor(1100)
    expect(await status.count()).toBe(0)
    expect(await draft.inputValue()).toBe("")
    expect(await button.isEnabled()).toBe(true)

    await button.click()
    await page.evaluate(() => window.twinFixture.reject(1))
    expect(await status.innerText()).toBe("Prediction unavailable. Try again.")
    await page.clock.runFor(3000)
    await button.click()
    expect(await status.count()).toBe(0)
    await page.evaluate(() => window.twinFixture.resolve(2, null))
    await page.clock.runFor(1100)
    expect(await status.innerText()).toBe("No clear continuation yet.")
    await page.clock.runFor(3000)
    expect(await status.count()).toBe(0)

    await button.click()
    await page.evaluate(() => window.twinFixture.resolve(3, null))
    expect(await status.isVisible()).toBe(true)
    await draft.fill("自己的草稿")
    expect(await status.count()).toBe(0)
    expect(await draft.inputValue()).toBe("自己的草稿")
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
