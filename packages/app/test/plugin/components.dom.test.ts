import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import { openUIFixture } from "../fixtures/plugin-ui5/browser"

let fixture: Awaited<ReturnType<typeof openUIFixture>>
const root = fs.mkdtempSync(path.join(import.meta.dir, "public-components-"))
const project = {
  root,
  writeFile(file: string, content: string) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  },
  cleanup() {
    fs.rmSync(root, { recursive: true, force: true })
  },
}
beforeAll(async () => {
  project.writeFile(
    "package.json",
    JSON.stringify({ name: "public-components", version: "1.0.0", type: "module", source: "src/index.ts" }),
  )
  project.writeFile(
    "src/index.ts",
    `import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "public-components", version: "1.0.0", description: "Public components", contributions: [workbenchPanel({ id: "panel", label: "Panel", surface: "side", cardinality: "singleton", component: { source: "src/panel.tsx" } })] })`,
  )
  project.writeFile(
    "src/panel.tsx",
    `import { createSignal } from "solid-js"
import { Button, Dialog, Popover, Input, Select, Menu } from "@ericsanchezok/synergy-plugin/components"
export default function Panel({ context }) {
  const [selected, setSelected] = createSignal("one")
  const [result, setResult] = createSignal("pending")
  return <><Button id="open" onClick={() => context.overlays.dialog(() => <Dialog title="Plugin settings"><Input value="" onChange={() => {}} label="Name" /><Popover title="Nested choices" trigger={props => <button {...props} id="popover">Choices</button>}><Select label="Mode" value={selected()} onChange={setSelected} options={[{value:"one",label:"One"},{value:"two",label:"Two"}]} /></Popover><Menu label="Actions" items={[{id:"apply",label:"Apply",select:()=>setResult("applied")}]} /><Button id="confirm" onClick={() => context.overlays.confirm({title:"Continue?",message:"Choose"}).then((value) => setResult(String(value)))}>Confirm</Button></Dialog>)}>Settings</Button><output id="result">{result()}</output></>
}`,
  )
  const build = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../../../plugin-kit/src/cli.ts"), "build", project.root],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(build.stderr).text()
  if ((await build.exited) !== 0) throw new Error(output)
  const manifest = await Bun.file(path.join(project.root, "dist/plugin.json")).json()
  const query = new URLSearchParams({ bundle: "/plugin-assets/bundle.js", hash: manifest.artifacts.ui.sha256 })
  fixture = await openUIFixture("components.tsx", `/?${query}`, {
    "/plugin-assets/bundle.js": {
      body: await Bun.file(path.join(project.root, "dist/ui/index.js")).text(),
      type: "text/javascript",
    },
    "/integrity": { type: "text/html", body: '<div id="root"></div><script type="module" src="/module.tsx"></script>' },
    "/plugin-assets/invalid.js": {
      type: "text/javascript",
      body: "globalThis.__invalidPluginExecuted = true; export default null",
    },
  })
  try {
    await fixture.page.waitForSelector("#open", { timeout: 20000 })
  } catch (error) {
    throw new AggregateError([error, ...fixture.errors], "Public component fixture did not mount")
  }
}, 30000)
afterAll(async () => {
  await fixture?.close()
  project.cleanup()
})

test("packed public components share modal context, nested popover ownership and focus", async () => {
  const { page } = fixture
  await page.click("#open")
  await page.getByRole("dialog", { name: "Plugin settings" }).waitFor()
  await page.click("#popover")
  page.setDefaultTimeout(3000)
  await page.getByRole("button", { name: "Mode: One" }).click()
  await page.getByRole("option", { name: "Two" }).click()
  expect(await page.getByRole("button", { name: "Mode: Two" }).count()).toBe(1)
  const owners = await page
    .locator('[data-component="popover-content"]')
    .evaluateAll((nodes) => nodes.map((node) => node.closest("[data-plugin-ui]")?.getAttribute("data-plugin-ui")))
  expect(owners).toEqual(["public-components"])
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Apply" }).click()
  expect(await page.locator("#result").textContent()).toBe("applied")
  await page.click("#confirm")
  await page.getByRole("dialog", { name: "Continue?" }).waitFor()
  await page.keyboard.press("Escape")
  expect(await page.locator("#result").textContent()).toBe("false")
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.id === "open")
  expect(fixture.errors).toEqual([])
  expect(fixture.requests.get("/plugin-assets/bundle.js")).toBe(1)
}, 30000)

test("disposing the owner releases open portals without leaking errors", async () => {
  const { page } = fixture
  await page.click("#open")
  await page.click("#popover")
  await page.locator("#dispose").evaluate((node: HTMLButtonElement) => node.click())
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await page.locator('[data-component="popover-content"]').count()).toBe(0)
  expect(fixture.errors).toEqual([])
})

test("browser integrity rejects modified executable bytes before evaluating the module", async () => {
  const hash = new Bun.CryptoHasher("sha256").update("export default null").digest("hex")
  const { page } = fixture
  await page.goto(new URL(`/integrity?hash=${hash}`, page.url()).href, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#result", { timeout: 5000 })
  await page.waitForFunction(() => document.querySelector("#result")?.textContent !== "pending", undefined, {
    timeout: 5000,
  })
  expect(await page.locator("#result").textContent()).toContain("integrity")
  expect(await page.evaluate(() => Reflect.get(globalThis, "__invalidPluginExecuted"))).toBeUndefined()
  expect(fixture.requests.get("/plugin-assets/invalid.js")).toBe(1)
}, 30000)
