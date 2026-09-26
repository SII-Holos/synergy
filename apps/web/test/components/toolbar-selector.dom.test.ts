import { afterAll, afterEach, beforeAll, beforeEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

setDefaultTimeout(30000)

let browser: Browser
let page: Page
let server: ViteDevServer
let fixture: string
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".popover-fixture-"))
  const components = path.resolve(import.meta.dir, "../../src/components")
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "locale.ts"),
    'import { useLingui } from "@lingui/solid"; export const useLocale = () => ({i18n:{_: useLingui()._}})',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { createSignal, onMount, onCleanup } from "solid-js"
    import { handleComposerTypingAutofocus } from ${JSON.stringify(`/@fs/${components}/prompt-input/typing-autofocus.ts`)}
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { WorkspaceLocationButton } from ${JSON.stringify(`/@fs/${components}/top-bar/workspace-location-button.tsx`)}
    import { RequestSubmissionNotice } from ${JSON.stringify(`/@fs/${components}/session/request-submission-notice.tsx`)}
    import { PromptAddMenu } from ${JSON.stringify(`/@fs/${components}/prompt-input/add-menu.tsx`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${components}/../index.css`)}
    import { render } from "solid-js/web"
    import { ToolbarSelectorPopover } from ${JSON.stringify(`/@fs/${components}/toolbar-selector.tsx`)}
    import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
    import { SidebarSectionButton } from ${JSON.stringify(`/@fs/${components}/sidebar/sidebar-section-button.tsx`)}
    function Fixture() {
      let input
      onMount(()=>{ const handle=event=>handleComposerTypingAutofocus(event,input,false); document.addEventListener("keydown",handle); onCleanup(()=>document.removeEventListener("keydown",handle)) })
      const [submission, setSubmission] = createSignal({status:"idle"})
      const [retries, setRetries] = createSignal(0)
      const [chosen, setChosen] = createSignal(0)
      const [expanded, setExpanded] = createSignal(false)
      const [selected, setSelected] = createSignal("None")
      const item = (id, label, extra={}) => ({id,label,icon:"plus",onSelect:()=>setSelected(id),...extra})
      return <>
        <button>Before toolbar</button>
        <ToolbarSelectorPopover title="Agent" triggerAs={props => <Tooltip value="Agent">
          <button {...props}>Agent</button></Tooltip>}>
          {close => <button onClick={close}>Choose agent</button>}
        </ToolbarSelectorPopover>
        <button>After toolbar</button>
        <PromptAddMenu sections={[
          {id:"context",label:"Context",items:[item("files","Add files")]},
          {id:"workflow",label:"Workflow",items:[item("light-loop","Light Loop"),item("plan","Plan",{ariaDisabled:true}),item("lattice","Lattice",{disabled:true}),item("boss","Boss")]}
        ]}/>
        <output>{selected()}</output>
        <SidebarSectionButton open={expanded()} onClick={() => setExpanded(!expanded())}>Projects</SidebarSectionButton>
        <div ref={input} contentEditable="true" aria-label="Composer"/>
        <div data-testid="reading-area" style="height:80px">Read content</div>
        <WorkspaceLocationButton project="Demo" location={{state:"bound",path:"/fixture/project",isolated:false}} onChoose={()=>setChosen(value=>value+1)}/>
        <span data-testid="chosen">{chosen()}</span>
        {["pending","error","unknown","settled","idle"].map(status=><button onClick={()=>setSubmission({status,...(["error","unknown"].includes(status)?{error:new Error("Offline")}: {})})}>State {status}</button>)}
        <RequestSubmissionNotice state={submission()} onRetry={()=>setRetries(value=>value+1)}/>
        <span data-testid="retries">{retries()}</span>
      </>
    }
    render(() => <I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><Fixture /></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: fixture,
    plugins: [solidPlugin(), tailwindcss()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(fixture, "locale.ts") },
        { find: "@", replacement: path.resolve(components, "..") },
      ],
    },
    cacheDir: path.join(fixture, ".vite"),
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid", "fuzzysort"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!)
  await page
    .getByRole("button", { name: "Agent", exact: true })
    .waitFor({ timeout: 10000 })
    .catch((error) => {
      throw new Error([...errors, String(error)].join("\n"))
    })
})

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("toolbar has one Tab stop and restores the native trigger after Escape", async () => {
  const trigger = page.getByRole("button", { name: "Agent", exact: true })
  await page.getByRole("button", { name: "Before toolbar" }).focus()
  await page.keyboard.press("Tab")
  expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.keyboard.press("Tab")
  expect(
    await page.getByRole("button", { name: "After toolbar" }).evaluate((el) => el === document.activeElement),
  ).toBe(true)
  for (const key of ["Enter", "Space"]) {
    await trigger.focus()
    await page.keyboard.press(key)
    await page.getByRole("button", { name: "Choose agent" }).waitFor()
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Choose agent" }).waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.textContent === "Agent")
  }
  expect(errors).toEqual([])
})

test("sidebar disclosure supports native Enter and Space and announces its state", async () => {
  const button = page.getByRole("button", { name: "Projects" })
  await button.focus()
  expect(await button.getAttribute("aria-expanded")).toBe("false")
  await page.keyboard.press("Enter")
  expect(await button.getAttribute("aria-expanded")).toBe("true")
  await page.keyboard.press("Space")
  expect(await button.getAttribute("aria-expanded")).toBe("false")
  expect(errors).toEqual([])
})

test("Add menu is continuous while preserving action guards and keyboard dismissal", async () => {
  const trigger = page.getByRole("button", { name: "Add", exact: true })
  await trigger.click()
  const list = page.locator('[data-component="list"]')
  await list.waitFor()
  expect(await list.locator('[data-slot="list-item"]').allTextContents()).toEqual([
    "Add files",
    "Light Loop",
    "Plan",
    "Lattice",
    "Boss",
  ])
  expect(await list.getByText("Context", { exact: true }).count()).toBe(0)
  expect(await list.getByText("Workflow", { exact: true }).count()).toBe(0)
  const gaps = await list
    .locator('[data-slot="list-item"]')
    .evaluateAll((items) =>
      items
        .slice(1)
        .map((item, index) => item.getBoundingClientRect().top - items[index]!.getBoundingClientRect().bottom),
    )
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1)
  for (const name of ["Plan", "Lattice"]) {
    await list.getByText(name, { exact: true }).click()
    expect(await page.locator("output").textContent()).toBe("None")
    expect(await list.isVisible()).toBe(true)
  }
  await list.getByText("Boss", { exact: true }).click()
  expect(await page.locator("output").textContent()).toBe("boss")
  await list.waitFor({ state: "detached" })
  await trigger.press("Enter")
  await list.waitFor()
  await page.keyboard.press("Escape")
  await list.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Add")
  expect(errors).toEqual([])
})

test("typing outside controls focuses the composer while sidebar keys retain their owner", async () => {
  const projects = page.getByRole("button", { name: "Projects", exact: true })
  await projects.focus()
  await page.keyboard.press("Space")
  expect(await projects.getAttribute("aria-expanded")).toBe("true")
  expect(await projects.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(await page.getByLabel("Composer").textContent()).toBe("")
  await page.getByTestId("reading-area").click()
  await page.keyboard.press("x")
  expect(await page.getByLabel("Composer").evaluate((el) => el === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
})

test("working location popover returns keyboard focus and opens its existing chooser", async () => {
  const trigger = page.getByRole("button", { name: "Working location: Demo, Local directory" })
  await trigger.press("Enter")
  await page.getByText("/fixture/project", { exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Working location: Demo, Local directory",
  )
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
  await trigger.click()
  await page.getByRole("button", { name: "Choose Workspace", exact: true }).click()
  expect(await page.getByTestId("chosen").textContent()).toBe("1")
  await page.getByRole("button", { name: "Choose Workspace", exact: true }).waitFor({ state: "detached" })
  expect(await page.getByRole("button", { name: "Choose Workspace", exact: true }).count()).toBe(0)
})

test("submission notices distinguish pending, failed, unknown and settled decisions", async () => {
  await page.getByRole("button", { name: "State pending", exact: true }).click()
  expect(await page.locator('div[role="status"]').textContent()).toContain("Submitting your decision")
  await page.getByRole("button", { name: "State error", exact: true }).click()
  expect(await page.getByRole("alert").textContent()).toContain("Your selection is preserved")
  await page.getByText("Error details", { exact: true }).click()
  expect(await page.getByText("Offline", { exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Retry submission", exact: true }).click()
  expect(await page.getByTestId("retries").textContent()).toBe("1")
  await page.getByRole("button", { name: "State unknown", exact: true }).click()
  await page.getByRole("button", { name: "Check and retry", exact: true }).click()
  expect(await page.getByTestId("retries").textContent()).toBe("2")
  await page.getByRole("button", { name: "State settled", exact: true }).click()
  expect(await page.locator('div[role="status"]').textContent()).toContain("no longer pending")
  await page.getByRole("button", { name: "State idle", exact: true }).click()
  expect(await page.locator('div[role="status"]').count()).toBe(0)
  expect(await page.getByRole("alert").count()).toBe(0)
})
