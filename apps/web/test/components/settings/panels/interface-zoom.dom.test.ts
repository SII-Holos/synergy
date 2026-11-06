import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

let directory: string
interface ZoomFixture {
  applied(): number
  commits: number[]
}
let fixture: ZoomFixture

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".zoom-fixture-"))
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { InterfaceZoom } from "../../../../../src/components/settings/panels/interface-zoom"
    const [applied, setApplied] = createSignal(1)
    const commits = []
    globalThis.__zoomFixture = { applied, commits }
    const i18n = setupI18n({ locale: "en", messages: { en: {} } })
    render(() => <I18nProvider i18n={i18n}><InterfaceZoom zoom={applied()} onZoomChange={value => {
      commits.push(value); setApplied(value)
    }} /></I18nProvider>, document.querySelector("#root"))
  `,
  )
  await build({
    configFile: false,
    root: directory,
    logLevel: "silent",
    plugins: [solidPlugin()],
    resolve: { conditions: ["browser"], dedupe: ["solid-js"] },
    build: {
      target: "esnext",
      minify: false,
      outDir: "dist",
      lib: {
        entry: path.join(directory, "main.tsx"),
        formats: ["es"],
        fileName: () => "main.mjs",
      },
    },
  })
  document.body.innerHTML = '<div id="root"></div>'
  await import(path.join(directory, "dist/main.mjs"))
  fixture = (globalThis as typeof globalThis & { __zoomFixture: ZoomFixture }).__zoomFixture
}, 20000)

afterAll(async () => {
  document.body.innerHTML = ""
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("the rendered zoom slider previews locally and applies once on release", () => {
  const slider = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Interface zoom"]')
  expect(slider).not.toBeNull()
  for (const value of [125, 150]) {
    slider!.value = String(value)
    slider!.dispatchEvent(new Event("input", { bubbles: true }))
    expect(document.body.textContent).toContain(`${value}%`)
    expect(fixture.applied()).toBe(1)
    expect(fixture.commits).toEqual([])
  }
  slider!.dispatchEvent(new Event("change", { bubbles: true }))
  expect(fixture.applied()).toBe(1.5)
  expect(fixture.commits).toEqual([1.5])
})
