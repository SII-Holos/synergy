import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let directory: string
let fixture: BrowserFixture
const browsers: Browser[] = []
const styles: Array<{ file: string; css: string }> = []
const root = path.resolve(import.meta.dir, "../../../..")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".focus-presentation-"))
  for (const owner of ["apps/web/src", "packages/ui/src"]) {
    for await (const file of new Bun.Glob("**/*.css").scan(path.join(root, owner))) {
      const source = path.join(owner, file)
      styles.push({ file: source, css: await Bun.file(path.join(root, source)).text() })
    }
  }
  const boot = await Bun.file(path.join(root, "apps/web/index.html")).text()
  for (const match of boot.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
    styles.push({ file: "apps/web/index.html", css: match[1]! })
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {Button} from "@ericsanchezok/synergy-ui/button"
    import {IconButton} from "@ericsanchezok/synergy-ui/icon-button"
    import {TextField} from "@ericsanchezok/synergy-ui/text-field"
    import {Checkbox} from "@ericsanchezok/synergy-ui/checkbox"
    import {Switch} from "@ericsanchezok/synergy-ui/switch"
    import {RadioGroup} from "@ericsanchezok/synergy-ui/radio-group"
    import {MenuField} from "@ericsanchezok/synergy-ui/menu-field"
    import {ResizeHandle} from "@ericsanchezok/synergy-ui/resize-handle"
    import ${JSON.stringify(path.join(root, "apps/web/src/index.css"))}
    import ${JSON.stringify(path.join(root, "apps/web/src/components/sidebar/sidebar.css"))}
    import ${JSON.stringify(path.join(root, "apps/web/src/components/workspace/workbench-surface.css"))}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    function App(){
      const [choice,setChoice]=createSignal("one")
      const [navigation,setNavigation]=createSignal(160),[workbench,setWorkbench]=createSignal(180)
      return <main class="synergy-workbench-canvas" style="padding:24px;display:grid;gap:16px;max-width:720px">
        <button id="start">Start</button>
        <div data-case="separators" style="display:flex;height:120px;min-width:0">
          <div class="sb-root sb-expanded" style={{width:navigation()+"px"}}>
            Navigation
            <ResizeHandle direction="horizontal" aria-label="Resize navigation" size={navigation()} min={100} max={300} onResize={setNavigation}/>
          </div>
          <div style="flex:1;min-width:0">Conversation</div>
          <div class="workbench-surface workbench-surface--side workbench-surface--open" style={{width:workbench()+"px"}}>
            <ResizeHandle direction="horizontal" edge="start" aria-label="Resize workbench" size={workbench()} min={100} max={300} onResize={setWorkbench}/>
            <aside class="workbench-surface-panel">Workbench</aside>
          </div>
        </div>
        <div data-case="native"><button>Native button</button><a href="#target">Link</a><select aria-label="Native select"><option>One</option><option>Two</option></select><textarea aria-label="Native textarea"/><input aria-label="Native date" type="date"/><input aria-label="Native range" type="range"/><details><summary>Details</summary>Body</details></div>
        <div data-case="buttons"><Button variant="primary">Primary</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button><IconButton icon="plus" aria-label="Add"/></div>
        <div data-case="text"><TextField label="Shared input"/><TextField label="Multiline" multiline/><TextField label="Invalid input" validationState="invalid" error="Required"/></div>
        <div data-case="agenda" class="agenda-page-tools"><input aria-label="Search tasks" class="agenda-search"/></div>
        <div data-case="composer"><div class="prompt-input-shell" style="border-width:1px;padding:16px"><div role="textbox" aria-label="Task prompt" contentEditable tabIndex={0}>Draft text</div></div></div>
        <div data-case="workbench" class="workbench-input-surface"><input aria-label="Workbench input"/></div>
        <div data-case="address" class="browser-address-field"><input class="browser-address-input" aria-label="Browser address"/></div>
        <div data-case="library" class="library-search-field"><input aria-label="Library search"/></div>
        <div data-case="choices"><Checkbox>Checkbox</Checkbox><Switch>Switch</Switch><RadioGroup options={["First","Second"]} defaultValue="First"/></div>
        <div data-case="menu"><MenuField ariaLabel="Options" value={choice()} onChange={setChoice} options={[{value:"one",label:"One"},{value:"two",label:"Two"}]}/></div>
        <div data-case="surfaces">
          <div role="dialog" tabIndex={-1} data-focus-surface>Dialog surface</div>
          <div role="tabpanel" tabIndex={0} data-focus-surface>Workspace panel</div>
          <div role="tree" tabIndex={0} data-focus-surface><div role="treeitem" tabIndex={0} data-focus-action>Tree item</div></div>
          <div role="listbox" tabIndex={0} data-focus-surface><div role="option" tabIndex={0} data-focus-action>Option</div></div>
          <div role="grid" tabIndex={0} data-focus-surface><div role="row"><div role="gridcell" tabIndex={0} data-focus-action>Cell</div></div></div>
          <div tabIndex={0} data-focus-surface style="overflow:auto;height:40px"><div style="height:100px">Scrollable execution history</div></div>
          <pre tabIndex={0} data-focus-surface>File preview</pre>
          <canvas tabIndex={0} data-focus-surface aria-label="Canvas"/>
          <div role="button" tabIndex={0} data-focus-action>Custom action</div>
          <div role="tab" tabIndex={0} data-focus-action>Tab</div>
          <div role="menuitem" tabIndex={0} data-focus-action>Menu item</div>
        </div>
      </main>
    }
    render(()=><I18nProvider i18n={i18n}><App/></I18nProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({ root: directory, styled: true })
}, 60_000)

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()))
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function focusPerimeters(page: Page) {
  return page.evaluate((sources) => {
    const violations: string[] = []
    function walk(rules: CSSRuleList, ancestors = "") {
      for (const rule of Array.from(rules)) {
        const selector = ancestors + (rule instanceof CSSStyleRule ? " " + rule.selectorText : "")
        if (
          rule instanceof CSSStyleRule &&
          /(?::focus(?:-visible|-within)?|:-(?:moz-focusring|webkit-focus-ring)|[.\[-](?:focused|data-focus|data-highlighted))/.test(
            selector,
          )
        ) {
          for (const match of rule.style.cssText.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
            const [, property, raw] = match
            if (!/^(outline(?!-offset)|border(?!.*radius)|box-shadow|filter|--tw-(?:ring|shadow))/.test(property!))
              continue
            const value = raw!.replace(/\s*!important$/, "").trim()
            if (/^(none|0(?:px)?|transparent|rgba\(0, 0, 0, 0\))$/.test(value)) continue
            violations.push(`${selector.trim()} { ${property}: ${value} }`)
          }
        }
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules, selector)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
    for (const source of sources) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(source.css.replace(/@import[^;]+;/g, ""))
      walk(sheet.cssRules, source.file)
    }
    return [...new Set(violations)]
  }, styles)
}

async function appearance(page: Page, group: string, includeSurface = false) {
  return page.locator(`[data-case="${group}"]`).evaluate((parent, includeSurface) => {
    return [parent, ...parent.querySelectorAll("*")].flatMap((element) =>
      [null, "::before", "::after"].map((pseudo) => {
        const style = getComputedStyle(element, pseudo)
        return {
          border: [style.borderTop, style.borderRight, style.borderBottom, style.borderLeft],
          outline: style.outlineStyle === "none" || style.outlineWidth === "0px" ? "none" : style.outline,
          shadow: style.boxShadow,
          ...(includeSurface && {
            background: style.background,
            color: style.color,
            opacity: style.opacity,
            filter: style.filter,
          }),
        }
      }),
    )
  }, includeSurface)
}

for (const engine of [chromium]) {
  test(`${engine.name()}: every compiled focus state rejects borders, outlines and glows`, async () => {
    const browser = await engine.launch({ headless: true })
    browsers.push(browser)
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.goto(fixture.url)
    await page.getByRole("button", { name: "Start", exact: true }).waitFor()
    expect(await focusPerimeters(page)).toEqual([])
    for (const declaration of ["outline: 2px solid magenta", "box-shadow: 0 0 0 2px black", "border-color: white"]) {
      const style = await page.addStyleTag({ content: `.future-control:focus-within { ${declaration} }` })
      expect(await focusPerimeters(page)).toEqual([expect.stringContaining(".future-control:focus-within")])
      await style.evaluate((element) => element.parentNode?.removeChild(element))
    }
    await page.close()
  }, 30_000)

  for (const scheme of ["light", "dark"] as const) {
    test(`${engine.name()} ${scheme}: pane separators share one visible hairline without shrinking drag or keyboard targets`, async () => {
      const browser = await engine.launch({ headless: true })
      browsers.push(browser)
      const page = await browser.newPage({ colorScheme: scheme, reducedMotion: "reduce" })
      page.setDefaultTimeout(5000)
      await page.goto(fixture.url)
      await page.locator("#start").waitFor()
      for (const [name, direction] of [
        ["Resize navigation", 1],
        ["Resize workbench", -1],
      ] as const) {
        const handle = page.getByRole("separator", { name, exact: true })
        await handle.hover({ position: { x: 6, y: 40 } })
        await page.waitForFunction(
          (name) => getComputedStyle(document.querySelector(`[aria-label="${name}"]`)!, "::after").opacity === "1",
          name,
        )
        const line = await handle.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const parent = element.parentElement!.getBoundingClientRect()
          const style = getComputedStyle(element, "::after")
          const width = Number.parseFloat(style.width)
          const left = bounds.left + Number.parseFloat(style.left) + new DOMMatrixReadOnly(style.transform).m41
          return {
            width,
            visible: Math.max(0, Math.min(parent.right, left + width) - Math.max(parent.left, left)),
            target: bounds.width,
            color: style.backgroundColor,
          }
        })
        expect(line.width).toBe(1)
        expect(line.visible).toBe(1)
        expect(line.target).toBe(8)
        expect(line.color).not.toBe("rgba(0, 0, 0, 0)")
        const start = Number(await handle.getAttribute("aria-valuenow"))
        const bounds = (await handle.boundingBox())!
        await page.mouse.move(bounds.x + 6, bounds.y + 40)
        await page.mouse.down()
        await page.mouse.move(bounds.x + 30, bounds.y + 40)
        await page.mouse.up()
        expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(start + 24 * direction)
        await page.locator("#start").focus()
        await page.keyboard.press("Tab")
        await handle.focus()
        expect(await handle.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
        await handle.press("ArrowRight")
        expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(start + 32 * direction)
        await handle.press("Home")
        expect(await handle.getAttribute("aria-valuenow")).toBe("100")
        await handle.press("End")
        expect(await handle.getAttribute("aria-valuenow")).toBe("300")
        expect(await handle.evaluate((element) => element.parentElement!.getBoundingClientRect().width)).toBe(300)
        await handle.press("Home")
      }
      await page.close()
    }, 30_000)

    test(`${engine.name()} ${scheme}: structural focus preserves surfaces while actions retain their cue`, async () => {
      const browser = await engine.launch({ headless: true })
      browsers.push(browser)
      const page = await browser.newPage({ colorScheme: scheme, reducedMotion: "reduce" })
      await page.goto(fixture.url)
      await page.locator("#start").waitFor()
      await page.addStyleTag({
        content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
      })
      for (const forcedColors of ["none", "active"] as const) {
        await page.emulateMedia({ forcedColors })
        for (const surface of await page.locator("[data-focus-surface]").all()) {
          await page.locator("#start").focus()
          await page.keyboard.press("Tab")
          const before = await appearance(page, "surfaces", true)
          await surface.focus()
          expect(await surface.evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))).toBe(
            true,
          )
          expect(await appearance(page, "surfaces", true)).toEqual(before)
        }
        for (const action of await page.locator("[data-focus-action]").all()) {
          await page.locator("#start").focus()
          const resting = await action.evaluate((el) => ({
            image: getComputedStyle(el).backgroundImage,
            color: getComputedStyle(el).backgroundColor,
          }))
          await action.focus()
          expect(await action.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
          expect(
            await action.evaluate((el) => ({
              image: getComputedStyle(el).backgroundImage,
              color: getComputedStyle(el).backgroundColor,
            })),
          ).not.toEqual(resting)
        }
      }
      await page.close()
    }, 30_000)

    test(`${engine.name()} ${scheme}: keyboard and pointer focus preserve control perimeters`, async () => {
      const browser = await engine.launch({ headless: true })
      browsers.push(browser)
      const page = await browser.newPage({ colorScheme: scheme, reducedMotion: "reduce" })
      page.setDefaultTimeout(5000)
      await page.goto(fixture.url)
      await page.getByRole("button", { name: "Start", exact: true }).waitFor()
      await page.addStyleTag({
        content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
      })
      for (const group of ["native", "buttons", "text", "agenda", "composer", "choices", "menu"]) {
        const controls = page
          .locator(`[data-case="${group}"]`)
          .locator("button, a, input, select, textarea, summary, [contenteditable]")
        for (const control of await controls.all()) {
          await page.locator("#start").focus()
          await page.keyboard.press("Tab")
          await page.locator("#start").focus()
          const before = await appearance(page, group)
          await control.focus()
          expect(await control.evaluate((element) => element === document.activeElement)).toBe(true)
          expect(await appearance(page, group), `${group}: ${await control.getAttribute("aria-label")}`).toEqual(before)
        }
      }
      for (const name of ["Search tasks", "Task prompt", "Shared input"]) {
        const control = page.getByRole("textbox", { name, exact: true })
        await page.locator("#start").focus()
        await control.hover()
        const group = await control.evaluate((element) => element.closest("[data-case]")!.getAttribute("data-case")!)
        const before = await appearance(page, group)
        await control.click()
        expect(await appearance(page, group), name).toEqual(before)
      }
      await page.mouse.move(0, 0)
      await page.locator("#start").focus()
      await page.keyboard.press("Tab")
      const button = page.getByRole("button", { name: "Secondary", exact: true })
      const background = await button.evaluate((element) => getComputedStyle(element).backgroundImage)
      await button.focus()
      expect(await button.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe(background)
      await page.getByRole("button", { name: "Options" }).focus()
      await page.keyboard.press("Enter")
      await page.getByRole("listbox").getByRole("option", { name: "Two", exact: true }).waitFor()
      await page.keyboard.press("Escape")
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label")?.startsWith("Options:"),
        undefined,
        { timeout: 3000 },
      )
      await page.close()
    }, 30_000)

    test(`${engine.name()} ${scheme}: text fields stay visually unchanged on hover, press and focus`, async () => {
      const browser = await engine.launch({ headless: true })
      browsers.push(browser)
      const page = await browser.newPage({ colorScheme: scheme, reducedMotion: "reduce" })
      page.setDefaultTimeout(5000)
      await page.goto(fixture.url)
      await page.getByRole("button", { name: "Start", exact: true }).waitFor()
      await page.addStyleTag({
        content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
      })
      for (const control of await page.getByRole("textbox").all()) {
        const name = (await control.getAttribute("aria-label")) ?? (await control.getAttribute("id"))
        const group = await control.evaluate((element) => element.closest("[data-case]")!.getAttribute("data-case")!)
        await page.mouse.move(0, 0)
        await page.locator("#start").focus()
        const before = await appearance(page, group, true)
        await control.hover()
        expect(await appearance(page, group, true), `${name}: hover`).toEqual(before)
        await page.mouse.down()
        expect(await appearance(page, group, true), `${name}: press`).toEqual(before)
        await page.mouse.up()
        expect(await control.evaluate((element) => element === document.activeElement)).toBe(true)
        expect(await appearance(page, group, true), `${name}: click`).toEqual(before)
        await page.mouse.move(0, 0)
        await page.locator("#start").focus()
        await page.keyboard.press("Tab")
        await control.focus()
        expect(await appearance(page, group, true), `${name}: keyboard focus`).toEqual(before)
      }
      await page.close()
    }, 30_000)
  }
}
